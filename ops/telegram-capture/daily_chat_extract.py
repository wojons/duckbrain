#!/usr/bin/env python3
"""Daily chat extractor v4 — real-row backfill for DuckBrain chat-archive tables.

v4 (CHATGAP-001): adds a state.db-INDEPENDENT fallback.  The v3 contract is
unchanged (same TSV paths, same 'HH:MM Sender: text' rows, same stdout shape
injected into the cron agent prompt) — but when state.db is missing, corrupt,
or returns zero telegram rows for the day, the extractor now ingests from the
bot-API mirror spool (~/.hermes/state/tgram-capture-spool.jsonl, written by
tgram_botapi_mirror.py) instead of silently producing an empty day.  A loud
`# FALLBACK` header marks the switch so the cron agent and the health alarm
can tell which leg served the data.

v3 (2026-08-09, Bane audit): auto-discovers ALL telegram chats present in
state.db instead of a hardcoded allowlist. Known threads keep their slugs;
unknown/new chats get a stable `chat-<id>` slug and a loud NEW CHAT warning so
the cron agent archives them AND reports them. Nothing is silently dropped.

Reads yesterday's telegram user+assistant messages from ~/.hermes/state.db,
routes rows by chat_id into per-thread files, prints capped previews to stdout
(injected into the cron agent's prompt).

Usage: python3 daily_chat_extract.py [YYYY-MM-DD] [--spool FILE] [--state-db FILE]
"""
import argparse, sqlite3, os, sys, json, datetime

DB = os.path.expanduser("~/.hermes/state.db")
SPOOL = os.path.expanduser("~/.hermes/state/tgram-capture-spool.jsonl")
# Known threads: chat_id -> (slug, display name). Anything else found in
# state.db is auto-slugged chat-<id> (see discover_threads).
KNOWN_THREADS = {
    "-1003310984808": ("karahermes-set", "KaraHermes - Set"),
    "8925815583": ("karahermes-dm", "KaraHermes DM"),
}
MAX_PREVIEW_CHARS = 25000
LINE_CAP = 600


def slug_for(chat_id):
    key = str(chat_id)
    if key in KNOWN_THREADS:
        return KNOWN_THREADS[key]
    return ("chat-" + key.replace("-", "m"), "chat %s" % key)


def read_state_db(target, start, end, db_path):
    """v3 path. Returns (rows, threads, raw_count, error).

    rows: list of (ts, role, text, chat_id); threads: chat_id -> (slug, name);
    raw_count: len() of the raw sqlite result — v3 reported THIS in the header
    ("N raw messages read from state.db"), so v4 keeps the same semantics.
    """
    if not os.path.exists(db_path):
        return [], {}, 0, "state.db missing: %s" % db_path
    try:
        con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True, timeout=10)
    except Exception as exc:
        return [], {}, 0, "state.db unopenable: %s: %s" % (type(exc).__name__, exc)
    try:
        seen_ids = [r[0] for r in con.execute(
            "SELECT DISTINCT s.chat_id FROM messages m JOIN sessions s ON m.session_id=s.id "
            "WHERE s.source='telegram' AND m.timestamp>=? AND m.timestamp<?",
            (start, end)).fetchall()]
        seen_ids = [c for c in seen_ids if c]
        threads = {cid: slug_for(cid) for cid in seen_ids}
        raw = con.execute(
            """SELECT m.timestamp, m.role, m.content, s.chat_id
               FROM messages m JOIN sessions s ON m.session_id = s.id
               WHERE s.source='telegram' AND m.timestamp>=? AND m.timestamp<?
                 AND m.role IN ('user','assistant')
               ORDER BY m.timestamp""", (start, end)).fetchall()
    except Exception as exc:
        return [], {}, 0, "state.db query failed: %s: %s" % (type(exc).__name__, exc)
    finally:
        con.close()

    rows = []
    for ts, role, content, chat_id in raw:
        if not content or chat_id not in threads:
            continue
        text = content if isinstance(content, str) else json.dumps(content)
        text = text.replace("\t", " ").replace("\n", " ").strip()
        if role == "assistant" and text.startswith("{"):
            continue  # tool-call shaped payload
        if len(text) > LINE_CAP:
            text = text[:LINE_CAP] + "…"
        rows.append((ts, role, text, chat_id))
    return rows, threads, len(raw), None


def read_spool(target, spool_path):
    """State.db-independent leg: the bot-API mirror spool.

    Returns (lines_by_chat_id, threads, error) where lines_by_chat_id maps
    chat_id -> ["HH:MM Sender: text", ...] already in the row contract.
    """
    if not os.path.exists(spool_path):
        return {}, {}, "mirror spool missing: %s" % spool_path
    day = target.isoformat()
    lines, threads = {}, {}
    try:
        with open(spool_path, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if rec.get("date") != day:
                    continue
                cid = str(rec.get("chat_id"))
                if not cid:
                    continue
                slug = rec.get("slug") or slug_for(cid)[0]
                threads[cid] = KNOWN_THREADS.get(cid) or (slug, "chat %s" % cid)
                line = rec.get("line")
                if line:
                    lines.setdefault(cid, []).append(line)
    except OSError as exc:
        return {}, {}, "spool unreadable: %s" % exc
    return lines, threads, None


def emit(threads, out, target, source_note):
    print("# daily chat extract %s (UTC): %s" % (target, source_note))
    any_rows = False
    for chat_id, (slug, name) in sorted(threads.items(), key=lambda kv: kv[1][0]):
        lines = out.get(chat_id, [])
        if lines:
            any_rows = True
        fn = "/tmp/daily-chat-rows-%s.tsv" % slug
        with open(fn, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print("# %s (%s): %d rows -> %s" % (slug, name, len(lines), fn))
        budget = MAX_PREVIEW_CHARS
        preview = []
        for ln in lines:
            if budget <= 0:
                preview.append("… (preview truncated)")
                break
            preview.append(ln)
            budget -= len(ln) + 1
        if preview:
            print("# preview:")
            print("\n".join(preview))
    if not any_rows:
        print("NO_MESSAGES")
    return any_rows


def main(argv=None):
    ap = argparse.ArgumentParser(description="daily chat extractor v4 (state.db + bot-API fallback)")
    ap.add_argument("date", nargs="?", default=None, help="YYYY-MM-DD (default: yesterday UTC)")
    ap.add_argument("--state-db", default=DB)
    ap.add_argument("--spool", default=SPOOL)
    ap.add_argument("--no-fallback", action="store_true")
    args = ap.parse_args(argv)

    if args.date:
        target = datetime.date.fromisoformat(args.date)
    else:
        target = datetime.date.today() - datetime.timedelta(days=1)

    start = datetime.datetime(target.year, target.month, target.day,
                              tzinfo=datetime.timezone.utc).timestamp()
    end = start + 86400

    rows, threads, raw_count, db_err = read_state_db(target, start, end, args.state_db)

    out = {}
    for ts, role, text, chat_id in rows:
        dt = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).strftime("%H:%M")
        sender = "Bane" if role == "user" else "KaraHermes"
        out.setdefault(chat_id, []).append("%s %s: %s" % (dt, sender, text))

    if rows:
        return 0 if emit(threads, out, target,
                         "%d raw messages read from state.db across %d telegram chat(s)"
                         % (raw_count, len(threads))) else 0

    # ---- fallback: state.db unavailable / empty -> bot-API mirror spool ----
    if args.no_fallback:
        return 0 if emit(threads, out, target,
                         "0 raw messages read from state.db (fallback disabled)") else 0

    print("# FALLBACK: state.db produced 0 rows (%s)" % (db_err or "no telegram messages for the day"))
    print("# FALLBACK: using bot-API mirror spool %s" % args.spool)
    lines, fb_threads, spool_err = read_spool(target, args.spool)
    if spool_err:
        print("# FALLBACK UNAVAILABLE: %s" % spool_err)
        print("# FALLBACK UNAVAILABLE: no state.db rows and no mirror rows — nothing to ingest")
        return 0 if emit({}, {}, target, "0 raw messages read (state.db + spool both empty)") else 0
    total = sum(len(v) for v in lines.values())
    for cid, (slug, name) in fb_threads.items():
        if cid not in lines:
            print("# NEW CHAT DETECTED: chat_id=%s -> slug '%s' (mirror spool)" % (cid, slug))
    return 0 if emit(fb_threads, lines, target,
                     "%d raw messages read from bot-API mirror spool across %d telegram chat(s)"
                     % (total, len(fb_threads))) else 0


if __name__ == "__main__":
    sys.exit(main())
