# Session Distillation (`duckbrain distill-sessions`)

DF-2026-18 — nightly distiller that turns Hermes agent chat sessions
(`state.db`) into durable, bounded, hash-keyed DuckBrain records.

Without it, the ledger only learns what per-project sync crons choose to
write: decisions taken in conversation stay trapped in `state.db`. The
distiller closes that hole — for every session that **ended** inside the
window (default: last 24h) it extracts short statements (decisions,
verified findings, open items) and writes them under
`/session/<YYYY-MM-DD>/<session-id>/<hash16>` in the `sessions` namespace
via the repo's own in-process write path (`rememberTool`).

## Guarantees

- **Bounded** — at most 20 records per session, each statement capped at
  240 chars, at most 2000 messages scanned per session.
- **Hash-keyed + idempotent** — the key suffix derives from
  sha256(message hash, record type, statement), so a rerun over unchanged
  input produces the same keys and writes **zero** new records
  (skip-if-exists).
- **No transcripts, prompts, or secrets** — only short extracted
  statements are stored, each redacted (tokens, API keys, bearer strings,
  passwords, JWTs, AWS keys, long hex blobs → `[REDACTED]`). System
  prompts and tool payloads are never read.
- **Cron/system sessions skipped** — `sessions.source` labels `cron`,
  `kanban`, and `tool` are system/automation surfaces and are never
  distilled. Everything else (`cli`, `telegram`, `tui`, `acp`,
  `api_server`, `subagent`, `unknown`) is eligible.
- **Corrupt transcripts refused** — a session whose messages fail to read
  (query error, non-text BLOB content, non-finite timestamp) is reported
  loudly on stderr and skipped whole; no partial garbage is written.

## Usage

```bash
duckbrain distill-sessions [--state-db=PATH] [--window-hours=N] [--namespace=NAME] [--dry-run]
```

| Flag               | Default                                      | Meaning                                                                |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| `--state-db=PATH`  | `~/.hermes/state.db` (env `HERMES_STATE_DB`) | Hermes state.db to read (opened read-only)                             |
| `--window-hours=N` | `24`                                         | Lookback window; sessions whose `ended_at` is inside it are considered |
| `--namespace=NAME` | `sessions`                                   | Target namespace for the records                                       |
| `--dry-run`        | off                                          | List what WOULD be written; write nothing                              |

## Scheduling (nightly cron)

```cron
17 3 * * * node $HOME/duckbrain/bin/duckbrain.js distill-sessions >> $HOME/.hermes/logs/session-distiller.log 2>&1
```

Run a `--dry-run` first to see the case count it would process. The live
state.db is only ever opened read-only; writes go exclusively to the
target namespace's JSONL store (with the normal debounced git commit).

## Record shape

```json
{
  "key": "/session/2026-10-29/20261029_090000_aaaa01/0123456789abcdef",
  "domain": "raw_note",
  "embedding_text": "We decided to go with Postgres for the store because it fits the existing tooling.",
  "attributes": {
    "session_id": "20261029_090000_aaaa01",
    "session_date": "2026-10-29",
    "session_source": "cli",
    "record_type": "decision",
    "message_hash": "<sha256 of role+content>",
    "message_id": 12345,
    "distilled_by": "session-distiller"
  }
}
```

`record_type` is one of `decision`, `finding`, `open_item`. The full
message hash in `attributes` is the audit link back to the source message
in `state.db` without storing the message itself.
