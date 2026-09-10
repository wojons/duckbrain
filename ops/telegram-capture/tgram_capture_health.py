#!/usr/bin/env python3
"""CHATGAP-001 — write-health alarm for the Telegram chat capture pipeline.

WHY THIS EXISTS
---------------
The daily capture path is:  Telegram -> state.db -> daily_chat_extract.py ->
/tmp/daily-chat-rows-*.tsv -> cron agent -> DuckBrain chat-archive rows
(`/chats/<slug>/<date>[/part-N]`).  Every stage of that chain can silently
stop writing while still exiting 0: the extractor can read an empty/corrupt
state.db, the cron agent can fail its POST, the DuckBrain daemon can be
down, or the namespace can go read-only.  Until now nothing noticed.

This alarm is the tripwire.  It checks the DESTINATION, not the log:

  1. CANARY   — write+read a probe key in the chat-archive namespace through
                the real write path (duckbrain CLI) and confirm it lands.
  2. GAP      — compare, per thread, the newest archived `/chats/<slug>/<date>`
                key against the newest source date available from the
                state.db-INDEPENDENT mirror spool (and state.db as a
                secondary signal).  Source newer than archive = write gap.
  3. MIRROR   — the independent bot-API mirror leg's spool must be fresh;
                a dead mirror is reported (WARN, or fatal with --strict)
                because it is the fallback that keeps capture alive when
                state.db dies.

CONTRACT
--------
* Silent + exit 0 when healthy (Hermes watchdog convention).  --verbose
  prints a one-line OK.
* Any real write-health failure prints a `🛑 CHATGAP-001 ALARM` block on
  stdout and exits 1.
* Config/usage errors exit 2.

Usage:
  python3 tgram_capture_health.py [--verbose] [--no-canary] [--strict]
                                  [--archive-dir DIR] [--spool FILE]
                                  [--state-db FILE] [--repo DIR]
                                  [--max-gap-days N] [--mirror-max-age-h N]
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")
DEFAULT_ARCHIVE_DIR = os.path.join(HOME, "duckbrain", "namespaces", "chat-archive")
DEFAULT_SPOOL = os.path.join(HOME, ".hermes", "state", "tgram-capture-spool.jsonl")
DEFAULT_STATE_DB = os.path.join(HOME, ".hermes", "state.db")
DEFAULT_REPO = os.path.join(HOME, "duckbrain")
NAMESPACE = "chat-archive"
HTTP_BASE = "http://127.0.0.1:3000"

# chat_id -> slug, mirrored from daily_chat_extract.py (single source of truth
# for the archive layout the pipeline is contracted to produce).
KNOWN_THREADS = {
    "-1003310984808": "karahermes-set",
    "8925815583": "karahermes-dm",
}

CHAT_KEY_RE = re.compile(r"^/chats/([^/]+)/(\d{4}-\d{2}-\d{2})(?:/|$)")


# --------------------------------------------------------------------------
# readers
# --------------------------------------------------------------------------
def _iter_jsonl(root_dir):
    """Yield JSONL file paths under a namespace dir, skipping dot/config dirs."""
    for root, dirs, files in os.walk(root_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("config",)]
        for fn in files:
            if fn.endswith(".jsonl"):
                yield os.path.join(root, fn)


def _key_in_tree(root_dir, key):
    needle = '"%s"' % key
    for path in _iter_jsonl(root_dir):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                if needle in fh.read():
                    return True
        except OSError:
            continue
    return False


def scan_archive_keys(archive_dir):
    """Return {slug: {date,...}} parsed straight off the namespace JSONL.

    Reads storage directly (not the daemon) so the alarm still works when the
    daemon is the thing that is broken.  Line-oriented + tolerant of the
    occasional torn line.
    """
    found = {}
    if not os.path.isdir(archive_dir):
        return found, "archive dir missing: %s" % archive_dir
    for path in _iter_jsonl(archive_dir):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or '"key"' not in line:
                        continue
                    try:
                        rec = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    m = CHAT_KEY_RE.match(rec.get("key") or "")
                    if m:
                        found.setdefault(m.group(1), set()).add(m.group(2))
        except OSError as exc:
            return found, "cannot read %s: %s" % (path, exc)
    return found, None


def scan_spool_dates(spool_path):
    """{slug: {date}} from the bot-API mirror spool (state.db independent)."""
    found = {}
    if not os.path.exists(spool_path):
        return found, "mirror spool not found: %s" % spool_path
    try:
        with open(spool_path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except (ValueError, TypeError):
                    continue
                slug = rec.get("slug")
                date = rec.get("date")
                if slug and date:
                    found.setdefault(slug, set()).add(date)
    except OSError as exc:
        return found, "cannot read spool %s: %s" % (spool_path, exc)
    return found, None


def scan_state_db_dates(state_db):
    """{slug: {date}} for telegram traffic in state.db — SECONDARY signal.

    The alarm must not depend on state.db, so a failure here is reported and
    ignored, never fatal.
    """
    found = {}
    if not os.path.exists(state_db):
        return found, "state.db not found: %s" % state_db
    try:
        import sqlite3
        con = sqlite3.connect("file:%s?mode=ro" % state_db, uri=True, timeout=5)
        try:
            rows = con.execute(
                "SELECT DISTINCT s.chat_id, m.timestamp FROM messages m "
                "JOIN sessions s ON m.session_id = s.id WHERE s.source='telegram'"
            ).fetchall()
        finally:
            con.close()
    except Exception as exc:  # sqlite3.Error, OSError, ...
        return found, "state.db unreadable (%s: %s)" % (type(exc).__name__, exc)
    for chat_id, ts in rows:
        slug = KNOWN_THREADS.get(str(chat_id))
        if not slug or ts is None:
            continue
        d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).date().isoformat()
        found.setdefault(slug, set()).add(d)
    return found, None


# --------------------------------------------------------------------------
# canary
# --------------------------------------------------------------------------
def canary(archive_dir, repo, dry=False):
    """Write+read probe through the real duckbrain CLI.  Returns (ok, detail)."""
    today = datetime.date.today().isoformat()
    key = "/health/tgram-capture/%s" % today
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = "chat-capture canary %s" % stamp
    if dry:
        return True, "dry-run (would write %s)" % key
    cli = os.path.join(repo, "bin", "duckbrain.js")
    if not os.path.exists(cli):
        return False, "duckbrain CLI missing at %s" % cli
    cmd = [
        "node", cli, "remember", key,
        "--domain=event", "--namespace=%s" % NAMESPACE,
        "--content=%s" % payload, "--wait",
    ]
    try:
        proc = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, "canary write crashed: %s" % exc
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-1:] or [""]
        return False, "canary write exit=%d: %s" % (proc.returncode, tail[0][:200])
    # Read back from storage — a successful POST is not a landed row.
    if not _key_in_tree(archive_dir, key):
        return False, "canary write reported success but %s not found in storage" % key
    return True, "canary %s ok" % key


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description="CHATGAP-001 telegram capture write-health alarm")
    ap.add_argument("--verbose", action="store_true", help="print an OK line when healthy")
    ap.add_argument("--no-canary", action="store_true", help="skip the write probe")
    ap.add_argument("--canary-dry-run", action="store_true", help="probe path resolution only")
    ap.add_argument("--strict", action="store_true", help="treat WARN level issues as fatal")
    ap.add_argument("--archive-dir", default=DEFAULT_ARCHIVE_DIR)
    ap.add_argument("--spool", default=DEFAULT_SPOOL)
    ap.add_argument("--state-db", default=DEFAULT_STATE_DB)
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--max-gap-days", type=int, default=1,
                    help="grace days before a source/archive gap alarms (default 1)")
    ap.add_argument("--mirror-max-age-h", type=float, default=26.0,
                    help="hours before a stale mirror spool warns (default 26)")
    args = ap.parse_args(argv)

    today = datetime.date.today()
    alarms = []
    warns = []
    notes = []

    archive, archive_err = scan_archive_keys(args.archive_dir)
    if archive_err:
        alarms.append("[STORE] %s" % archive_err)

    spool, spool_err = scan_spool_dates(args.spool)
    spool_age_h = None
    if os.path.exists(args.spool):
        spool_age_h = (datetime.datetime.now().timestamp() - os.path.getmtime(args.spool)) / 3600.0
    elif spool_err:
        warns.append("[MIRROR] %s" % spool_err)

    db_dates, db_err = scan_state_db_dates(args.state_db)
    if db_err:
        notes.append("[DB] %s" % db_err)

    if not args.no_canary:
        ok, detail = canary(args.archive_dir, args.repo, dry=args.canary_dry_run)
        if ok:
            notes.append("[CANARY] %s" % detail)
        else:
            alarms.append("[DEST] %s" % detail)

    # per-thread gap: source newest vs archive newest
    slugs = sorted(set(KNOWN_THREADS.values()) | set(archive) | set(spool) | set(db_dates))
    for slug in slugs:
        src = set(spool.get(slug, set())) | set(db_dates.get(slug, set()))
        arch = archive.get(slug, set())
        if not src:
            if not arch:
                notes.append("[%s] no source rows and no archive rows" % slug)
            continue
        src_newest = max(src)
        arch_newest = max(arch) if arch else None
        missing = sorted(d for d in src - arch if d <= (today - datetime.timedelta(days=args.max_gap_days)).isoformat())
        if missing:
            alarms.append(
                "[GAP] %s: archive newest=%s source newest=%s missing=%s"
                % (slug, arch_newest or "none", src_newest, ",".join(missing))
            )
        elif args.verbose:
            notes.append("[%s] archive newest=%s source newest=%s" % (slug, arch_newest, src_newest))

    if spool_age_h is not None and spool_age_h > args.mirror_max_age_h:
        msg = "[MIRROR] spool stale: last update %.1fh ago (limit %.0fh) — %s" % (
            spool_age_h, args.mirror_max_age_h, args.spool)
        (alarms if args.strict else warns).append(msg)

    if alarms:
        print("🛑 CHATGAP-001 ALARM — telegram chat capture write-health FAILED")
        for a in alarms:
            print("  %s" % a)
        for w in warns:
            print("  %s" % w)
        for n in notes:
            print("  %s" % n)
        print("  verdict=ALARM exit=1")
        return 1

    if warns:
        print("⚠️ CHATGAP-001 WARN — capture healthy but degraded")
        for w in warns:
            print("  %s" % w)
        for n in notes:
            print("  %s" % n)
        print("  verdict=WARN exit=0")
        return 0

    if args.verbose:
        print("✅ CHATGAP-001 OK — " + "; ".join(notes) if notes else "✅ CHATGAP-001 OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
