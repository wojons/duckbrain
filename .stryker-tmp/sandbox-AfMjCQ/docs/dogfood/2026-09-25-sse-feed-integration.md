# DuckBrain Integration — SSE Change Feed (SUPA-5), 2026-09-25

Run 10 of the dogfood series. Angle: the realtime change feed — every prior run
touched CLI/REST/UI/deletion/as-of but only ever checked the SSE scaffold's
"connected" frame. This run drove the feed as a real subscriber: live events,
cursor resume, daemon-restart resume, filters, auth boundaries, overflow.

## Verdict: SHIPPABLE-ON-THIS-SURFACE (engine excellent; one replay filter bug)

The feed is not vaporware — it is the best-documented, best-behaving surface
in the repo. Cursor semantics are genuinely restart-safe and derived from git
commits, exactly as the spec demands. Two real defects found (DF-0925-01/02).

## Promise tested

"Subscribe to committed changes for one namespace via SSE; a change appears
only after its namespace git commit lands; persist the last `id:` line and
resume strictly after it (?cursor= or Last-Event-ID); malformed/gone cursors
fail loudly (400/410); filters (tables/ops) select the subset."
(skills/duckbrain-usage v1.8.0, §Realtime change feed)

## Setup that worked (isolation trio, from the usage skill)

```bash
mkdir -p /tmp/db-df0925/home /tmp/db-df0925/ns
cp duckbrain.config.json /tmp/db-df0925/config.json
# 1) mint the scratch auth store (token CREATES the store; see DF-0925-06)
DUCKBRAIN_AUTH_FILE=/tmp/db-df0925/home/auth.json node bin/duckbrain.js token --name=df0925
# 2) daemon: env trio + explicit flags
DUCKBRAIN_NAMESPACES_PATH=/tmp/db-df0925/ns DUCKBRAIN_CONFIG_PATH=/tmp/db-df0925/config.json \
  node bin/duckbrain.js http --port 3799 --auth=apikey --auth-file=/tmp/db-df0925/home/auth.json
# 3) subscribe
curl -sN "http://127.0.0.1:3799/api/ns/<ns>/changes?tables=memories" -H "X-API-Key: ..."
```

## What held up (all live-verified)

- **Wire contract**: `duckbrain.ready.v1` (with `head`, no id) opens every
  stream; changes are `duckbrain.change.v1` with `id:` = cursor; `: heartbeat`
  every 15s. Payload carries version/cursor/namespace/table/op/row/position/
  committedAt/tombstone/schemaVersion/key — matches the spec's v1 table.
- **Committed-only**: subscribed with no cursor, fired 10 writes, got 0 events
  until the 30s debounce commit landed — then all 10. Pre-commit writes are
  invisible. Ready `head` = null before first commit, then the latest cursor.
- **Cursor resume**: reconnected with cursor(ordinal 1) → replayed exactly
  ordinal 2, nothing else. Last-Event-ID header equivalent to ?cursor.
- **Restart safety**: killed the daemon, restarted it, resumed from a
  pre-restart cursor → full correct replay. No secret state, no seq reuse.
- **Ordinal derivation**: across 7 commits and 241 events, every commit's
  ordinals were contiguous 1..N, ordered by first-parent history. Verified by
  decoding every `dbch1.` cursor (base64url of canonical JSON `{v,ns,commit,ordinal}`).
- **Loud failures**: `not-a-cursor`/wrong-version → 400 INVALID_CURSOR;
  impossible ordinal → 400 "does not name a committed change record";
  nonexistent commit → 410 CHANGE_CURSOR_GONE with resync guidance;
  cursor cross-namespace → 400; unknown table/ops token → 400 INVALID_SUBSCRIPTION;
  no key → 401; wrong-namespace grant → 403.
- **Auth filtering**: scoped token (namespace grant) denied 403 on ungranted ns;
  analyst-role token subscribed fine where granted.
- **Delete events**: tombstone arrives as op=delete with a full tombstone row
  image and `key:{id}` — never `row:null`.
- **Overload resilience**: 500-write bursts through a 100 rpm rate limiter →
  429s, ledger stayed exactly = acked 201s, no corruption, no lost acked rows.

## What broke (see board rows DF-0925-01..06)

1. **Replay ignores the `ops=` filter (P1, DF-0925-01)** — resuming a
   `?ops=delete` subscription replayed 241 inserts + 1 delete. Live filtering
   is correct; replay applies none. A resuming consumer asking only for
   deletes receives every insert ever committed.
2. **Data/audit split-commit (P1, DF-0925-02)** — one 201-acked write landed
   its data row in commit N and its audit record in commit N+1 (+30s): the
   row is invisible to subscribers for up to 30s, and commit N permanently
   has a data row with no accepted audit record at that ref. Root cause:
   `asyncCommit` (src/git/autocommit.ts:194) is not fenced by the namespace
   writer lock (src/serialization/lock.ts) that orders the appends.
3. Docs drift (P2/P3): SUPA-5 spec + positioning matrix still say "Planned"
   while the feature ships and works; as_of/asOf doc gaps; token
   --auth-file cannot bootstrap a fresh store.
   — Resolved 2026-09-25 (DF-0925-03): SUPA-5 spec + positioning matrix now
   mark the change feed shipped with evidence and known issues (DF-0925-01/02).

## Numbers (Step 2b / perf law)

| Operation | Warm | Cold |
|---|---|---|
| Subscribe → ready frame | 68 ms ± 4 ms (n=10) | ~1 s incl. Node boot |
| POST /api/memories (201) | 18 ms ± 7.6 ms (n=20) | n/a (same proc) |
| Write ack → change event visible | 28 ms ack → 9.2 s event | — |

The 9.2 s write→event latency is the **30s commit debounce** (gitBatching.
maxSeconds), not a feed defect — the spec trades immediacy for committed-only
delivery and says so. For a user: a subscriber sees writes up to ~30s after
the write ack. That is documented behavior, not a finding.

Nothing felt slow enough for a PERF row beyond the numbers above.

## Right way for the next agent

1. Always pass `--auth=apikey` AND `--auth-file` on scratch daemons; mint the
   store with `token` first (it refuses to create one — see DF-0925-06).
2. Decode cursors with `base64url(canonical-json)` — they are unsigned and
   debuggable by design.
3. Do not trust replay-side filtering until DF-0925-01 closes: treat a
   reconnected stream as "all tables/ops" regardless of query params, or
   re-subscribe without a cursor and resnapshot via GET /api/memories.
4. Consumers must tolerate the ≤30s committed-only latency window; use the
   ready `head` to detect "no new commits" vs "no events yet".
