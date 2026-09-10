#!/usr/bin/env python3
"""CHATGAP-001 — independent Telegram capture leg (bot-API mirror).

WHY THIS EXISTS
---------------
The primary capture path reads ~/.hermes/state.db.  If state.db is lost,
corrupted, or truncated, that path yields nothing and the chat is gone.  This
leg is the redundancy: it talks to the Telegram Bot API directly and spools
raw rows to a durable JSONL that does NOT depend on state.db.  The extractor
falls back to that spool, and tgram_capture_health.py alarms when it goes
stale.

TWO OUTPUTS
-----------
  1. SPOOL (always) — append-only JSONL at ~/.hermes/state/tgram-capture-spool.jsonl
     one record per message: {chat_id, slug, date, ts, role, sender, line, update_id, message_id}
     `line` is exactly the upstream contract: "HH:MM Sender: text" (UTC).
  2. ARCHIVE (with --ingest) — DuckBrain chat-archive rows via the duckbrain
     CLI, keyed /chats/<slug>/<date> or /chats/<slug>/<date>/part-N when a
     day's rows exceed the size cap.  This is the same key shape the daily
     cron writer produces, so the mirror is a drop-in second writer.

SAFETY
------
* Default is --dry-run: nothing is fetched and nothing is written.  Pass
  --live to actually poll.
* The leg NEVER consumes updates from the live gateway: it calls getUpdates
  with no `offset`, so Telegram returns only unconfirmed pending updates and
  keeps them queued for the gateway.  `--confirm-offsets` (opt-in) persists
  and advances an offset — use it only when the gateway is down for a DR
  capture, and never concurrently with a live gateway.
* If a webhook is configured, getUpdates is unavailable and the leg aborts
  with a clear message instead of fighting the gateway.

TOKEN RESOLUTION
----------------
Read at runtime, never printed (source label + masked suffix only, at most):
  1. ~/.hermes/config.yaml -> telegram.bot_token | telegram.token | telegram.TELEGRAM_BOT_TOKEN
  2. env TELEGRAM_BOT_TOKEN | TELEGRAM_TOKEN
  3. ~/.hermes/.env  TELEGRAM_BOT_TOKEN=...
--dry-run always reports which source resolved (or a loud failure if none did).

Usage:
  python3 tgram_botapi_mirror.py [--dry-run|--live] [--ingest] [--date YYYY-MM-DD]
                                 [--chat-id ID ...] [--spool FILE] [--repo DIR]
                                 [--namespace NS] [--confirm-offsets] [--verbose]
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
CONFIG_PATH = os.path.join(HOME, ".hermes", "config.yaml")
ENV_FILE = os.path.join(HOME, ".hermes", ".env")
DEFAULT_SPOOL = os.path.join(HOME, ".hermes", "state", "tgram-capture-spool.jsonl")
DEFAULT_STATE = os.path.join(HOME, ".hermes", "state", "tgram-capture-offset.json")
DEFAULT_REPO = os.path.join(HOME, "duckbrain")
DEFAULT_NAMESPACE = "chat-archive"
DEFAULT_OUT_DIR = "/tmp"
# Same contract as daily_chat_extract.py: chat_id -> slug.
KNOWN_THREADS = {
    "-1003310984808": "karahermes-set",
    "8925815583": "karahermes-dm",
}
# Bane's Telegram user id (== the private-chat id), used for sender labelling.
BANE_USER_ID = "8925815583"
MAX_INGEST_CHARS = 70000
LINE_CAP = 600
TOKEN_RE = re.compile(r"^\d{6,12}:[A-Za-z0-9_-]{30,}$")


# --------------------------------------------------------------------------
# token
# --------------------------------------------------------------------------
def _iter_config_values(cfg, path=""):
    if isinstance(cfg, dict):
        for k, v in cfg.items():
            yield from _iter_config_values(v, "%s.%s" % (path, k))
    elif isinstance(cfg, str):
        yield path, cfg


def resolve_bot_token():
    """Return (token, source_label).  Never logs the token value."""
    tg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            import yaml  # type: ignore
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                cfg = yaml.safe_load(fh) or {}
            tg = cfg.get("telegram") or {}
            if isinstance(tg, dict):
                for name in ("bot_token", "token", "TELEGRAM_BOT_TOKEN"):
                    val = tg.get(name)
                    if isinstance(val, str) and TOKEN_RE.match(val.strip()):
                        return val.strip(), "config.yaml:telegram.%s" % name
        except Exception:
            pass

    for name in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_TOKEN", "TG_BOT_TOKEN"):
        val = os.environ.get(name)
        if val and TOKEN_RE.match(val.strip()):
            return val.strip(), "env:%s" % name

    if os.path.exists(ENV_FILE):
        try:
            with open(ENV_FILE, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if "=" not in line or line.lstrip().startswith("#"):
                        continue
                    name, _, raw = line.partition("=")
                    if name.strip() in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_TOKEN", "TG_BOT_TOKEN"):
                        val = raw.strip().strip('"').strip("'")
                        if TOKEN_RE.match(val):
                            return val, "dotenv:TELEGRAM_BOT_TOKEN"
        except OSError:
            pass
    return None, None


def redact(token):
    if not token:
        return "<none>"
    return "…%s (len=%d)" % (token[-4:], len(token))


# --------------------------------------------------------------------------
# telegram api
# --------------------------------------------------------------------------
def tg_call(token, method, params=None, timeout=20):
    url = "https://api.telegram.org/bot%s/%s" % (token, method)
    data = urllib.parse.urlencode(params or {}).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        raise RuntimeError("HTTP %s from %s: %s" % (exc.code, method, detail))
    except Exception as exc:
        raise RuntimeError("%s failed: %s: %s" % (method, type(exc).__name__, exc))
    if not body.get("ok"):
        raise RuntimeError("%s returned not-ok: %s" % (method, body.get("description")))
    return body.get("result")


# --------------------------------------------------------------------------
# shaping
# --------------------------------------------------------------------------
def slug_for(chat_id):
    key = str(chat_id)
    if key in KNOWN_THREADS:
        return KNOWN_THREADS[key]
    return "chat-" + key.replace("-", "m")


def sender_for(msg):
    frm = msg.get("from") or {}
    if frm.get("is_bot"):
        return "KaraHermes"
    if str(frm.get("id")) == BANE_USER_ID:
        return "Bane"
    name = frm.get("first_name") or frm.get("username") or "User"
    return name


def shape_updates(updates, chat_ids, date_filter=None, known_usernames=None):
    """Flatten getUpdates results into the canonical row contract."""
    rows = []
    for upd in updates:
        for field in ("message", "edited_message"):
            msg = upd.get(field)
            if not msg:
                continue
            chat = msg.get("chat") or {}
            chat_id = str(chat.get("id"))
            if chat_ids and chat_id not in chat_ids:
                continue
            ts = msg.get("date") or msg.get("edit_date")
            if ts is None:
                continue
            dt = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
            if date_filter and dt.date().isoformat() != date_filter:
                continue
            text = msg.get("text")
            if text is None:
                text = msg.get("caption") or ""
            if not text:
                continue
            flat = text.replace("\t", " ").replace("\n", " ").strip()
            if len(flat) > LINE_CAP:
                flat = flat[:LINE_CAP] + "…"
            frm = msg.get("from") or {}
            is_bot = bool(frm.get("is_bot"))
            rows.append({
                "chat_id": chat_id,
                "slug": slug_for(chat_id),
                "date": dt.date().isoformat(),
                "ts": ts,
                "role": "assistant" if is_bot else "user",
                "sender": sender_for(msg),
                "line": "%s %s: %s" % (dt.strftime("%H:%M"), sender_for(msg), flat),
                "update_id": upd.get("update_id"),
                "message_id": msg.get("message_id"),
            })
    rows.sort(key=lambda r: (r["ts"], r.get("message_id") or 0))
    return rows


def load_spool_index(spool):
    seen = set()
    if not os.path.exists(spool):
        return seen
    try:
        with open(spool, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except (ValueError, TypeError):
                    continue
                seen.add((str(rec.get("chat_id")), rec.get("message_id")))
    except OSError:
        pass
    return seen


def append_spool(spool, rows):
    os.makedirs(os.path.dirname(spool), exist_ok=True)
    with open(spool, "a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------
# archive ingest
# --------------------------------------------------------------------------
def existing_archive_keys(archive_dir):
    """{slug: {date}} parsed off the chat-archive JSONL (no daemon needed)."""
    found = {}
    msg_dir = os.path.join(archive_dir, "message")
    pat = re.compile(r"^/chats/([^/]+)/(\d{4}-\d{2}-\d{2})")
    if not os.path.isdir(msg_dir):
        return found
    for root, _dirs, files in os.walk(msg_dir):
        for fn in files:
            if not fn.endswith(".jsonl"):
                continue
            try:
                with open(os.path.join(root, fn), "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if '"key"' not in line:
                            continue
                        try:
                            rec = json.loads(line)
                        except (ValueError, TypeError):
                            continue
                        m = pat.match(rec.get("key") or "")
                        if m:
                            found.setdefault(m.group(1), set()).add(m.group(2))
            except OSError:
                continue
    return found


def write_key(repo, namespace, key, domain, content, attrs):
    cli = os.path.join(repo, "bin", "duckbrain.js")
    cmd = [
        "node", cli, "remember", key,
        "--domain=%s" % domain,
        "--namespace=%s" % namespace,
        "--content=%s" % content,
        "--attr=%s" % json.dumps(attrs),
        "--wait",
    ]
    proc = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=300)
    return proc.returncode == 0, (proc.stderr or proc.stdout or "").strip()[-200:]


def ingest_rows(rows, repo, namespace, archive_dir, dry):
    """Group rows per (slug, date) into /chats keys.  Returns (written, skipped, errors)."""
    written, skipped, errors = [], [], []
    by_day = {}
    for r in rows:
        by_day.setdefault((r["slug"], r["date"]), []).append(r)
    present = existing_archive_keys(archive_dir)
    for (slug, date), day_rows in sorted(by_day.items()):
        if date in present.get(slug, set()):
            skipped.append("/chats/%s/%s" % (slug, date))
            continue
        content = "\n".join(r["line"] for r in day_rows)
        chunks = [content] if len(content) <= MAX_INGEST_CHARS else [
            content[i:i + MAX_INGEST_CHARS] for i in range(0, len(content), MAX_INGEST_CHARS)
        ]
        for idx, chunk in enumerate(chunks, 1):
            key = "/chats/%s/%s" % (slug, date)
            if len(chunks) > 1:
                key += "/part-%d" % idx
            attrs = {"date": date, "thread": slug, "source": "botapi-mirror"}
            if dry:
                written.append(key + " (dry-run)")
                continue
            ok, detail = write_key(repo, namespace, key, "message", chunk, attrs)
            (written if ok else errors).append(key if ok else "%s: %s" % (key, detail))
    return written, skipped, errors


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description="CHATGAP-001 independent bot-API capture leg")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", default=True,
                   help="resolve config and print the plan; no fetch, no write (default)")
    g.add_argument("--live", dest="live", action="store_true",
                   help="actually poll the Bot API and write")
    ap.add_argument("--ingest", action="store_true",
                    help="with --live, also write /chats rows into the archive namespace")
    ap.add_argument("--chat-id", action="append", default=None,
                    help="restrict to a chat id (repeatable; default: known threads)")
    ap.add_argument("--date", default=None, help="only rows on this UTC date (YYYY-MM-DD)")
    ap.add_argument("--spool", default=DEFAULT_SPOOL)
    ap.add_argument("--state-file", default=DEFAULT_STATE)
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    ap.add_argument("--archive-dir", default=os.path.join(DEFAULT_REPO, "namespaces", DEFAULT_NAMESPACE))
    ap.add_argument("--confirm-offsets", action="store_true",
                    help="DR only: persist+advance the getUpdates offset (consumes updates)")
    ap.add_argument("--timeout", type=int, default=0, help="getUpdates long-poll seconds (default 0)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    token, source = resolve_bot_token()
    chat_ids = set(args.chat_id) if args.chat_id else set(KNOWN_THREADS.keys())

    if args.date:
        try:
            datetime.date.fromisoformat(args.date)
        except ValueError:
            print("ERROR: --date must be YYYY-MM-DD, got %r" % args.date)
            return 2

    if not args.live:
        print("MIRROR dry-run — no network call, no writes")
        if token:
            print("  token: resolved from %s %s" % (source, redact(token)))
        else:
            print("  token: RESOLUTION FAILED — checked %s (telegram.bot_token/token/"
                  "TELEGRAM_BOT_TOKEN), env TELEGRAM_BOT_TOKEN/TELEGRAM_TOKEN, and %s" % (CONFIG_PATH, ENV_FILE))
            print("  FIX: set telegram.bot_token in %s or TELEGRAM_BOT_TOKEN in %s" % (CONFIG_PATH, ENV_FILE))
        print("  chats: %s" % ",".join(sorted(chat_ids, key=str)))
        print("  spool: %s" % args.spool)
        print("  ingest: %s -> %s /chats/<slug>/<date>[/part-N]"
              % ("enabled" if args.ingest else "disabled", args.namespace))
        print("  offsets: %s" % ("CONFIRM (consumes updates)" if args.confirm_offsets else "peek (non-consuming)"))
        return 0 if token else 2

    if not token:
        print("ERROR: cannot resolve Telegram bot token (config.yaml telegram section, "
              "$TELEGRAM_BOT_TOKEN, %s) — aborting live run" % ENV_FILE)
        return 2

    # webhook guard — getUpdates is unavailable when a webhook is set
    try:
        info = tg_call(token, "getWebhookInfo", {}, timeout=15)
        if info.get("url"):
            print("ERROR: a webhook is configured (%s) — getUpdates unavailable, aborting "
                  "instead of fighting the gateway" % info.get("url"))
            return 2
    except RuntimeError as exc:
        print("ERROR: getWebhookInfo failed: %s" % exc)
        return 2

    params = {"limit": 100, "timeout": args.timeout,
              "allowed_updates": json.dumps(["message", "edited_message"])}
    offset = None
    if args.confirm_offsets:
        try:
            with open(args.state_file, "r", encoding="utf-8") as fh:
                offset = json.load(fh).get("last_update_id")
        except (OSError, ValueError):
            offset = None
        if offset is not None:
            params["offset"] = int(offset) + 1

    try:
        updates = tg_call(token, "getUpdates", params, timeout=args.timeout + 30)
    except RuntimeError as exc:
        print("ERROR: getUpdates failed: %s" % exc)
        return 1

    rows = shape_updates(updates, chat_ids, date_filter=args.date)
    seen = load_spool_index(args.spool)
    fresh = [r for r in rows if (str(r["chat_id"]), r["message_id"]) not in seen]

    print("MIRROR live — token %s, %d update(s), %d row(s), %d new"
          % (redact(token), len(updates), len(rows), len(fresh)))
    for r in fresh:
        if args.verbose:
            print("  + [%s] %s" % (r["slug"], r["line"][:160]))

    if fresh:
        append_spool(args.spool, fresh)
        print("  spooled %d row(s) -> %s" % (len(fresh), args.spool))

    if args.ingest:
        written, skipped, errors = ingest_rows(fresh, args.repo, args.namespace, args.archive_dir, dry=False)
        for k in written:
            print("  archive write ok: %s" % k)
        for k in skipped:
            print("  archive skip (already present): %s" % k)
        for e in errors:
            print("  archive write FAILED: %s" % e)
        if errors:
            return 1

    if args.confirm_offsets and updates:
        os.makedirs(os.path.dirname(args.state_file), exist_ok=True)
        with open(args.state_file, "w", encoding="utf-8") as fh:
            json.dump({"last_update_id": max(u["update_id"] for u in updates),
                       "updated": datetime.datetime.now(datetime.timezone.utc).isoformat()}, fh)
        print("  offset advanced to %d" % max(u["update_id"] for u in updates))

    if not fresh:
        print("  no new messages (peek mode: updates remain queued for the gateway)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
