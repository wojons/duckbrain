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
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

log = logging.getLogger(__name__)

DEFAULT_URL = os.environ.get("DUCKBRAIN_URL", "http://127.0.0.1:3000")
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
        ns = os.environ.get("DUCKBRAIN_NAMESPACE")
        if not ns:
            ns = (kwargs.get("agent_workspace") or "").strip()
        self._namespace = ns or DEFAULT_NAMESPACE
        log.info("duckbrain provider: namespace=%s session=%s", self._namespace, session_id[:12])

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
        if not query.strip() or not self._token:
            return ""
        data = self._http_json("/api/memories", {
            "namespace": self._namespace,
            "q": query[:200],
            "limit": RECORDS,
        })
        if not data:
            return ""
        items = data.get("items") or []
        if not items:
            return ""
        lines: List[str] = []
        used = 0
        for it in items:
            key = str(it.get("key") or "")
            body = " ".join(str(it.get("content") or "").split())
            if not key:
                continue
            line = f"- [{key}] {body[:180]}"
            if used + len(line) > PACK_BUDGET:
                break
            lines.append(line)
            used += len(line) + 1
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
