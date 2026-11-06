# Backup/restore proof — 2026-11-05

Row: **BACKUP-RESTORE-PROOF-001** (P1). Purpose: the S3 durability story had
never been exercised — push/pull, manifests and the lock were enforced, but no
run in this repo had ever deleted a local tree, restored it from the object
store, and compared the result byte for byte.

Script under test: `scripts/restore-proof.sh` (helper:
`scripts/proofs/restore-proof-s3.mjs`). Everything below is a real run against
the production bucket `s3://duckbrain` under a **throwaway prefix**, using real
namespaces copied read-only from `/home/kara/duckbrain/namespaces`.

## Verdict

PASS on every criterion of the row, plus two defects found while proving it:

1. **The shipped 300 s per-namespace sync deadline makes any namespace above
   ~560 objects unrestorable** — reproduced (chat-archive, 617 objects, aborted
   at 570 after 300 s). RTO is not measurable at all under defaults for 7 of
   the 12 largest namespaces; the proof raises the deadline to run.
2. **`pull` reports success while writing corrupted bytes**: with one remote
   object overwritten (same length, different content) the engine printed
   `1 succeeded, 0 failed` and served the corrupt file through HTTP. Only the
   proof's sha256 comparison caught it.

Both are filed as follow-up rows (see "Gaps"). The restore path itself is
correct: content is byte-identical, the namespace list is rebuilt from the
remote alone, and a scratch daemon serves a known key out of the restored tree.

## What ran

```bash
# macOS/Linux, repo checkout, credentials via ~/.aws/credentials profile
AWS_PROFILE=duckbrain scripts/restore-proof.sh --namespaces "hermes chat-archive"

# negative control (must FAIL)
AWS_PROFILE=duckbrain scripts/restore-proof.sh --namespaces hermes --fault corrupt-one
```

Environment: Hetzner object storage (`https://hel1.your-objectstorage.com`,
bucket `duckbrain`), DuckBrain CLI from `bin/duckbrain.js` (tsx fallback, no
`dist/`), Node 22.22.3, host `/home/kara/duckbrain` (live daemon untouched on
`:3000`).

## Pass transcript (verbatim excerpts, one run)

```
[restore-proof] remote      : s3://duckbrain/restore-proof/20261105T234916Z  (throwaway — deleted on exit)
[restore-proof] sync deadline: 1800s per namespace (shipped default is 300s — see the evidence doc)

[restore-proof] === 1/8 copy the real namespaces into a scratch root (source is read-only) ===
[restore-proof] copied hermes: 14 files, 2621722 bytes
[restore-proof] copied chat-archive: 617 files, 156444434 bytes

[restore-proof] === 2/8 baseline — sha256 of EVERY syncable file before anything moves ===
[restore-proof] baseline manifest: 631 files, 159066156 bytes hashed (sha256sum, sorted by path)

[restore-proof] === 3/8 push to the throwaway prefix (pre-restore remote census must be 0) ===
[restore-proof] remote before push: {"bucket":"duckbrain","prefix":"restore-proof/20261105T234916Z/","objects":0,"bytes":0,"sample":[]}
[S3] push hermes: uploaded=14 downloaded=0 skipped=0 in 11333ms
[S3] push chat-archive: uploaded=617 downloaded=0 skipped=0 in 329817ms
[restore-proof] remote after push: {"bucket":"duckbrain","prefix":"restore-proof/20261105T234916Z/","objects":631,"bytes":159066156,...}
[restore-proof] remote object count == baseline file count (631) — PASS

[restore-proof] === 4/8 DELETE the local tree ===
[restore-proof] local source tree removed: .../source/namespaces does not exist

[restore-proof] === 5/8 restore with 'sync all pull' into an EMPTY root (namespace list comes from the remote) ===
[S3] pull complete: 2 namespaces, 631 files transferred
[S3] pull chat-archive: downloaded=617 skipped=0 in 277385ms
[S3] pull hermes: downloaded=14 skipped=0 in 6467ms
Sync complete: 2 attempted, 2 succeeded, 0 failed
[restore-proof] restore wall clock: 287s

[restore-proof] === 6/8 prove equivalence — namespace list, file count, per-file sha256 ===
[restore-proof] namespace list: PASS (chat-archive hermes )
[restore-proof] file count: PASS (631 files)
[restore-proof] per-file sha256 (ALL 631 files): PASS — no differences

[restore-proof] === 7/8 read a known key through a scratch daemon on port 28769 ===
[restore-proof] health: HTTP 503 {"status":"degraded",...}   # embeddings deliberately unconfigured
[restore-proof] daemon namespace census: chat-archive hermes
[restore-proof] daemon namespace list == restored namespaces: PASS
[restore-proof] known-key read: GET /api/memories/key/projects/auger/xml-spec/2026-11-05-sg3-aug127-aug123?namespace=hermes -> HTTP 200
[restore-proof] known-key read: PASS (1567 bytes served from the restored tree)

[restore-proof] === result ===
[restore-proof] PASS — restore is byte-identical for 631 files across 2 namespace(s), and a scratch daemon read a known key out of the restored tree.
```

Cleanup (trap, runs on pass and fail): prefix deleted, whole
`restore-proof/` root re-listed afterwards → `{"objects":0,"bytes":0}`.

## The control — proof that the proof can fail

One remote object was overwritten with **same-length garbage**
(`hermes/event/2026-11/current.jsonl`, 59,235 bytes) after the push, so no file
count or size check could notice:

```
[restore-proof] === 3b/8 INJECT FAULT (corrupt-one) — the negative control ===
{"corrupted":"restore-proof/20261106T000319Z/hermes/event/2026-11/current.jsonl","bytes":59235}

[S3] pull complete: 1 namespaces, 14 files transferred
Sync complete: 1 attempted, 1 succeeded, 0 failed        <-- engine reports SUCCESS
[restore-proof] namespace list: PASS (hermes )
[restore-proof] file count: PASS (14 files)
[restore-proof] per-file sha256 MISMATCH — the restore is NOT byte-identical:
-4f57a4a1...eeb785a  ./hermes/event/2026-11/current.jsonl
+f801bf29...0f8180b  ./hermes/event/2026-11/current.jsonl
[restore-proof] divergent manifest lines: baseline-only=1 restored-only=1
...
[restore-proof] FAIL — 1 criterion/criteria failed. This is the proof doing its job
exit status 1
```

`--fault delete-one` is the sibling control (removes an object; the comparison
then reports the file as missing).

## Defect 1 — the 300 s deadline caps restores far below the fleet's data

First run, **unmodified default** (`S3_SYNC_NAMESPACE_DEADLINE_S` unset):

```
[S3] sync chat-archive timed out after 300s (S3-GIT-007)
Error: sync deadline exceeded after 300s
[restore-proof] cleanup: {"bucket":"duckbrain","prefix":"restore-proof/20261105T234321Z/","deleted":570,"remaining":0}
exit status 1
```

570 of 617 objects made it in 300 s (0.53 s/object). The deadline is per
namespace, so a namespace whose object count exceeds `300 / per_object_seconds`
can **never** be restored with shipped defaults — on this host that ceiling is
~560 objects, while the live root holds `scheduler` 258,672, `pokemon-global`
49,631, `fleet-quality` 29,091, `coding-hermes` 20,072 and 3 more above it.
The deadline is measured against a wall clock, so the fix is either a
count-derived deadline or concurrent transfers (the engine is sequential).

## Defect 2 — `pull` cannot detect a corrupt object

The control above is also the reproduction: the object was corrupted, `pull`
downloaded it, the CLI reported `0 failed`, and `GET /api/memories/key/...`
served the corrupt content. The remote listing's ETag is only used as a
version token when the local manifest already recorded one; a fresh machine has
no manifest, so nothing compares the downloaded bytes to anything. A restore
that verifies nothing turns silent remote corruption into live memory.

## RTO (measured, then projected)

| namespace | files | bytes | push | pull (engine) |
|---|---|---|---|---|
| chat-archive | 617 | 156,444,434 | 329.8 s | 277.4 s |
| hermes | 14 | 2,621,722 | 11.3 s | 6.5 s |
| **total** | **631** | **159,066,156** | **342 s** | **287 s wall clock** |

- Measured throughput: **2.2 objects/s pull** (0.449 s/object),
  564 kB/s; push 1.9 objects/s (0.535 s/object), 474 kB/s — over TLS to
  `hel1.your-objectstorage.com` from one vCPU, sequential transfers.
- **Measured RTO for the largest namespace exercised**: `chat-archive`,
  156 MB / 617 objects → **~4.6 min pull** (5.5 min push).
- **Projection (not measured)**: `scheduler` (258,672 objects / 2.28 GB)
  ≈ **32 h**; `pokemon-global` (49,631) ≈ 6.2 h; `fleet-quality` (29,091)
  ≈ 3.6 h. The projection is `objects x 0.449 s` — the same sequential cost —
  and it assumes the deadline is raised (defect 1).

The honest DR statement for the runbook: *the store can be restored today only
namespace-by-namespace, at ~2 objects/s; the full fleet (~9 GB across 291
namespaces, 500k+ objects in the largest three) is a multi-day restore on one
sequential worker, or a few hours per large namespace with a raised deadline.*

## What this proof does NOT cover

1. **The largest namespaces are not restored in-run** (`scheduler`,
   `coding-hermes`, `fleet-quality`): at the measured rate that is 6–32 hours
   per namespace. Projections above are labelled as such, not measured.
2. **Git history is not restored.** `pull` brings JSONL + manifests only;
   `.git` never travels. A real DR also needs the git-side restore
   (`s3://duckbrain/current/git/<ns>`, the daily push) — out of scope here.
3. **Credentials are assumed**, not provisioned: the script uses the AWS SDK
   default chain (`AWS_PROFILE=duckbrain` in the evidence runs). Nothing was
   written to `duckbrain.config.json` in the repo.
4. **The scratch daemon runs `--auth=none`** (no auth store, embeddings
   unconfigured so `/health` answers 503 "degraded"): the read proves the data
   plane, not the auth plane.
5. **The engine's own failure accounting is not trusted** (defect 2) — the
   proof compares bytes itself, which is why it caught the corruption.

## Safety (why this could not touch production data)

- The helper refuses any prefix that does not start with `restore-proof/`:
  `node scripts/proofs/restore-proof-s3.mjs delete-prefix --bucket duckbrain
  --prefix duckbrain/hermes/` → `REFUSED ... this helper only touches
  throwaway restore-proof prefixes` (exit 2).
- The proof asserts the prefix is EMPTY before pushing, so it can never
  "restore" a namespace whose objects it did not write.
- The trap deletes the prefix and the scratch tree on pass AND fail; the
  `restore-proof/` root was re-listed as `objects: 0` afterwards.
- No `git clean`, no `rm` outside the scratch work dir, no restart of the live
  daemon on `:3000`, no writes under `/home/kara/duckbrain/namespaces`.
