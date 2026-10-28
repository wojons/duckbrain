"""DuckBrain memory provider for Hermes.

Why this exists: DuckBrain held the fleet's ledger but was reachable only through
MCP tools, so nothing ever recalled it automatically — every session answered
from the injected MEMORY.md and the ledger was write-only in practice
(~/.hermes/config.yaml had no memory provider at all).

This provider makes the ledger an automatic channel:

  * prefetch()      — a bounded recall pack for the upcoming turn
  * on_pre_compress() — the pack survives context compaction instead of being
                        discarded with the transcript
  * system_prompt_block() — one line so the model knows the ledger is live

Design rules, all deliberate:
  * FAIL OPEN. Every network call is bounded and every exception returns "".
    A dead or slow DuckBrain must never block or break a turn.
  * NO WRITES. Durable writes belong to the foreman/cron sync, not to chat
    turns; a per-turn writer is what produced 16k junk namespaces.
  * BOUNDED. The pack is capped at PACK_BUDGET chars with a prefix guarantee,
    mirroring the oh-my-hermes lesson that a pack which spills its cap silently
    loses the middle records.
  * NO NEW TOOLS. The duckbrain MCP server already exposes the tool surface.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

log = logging.getLogger(__name__)

DEFAULT_URL = os.environ.get("DUCKBRAIN_URL", "http://127.0.0.1:3000")
# ---------------------------------------------------------------------------
# Skill index — the same automatic path as recall, on purpose.
# Reason: measured 2026-10-28, 714 tool calls in one session were 92% build and
# 0.7% skill_view. Looking things up only happens if it is not a decision, so
# prefetch surfaces matching skills next to matching records.
# ---------------------------------------------------------------------------
SKILL_ROOTS = [os.path.expanduser("~/coding-hermes-skills"),
               os.path.expanduser("~/.hermes/skills")]
_SKILL_INDEX: List[tuple] = []
_STOP = set(("a an the and or for to of in on with without from by is are was were be been this that "
             "these those it its as at into over under how what why when which who do does did can could "
             "should would will not no yes my your our their his her them us we you i me please just about "
             "using use build make get set new add fix").split())


def _load_skill_index() -> List[tuple]:
    """(name, description, tokens) for every SKILL.md; frontmatter only, read once."""
    out = []
    for root in SKILL_ROOTS:
        try:
            entries = os.listdir(root)
        except Exception:
            continue
        for entry in entries:
            f = os.path.join(root, entry, "SKILL.md")
            if not os.path.isfile(f):
                continue
            try:
                head = open(f, errors="replace").read(2000)
            except Exception:
                continue
            m = re.search(r"^description:\s*(.+)$", head, re.M)
            desc = (m.group(1).strip().strip('"\'') if m else "")
            toks = set(re.findall(r"[a-z0-9]+", (entry + " " + desc).lower()))
            out.append((entry, desc, toks))
    return out


def _match_skills(query: str, limit: int = 3) -> List[str]:
    global _SKILL_INDEX
    if not _SKILL_INDEX:
        try:
            _SKILL_INDEX = _load_skill_index()
        except Exception:
            return []
    q = {w for w in re.findall(r"[a-z0-9]+", (query or "").lower())
         if len(w) > 2 and w not in _STOP}
    if not q:
        return []
    scored = []
    for name, _desc, toks in _SKILL_INDEX:
        hit = len(q & toks)
        if hit:
            bonus = 2 if any(w in name.lower() for w in q) else 0
            scored.append((hit + bonus, name))
    scored.sort(reverse=True)
    seen, out = set(), []
    for _s, name in scored:
        if name in seen:
            continue
        seen.add(name); out.append(name)
        if len(out) >= limit:
            break
    return out


DEFAULT_NAMESPACE = os.environ.get("DUCKBRAIN_NAMESPACE", "hermes-memory")
HTTP_TIMEOUT = float(os.environ.get("DUCKBRAIN_TIMEOUT", "6.0"))
PACK_BUDGET = int(os.environ.get("DUCKBRAIN_PACK_BUDGET", "1200"))
RECORDS = int(os.environ.get("DUCKBRAIN_RECORDS", "6"))
CACHE_TTL = float(os.environ.get("DUCKBRAIN_CACHE_TTL", "90"))


def _find_token() -> Optional[str]:
    """Token discovery: explicit env, then the hermes token, then newest token file."""
    tok = os.environ.get("DUCKBRAIN_TOKEN")
    if tok:
        return tok.strip()
    home = os.path.expanduser("~")
    for name in ("hermes.token", "master.token"):
        p = os.path.join(home, ".duckbrain", name)
        if os.path.exists(p):
            try:
                return open(p).read().strip()
            except OSError:
                pass
    cands = sorted(glob.glob(os.path.join(home, ".duckbrain", "*.token")), key=os.path.getmtime)
    if not cands:
        return None
    try:
        return open(cands[-1]).read().strip()
    except OSError:
        return None


class DuckBrainMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._namespace = DEFAULT_NAMESPACE
        self._session_id = ""
        self._token: Optional[str] = None
        self._cache: Dict[str, tuple] = {}
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._last_pack = ""
        self._last_query = ""
        self._recall_count = 0
        self._fail_count = 0
        self._budget = PACK_BUDGET
        self._records = RECORDS
        self._platform = ""

    # ---- identity -------------------------------------------------------
    @property
    def name(self) -> str:
        return "duckbrain"

    def is_available(self) -> bool:
        """Cheap local check only: token present and the socket answers /health."""
        self._token = self._token or _find_token()
        if not self._token:
            return False
        try:
            req = urllib.request.Request(f"{DEFAULT_URL}/health")
            with urllib.request.urlopen(req, timeout=1.5) as r:
                return r.status == 200
        except Exception:
            return False

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._token = self._token or _find_token()
        self._platform = str(kwargs.get("platform") or "")
        # Lane/cron sessions tick hundreds of times a day: keep their recall pack
        # smaller and cheaper than an interactive chat turn's.
        if self._platform in ("cron", "scheduler"):
            self._budget = int(os.environ.get("DUCKBRAIN_CRON_PACK_BUDGET", "600"))
            self._records = int(os.environ.get("DUCKBRAIN_CRON_RECORDS", "3"))
        else:
            self._budget = PACK_BUDGET
            self._records = RECORDS
        ns = os.environ.get("DUCKBRAIN_NAMESPACE")
        if not ns:
            ns = (kwargs.get("agent_workspace") or "").strip()
        if not ns:
            # A lane works inside its project dir; prefer that project's namespace.
            base = os.path.basename(os.getcwd().rstrip("/"))
            if base and os.path.isdir(os.path.expanduser(f"~/duckbrain/namespaces/{base}")):
                ns = base
        self._namespace = ns or DEFAULT_NAMESPACE
        log.info("duckbrain provider: namespace=%s platform=%s budget=%d session=%s",
                 self._namespace, self._platform or "?", self._budget, session_id[:12])

    # ---- prompt ---------------------------------------------------------
    def system_prompt_block(self) -> str:
        return (
            "DuckBrain ledger is live (namespace: %s). Durable facts, decisions and "
            "open items live there, not only in the in-context memory file. Recall is "
            "automatic each turn; when a claim matters, verify it against the ledger "
            "before asserting it." % self._namespace
        )

    # ---- recall ---------------------------------------------------------
    def _http_json(self, path: str, params: Dict[str, Any]) -> Optional[dict]:
        url = f"{DEFAULT_URL}{path}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"x-api-key": self._token or ""})
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001 - fail open by design
            self._fail_count += 1
            log.debug("duckbrain recall failed: %s", e)
            return None

    def _build_pack(self, query: str) -> str:
        items = []
        if self._token:
            data = self._http_json("/api/memories", {
                "namespace": self._namespace,
                "q": query[:200],
                "limit": getattr(self, "_records", RECORDS),
            })
            if data:
                items = data.get("items") or []
        lines: List[str] = []
        used = 0
        budget = getattr(self, "_budget", PACK_BUDGET)
        for it in items:
            key = str(it.get("key") or "")
            body = " ".join(str(it.get("content") or "").split())
            if not key:
                continue
            line = f"- [{key}] {body[:180]}"
            if used + len(line) > budget:
                break
            lines.append(line)
            used += len(line) + 1
        skills = _match_skills(query)
        if skills:
            skill_line = "- [skills] " + ", ".join(skills)
            if used + len(skill_line) <= budget:
                lines.append(skill_line)
        if not lines:
            return ""
        self._recall_count += 1
        return (
            f"<duckbrain-recall namespace=\"{self._namespace}\" records=\"{len(lines)}\">\n"
            + "\n".join(lines)
            + "\n</duckbrain-recall>"
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return the cached pack for this query; never blocks the turn."""
        key = (query or "")[:200]
        if not key:
            return self._last_pack
        now = time.time()
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[1] < CACHE_TTL:
                self._last_pack = hit[0]
                return hit[0]
        return self._last_pack if self._last_query == key else ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Background recall for the next turn (thread per queued query, joined defensively)."""
        key = (query or "")[:200]
        if not key:
            return
        self._last_query = key

        def work() -> None:
            try:
                pack = self._build_pack(key)
            except Exception:  # noqa: BLE001
                pack = ""
            with self._lock:
                self._cache[key] = (pack, time.time())
                if len(self._cache) > 32:
                    oldest = sorted(self._cache.items(), key=lambda kv: kv[1][1])[:8]
                    for k, _ in oldest:
                        self._cache.pop(k, None)
                self._last_pack = pack or self._last_pack

        self._thread = threading.Thread(target=work, name="duckbrain-prefetch", daemon=True)
        self._thread.start()

    # ---- durability across compaction -----------------------------------
    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Hand the compressor a compact digest so context loss is not total."""
        pack = self._last_pack
        if not pack:
            pack = self._build_pack(self._last_query)
        if not pack:
            return ""
        return (
            "DuckBrain ledger state as of this compression (namespace %s). Preserve this "
            "block verbatim in the summary; it is the durable record, the transcript is not:\n%s"
            % (self._namespace, pack)
        )

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", messages=None) -> None:
        """Deliberately no-op: durable writes belong to the foreman/cron sync."""
        return None

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return []

    def shutdown(self) -> None:
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=1.0)

    # ---- introspection (used by the smoke test and status lines) --------
    def stats(self) -> Dict[str, Any]:
        return {
            "namespace": self._namespace,
            "recalls": self._recall_count,
            "failures": self._fail_count,
            "cache_entries": len(self._cache),
            "last_pack_chars": len(self._last_pack),
        }
