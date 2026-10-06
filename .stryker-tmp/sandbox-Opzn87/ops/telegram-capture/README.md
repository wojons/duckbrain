# Telegram chat capture hardening (CHATGAP-001)

Tracked copies of the Telegram chat-archive capture hardening. The operational
installs live in `~/.hermes/scripts/`; this directory is the reviewable,
versioned source of truth. **Copy these files out — do not run them from here**
(the scripts resolve the DuckBrain repo and namespace paths by absolute path).

```
ops/telegram-capture/
├── tgram_capture_health.py     # (1) write-health alarm
├── tgram_botapi_mirror.py      # (2) independent bot-API capture leg
├── daily_chat_extract.py       # (3) extractor v4 — adds spool fallback
├── test_telegram_capture.py    # 14 stdlib self-tests for all three
└── README.md
```

## The pipeline

```
Telegram ──► state.db ──► daily_chat_extract.py ──► /tmp/daily-chat-rows-<slug>.tsv
                                │                        │
                                │                        └─► cron agent ──► DuckBrain
                                │                                            chat-archive
                                └─ FALLBACK ──► mirror spool ────────────────► /chats/<slug>/<date>[/part-N]
                                                   ▲
                    Telegram Bot API ──► tgram_botapi_mirror.py
                                                   ▲
                              tgram_capture_health.py watches the destination
```

Archive contract (unchanged): rows are keyed
`/chats/<slug>/<date>` or `/chats/<slug>/<date>/part-N` in namespace
`chat-archive`, domain `message`, content is newline-joined
`HH:MM Sender: text` lines (UTC), sender ∈ `Bane` | `KaraHermes` | `<first_name>`.

## 1. `tgram_capture_health.py` — write-health alarm

Checks the **destination**, not the logs. Three signals:

| Signal | Meaning |
|---|---|
| `[CANARY]` / `[DEST]` | write+read a probe key through the real `duckbrain remember` CLI; a successful POST that is not readable in storage is a failure |
| `[GAP]` | newest archived date per thread vs newest *source* date (mirror spool, plus state.db as a secondary signal) |
| `[MIRROR]` | the state.db-independent mirror spool is stale |

* Silent + exit 0 when healthy; `--verbose` prints one OK line.
* Any real failure prints a `🛑 CHATGAP-001 ALARM` block and exits 1.
* `--strict` promotes WARN (stale mirror) to fatal. Exit 2 = config error.

```bash
python3 ~/.hermes/scripts/tgram_capture_health.py --verbose
```

## 2. `tgram_botapi_mirror.py` — independent capture leg

Reads the Telegram Bot API directly, so it does **not** depend on `state.db`.

* Writes an append-only spool `~/.hermes/state/tgram-capture-spool.jsonl`
  (one record per message, deduped by `(chat_id, message_id)`).
* `--ingest` also writes `/chats/<slug>/<date>[/part-N]` rows to `chat-archive`
  through the same `duckbrain remember` CLI the cron writer uses.
* **Default is `--dry-run`** — no network call, no writes. Pass `--live` to poll.
* **Peek mode by default**: `getUpdates` is called *without* `offset`, so
  Telegram keeps pending updates queued for the live gateway — the leg cannot
  steal the gateway's updates. `--confirm-offsets` (DR only) persists and
  advances an offset, and must never run concurrently with a live gateway.
* Aborts cleanly if a webhook is configured (`getUpdates` unavailable).

Token resolution (runtime, never printed — source label + masked suffix only):

1. `~/.hermes/config.yaml` → `telegram.bot_token` | `telegram.token` | `telegram.TELEGRAM_BOT_TOKEN`
2. env `TELEGRAM_BOT_TOKEN` | `TELEGRAM_TOKEN` | `TG_BOT_TOKEN`
3. `~/.hermes/.env` → `TELEGRAM_BOT_TOKEN=...`

`--dry-run` states which source resolved, or a loud
`token: RESOLUTION FAILED` with the exact paths checked and the fix.

```bash
python3 ~/.hermes/scripts/tgram_botapi_mirror.py --dry-run
python3 ~/.hermes/scripts/tgram_botapi_mirror.py --live --ingest --verbose
```

## 3. `daily_chat_extract.py` (v4) — extractor fallback ingest

v3 behaviour is preserved **exactly** (same `/tmp/daily-chat-rows-<slug>.tsv`
paths, same row format, same stdout shape, same header counts, same
`NO_MESSAGES` sentinel) — verified byte-for-byte against the v3 backup on a
live day. The only addition: when state.db is missing, unopenable, raises, or
returns zero rows, the extractor ingests the day from the mirror spool and
prints a loud `# FALLBACK` header naming the leg that served the data.

```bash
python3 ~/.hermes/scripts/daily_chat_extract.py 2026-09-09
python3 ~/.hermes/scripts/daily_chat_extract.py 2026-09-09 --no-fallback
```

## Tests

```bash
python3 ops/telegram-capture/test_telegram_capture.py     # 14 tests, stdlib only
```

Covers: healthy alarm, `[GAP]` alarm, broken-destination `[DEST]` alarm, stale
mirror WARN vs `--strict`, canary dry-run, token resolution failure/`.env`/
`config.yaml` precedence (asserting the token never leaks to stdout), update
shaping (sender mapping + `HH:MM Sender: text` line cap), ingest dedupe, and
the extractor fallback (missing + empty sources, `--no-fallback`).

## Status / known gap found on first live run

The alarm's first live run reported `[GAP] karahermes-set … missing=2026-09-05`:
state.db holds 522 telegram messages for 2026-09-05 but the archive has no
`/chats/karahermes-set/2026-09-05` key. That is a real capture hole predating
this work, not a false positive — a backfill row is the follow-up.
