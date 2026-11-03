# OBSDB-006 probe record — the read ledger is live; the audit read the wrong path

**Date:** 2026-11-03T23:48Z · **Row:** OBSDB-006 · **Method:** observation of the
running daemon. No restart, no writes to production data, no configuration change.

## Premise under test

> The durable read ledger has 2 rows against a 60h-uptime daemon — is read
> traffic not landing?

## What was measured

1. **Which process owns `:3000`**

   ```
   ss -ltnp | grep :3000
   LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=3856050,fd=21))
   ```

   ```
   tr '\0' ' ' < /proc/3856050/cmdline
   /usr/bin/node bin/duckbrain.js http --port 3000 --bind-all --auth=apikey \
     --rate-limit 600 --unix-socket=/tmp/duckbrain.sock --unix-socket-mode=0660 \
     --unix-socket-group=kara
   started: Tue Nov  3 17:06:06 2026
   cwd: /home/kara/duckbrain
   ```

   No `DUCKBRAIN_NAMESPACES_PATH` in `/proc/3856050/environ`, so the daemon
   resolves its namespaces path **relative to its working directory**.

2. **The file the row quoted** — `/home/kara/namespaces/.duckbrain-audit/reads.jsonl`:

   ```
   rows=2  mtime=2026-10-13 05:36:36 -0500
   {"ts":"2026-10-13T10:35:12.930Z","route":"GET /api/memories",...,"ns":"waraug-e2e","status":200,"dur_ms":8922}
   {"ts":"2026-10-13T10:36:36.945Z","route":"GET /api/memories",...,"ns":"waraug-e2e","status":200,"dur_ms":3043}
   ```

   That is a **stale data directory from an earlier deployment**, not the live one.

3. **The file the live daemon actually writes** —
   `/home/kara/duckbrain/namespaces/.duckbrain-audit/reads.jsonl`:

   ```
   rows=61379   status-401 rows=109
   sealed segments: reads.0001.jsonl … reads.0012.jsonl
   ```

4. **Live capture, proven during the probe.** Two unauthenticated GETs were
   issued (with a deliberately unloaded key, so they 401). They appear in the
   live ledger immediately:

   ```
   {"ts":"2026-11-03T23:48:54.377Z","route":"GET /api/namespaces","method":"GET","ns":null,"status":401,"dur_ms":2}
   {"ts":"2026-11-03T23:48:54.385Z","route":"GET /api/memories","method":"GET","ns":"hermes","status":401,"dur_ms":1}
   ```

   401s from before authentication are recorded too, because the ledger middleware
   is mounted ahead of the auth middleware (`src/cli/http.ts:530` vs `:532`).

## Verdict

**Not a product defect.** Read traffic is landing: 61,379 rows, rotating into 12
sealed segments, receiving rows during the probe. The read counter added by
OBSDB-001 mirrors a live, populated ledger rather than an empty one.

The failure was in the audit, not the daemon: an audit that reads a path the
daemon does not use reports **the other deployment's** silence. Same class as a
`pgrep` with the wrong pattern — the selector was never shown to select anything
before its empty output was promoted to a finding.

## Residual (filed as its own row)

The live data directory sits **inside a git checkout** (9.2 GB at
`/home/kara/duckbrain/namespaces`, ignored via `.gitignore:13`). `git clean -xdf`
in that tree would delete live memory, and the daemon's code changes under it
whenever that checkout moves. That is an operational hazard, not an observability
gap, so it does not belong in this row.
