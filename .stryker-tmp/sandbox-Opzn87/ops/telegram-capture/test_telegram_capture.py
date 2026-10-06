#!/usr/bin/env python3
"""Self-tests for the CHATGAP-001 telegram capture hardening (stdlib only).

Run:  python3 ops/telegram-capture/test_telegram_capture.py
"""
import glob
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


health = _load("tgram_health", "tgram_capture_health.py")
mirror = _load("tgram_mirror", "tgram_botapi_mirror.py")
extractor = _load("tgram_extract", "daily_chat_extract.py")

FAKE_TOKEN = "123456789:AAFakeTokenValueForTestsOnly_abcdefghijklmnop"


def run(fn, *a, **kw):
    """Call fn, capture stdout + exit code."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        try:
            rc = fn(*a, **kw)
            if rc is None:
                rc = 0
        except SystemExit as exc:
            rc = exc.code
    return rc, buf.getvalue()


def write_archive(archive_dir, slug, dates):
    d = os.path.join(archive_dir, "message", "2026-09")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "0001.jsonl"), "a", encoding="utf-8") as fh:
        for date in dates:
            fh.write(json.dumps({"key": "/chats/%s/%s" % (slug, date), "domain": "message"}) + "\n")


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _args(self, **over):
        a = ["--no-canary", "--verbose",
             "--archive-dir", os.path.join(self.tmp, "chat-archive"),
             "--spool", os.path.join(self.tmp, "spool.jsonl"),
             "--state-db", os.path.join(self.tmp, "absent-state.db")]
        a += over.pop("extra", [])
        return a

    def test_healthy_when_archive_covers_source(self):
        arch = os.path.join(self.tmp, "chat-archive")
        write_archive(arch, "karahermes-set", ["2026-09-08", "2026-09-09"])
        spool = os.path.join(self.tmp, "spool.jsonl")
        with open(spool, "w") as fh:
            fh.write(json.dumps({"slug": "karahermes-set", "date": "2026-09-09"}) + "\n")
        rc, out = run(health.main, self._args())
        self.assertEqual(rc, 0, out)
        self.assertNotIn("ALARM", out)

    def test_alarm_on_write_gap(self):
        arch = os.path.join(self.tmp, "chat-archive")
        write_archive(arch, "karahermes-set", ["2026-09-07"])  # archive is behind
        spool = os.path.join(self.tmp, "spool.jsonl")
        with open(spool, "w") as fh:
            fh.write(json.dumps({"slug": "karahermes-set", "date": "2026-09-09"}) + "\n")
        rc, out = run(health.main, self._args(extra=["--max-gap-days", "0"]))
        self.assertEqual(rc, 1, out)
        self.assertIn("CHATGAP-001 ALARM", out)
        self.assertIn("[GAP] karahermes-set", out)

    def test_alarm_on_broken_destination_canary(self):
        arch = os.path.join(self.tmp, "chat-archive")
        os.makedirs(arch, exist_ok=True)
        rc, out = run(health.main, [
            "--archive-dir", arch,
            "--spool", os.path.join(self.tmp, "none.jsonl"),
            "--state-db", os.path.join(self.tmp, "none.db"),
            "--repo", os.path.join(self.tmp, "no-such-repo"),
            "--strict",
        ])
        self.assertEqual(rc, 1, out)
        self.assertIn("[DEST]", out)

    def test_stale_mirror_warns_but_passes_without_strict(self):
        arch = os.path.join(self.tmp, "chat-archive")
        write_archive(arch, "karahermes-set", ["2026-09-09"])
        spool = os.path.join(self.tmp, "spool.jsonl")
        with open(spool, "w") as fh:
            fh.write(json.dumps({"slug": "karahermes-set", "date": "2026-09-09"}) + "\n")
        os.utime(spool, (0, 0))  # epoch = ancient
        rc, out = run(health.main, self._args())
        self.assertEqual(rc, 0, out)
        self.assertIn("WARN", out)
        self.assertIn("[MIRROR] spool stale", out)

    def test_canary_dry_run_never_touches_repo(self):
        arch = os.path.join(self.tmp, "chat-archive")
        write_archive(arch, "karahermes-set", ["2026-09-09", "2026-09-10"])
        rc, out = run(health.main, [
            "--canary-dry-run", "--verbose",
            "--archive-dir", arch,
            "--spool", os.path.join(self.tmp, "none.jsonl"),
            "--state-db", os.path.join(self.tmp, "none.db"),
            "--repo", os.path.join(self.tmp, "no-such-repo"),
        ])
        self.assertEqual(rc, 0, out)
        self.assertIn("[CANARY] dry-run", out)
        self.assertNotIn("[DEST]", out)


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved = (mirror.CONFIG_PATH, mirror.ENV_FILE, os.environ.get("TELEGRAM_BOT_TOKEN"))
        mirror.CONFIG_PATH = os.path.join(self.tmp, "config.yaml")
        mirror.ENV_FILE = os.path.join(self.tmp, ".env")
        os.environ.pop("TELEGRAM_BOT_TOKEN", None)

    def tearDown(self):
        mirror.CONFIG_PATH, mirror.ENV_FILE, tok = self._saved
        if tok is None:
            os.environ.pop("TELEGRAM_BOT_TOKEN", None)
        else:
            os.environ["TELEGRAM_BOT_TOKEN"] = tok
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_dry_run_reports_resolution_failure_clearly(self):
        rc, out = run(mirror.main, ["--dry-run"])
        self.assertEqual(rc, 2, out)
        self.assertIn("RESOLUTION FAILED", out)
        self.assertIn("FIX:", out)

    def test_dry_run_resolves_from_dotenv_without_leaking(self):
        with open(mirror.ENV_FILE, "w") as fh:
            fh.write("TELEGRAM_BOT_TOKEN=%s\n" % FAKE_TOKEN)
        rc, out = run(mirror.main, ["--dry-run"])
        self.assertEqual(rc, 0, out)
        self.assertIn("dotenv:TELEGRAM_BOT_TOKEN", out)
        self.assertNotIn(FAKE_TOKEN, out)

    def test_dry_run_prefers_config_yaml(self):
        with open(mirror.CONFIG_PATH, "w") as fh:
            fh.write("telegram:\n  bot_token: %s\n" % FAKE_TOKEN)
        rc, out = run(mirror.main, ["--dry-run"])
        self.assertEqual(rc, 0, out)
        self.assertIn("config.yaml:telegram.bot_token", out)
        self.assertNotIn(FAKE_TOKEN, out)

    def test_shape_updates_sender_and_contract_line(self):
        updates = [{"update_id": 5, "message": {
            "message_id": 11, "date": 1789000000,
            "chat": {"id": -1003310984808},
            "from": {"id": 8925815583, "first_name": "Bane"},
            "text": "hello\nworld"}},
            {"update_id": 6, "message": {
                "message_id": 12, "date": 1789000060,
                "chat": {"id": -1003310984808},
                "from": {"id": 99, "is_bot": True, "first_name": "bot"},
                "text": "reply"}}]
        rows = mirror.shape_updates(updates, set(["-1003310984808"]))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["slug"], "karahermes-set")
        self.assertEqual(rows[0]["sender"], "Bane")
        self.assertEqual(rows[1]["sender"], "KaraHermes")
        self.assertRegex(rows[0]["line"], r"^\d{2}:\d{2} Bane: hello world$")

    def test_shape_updates_filters_unknown_chat_and_date(self):
        updates = [{"update_id": 1, "message": {
            "message_id": 1, "date": 1789000000, "chat": {"id": 42},
            "from": {"id": 1}, "text": "x"}}]
        self.assertEqual(mirror.shape_updates(updates, set(["-1003310984808"])), [])

    def test_ingest_skips_days_already_archived(self):
        arch = os.path.join(self.tmp, "chat-archive")
        write_archive(arch, "karahermes-set", ["2026-09-09"])
        rows = [{"slug": "karahermes-set", "date": "2026-09-09", "line": "12:00 Bane: hi"},
                {"slug": "karahermes-set", "date": "2026-09-10", "line": "12:01 Bane: new"}]
        written, skipped, errors = mirror.ingest_rows(rows, self.tmp, "chat-archive", arch, dry=True)
        self.assertEqual(skipped, ["/chats/karahermes-set/2026-09-09"])
        self.assertEqual(written, ["/chats/karahermes-set/2026-09-10 (dry-run)"])
        self.assertEqual(errors, [])


class ExtractorFallbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.spool = os.path.join(self.tmp, "spool.jsonl")
        self.state_db = os.path.join(self.tmp, "state.db")  # deliberately absent

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        for f in glob.glob("/tmp/daily-chat-rows-karahermes-*.tsv"):
            try:
                os.remove(f)
            except OSError:
                pass

    def test_fallback_ingests_from_spool_when_state_db_missing(self):
        with open(self.spool, "w") as fh:
            fh.write(json.dumps({"chat_id": "-1003310984808", "slug": "karahermes-set",
                                 "date": "2026-09-09", "line": "21:01 Bane: ping"}) + "\n")
            fh.write(json.dumps({"chat_id": "-1003310984808", "slug": "karahermes-set",
                                 "date": "2026-09-09", "line": "21:02 KaraHermes: pong"}) + "\n")
        rc, out = run(extractor.main, ["2026-09-09", "--state-db", self.state_db, "--spool", self.spool])
        self.assertEqual(rc, 0, out)
        self.assertIn("# FALLBACK: state.db produced 0 rows", out)
        self.assertIn("mirror spool across 1 telegram chat(s)", out)
        with open("/tmp/daily-chat-rows-karahermes-set.tsv") as fh:
            body = fh.read()
        self.assertEqual(body, "21:01 Bane: ping\n21:02 KaraHermes: pong")

    def test_no_messages_when_both_sources_empty(self):
        rc, out = run(extractor.main, ["2026-09-09", "--state-db", self.state_db, "--spool", self.spool])
        self.assertEqual(rc, 0, out)
        self.assertIn("NO_MESSAGES", out)

    def test_fallback_disabled_keeps_no_messages(self):
        rc, out = run(extractor.main, ["2026-09-09", "--state-db", self.state_db,
                                       "--spool", self.spool, "--no-fallback"])
        self.assertEqual(rc, 0, out)
        self.assertNotIn("FALLBACK", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
