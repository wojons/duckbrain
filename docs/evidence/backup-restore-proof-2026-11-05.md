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

## Defect 2 — FIXED 2026-11-06 (S3-PULL-INTEGRITY-001)

The reproduction above is the pre-fix transcript: the object was corrupted,
`pull` wrote it, the engine printed `0 failed`. Two things were missing, and
both are now in place.

**1. The download is verified before it is written.** Each body is checked
against (a) the listing's size, (b) the namespace's published checksum ledger,
(c) a single-part ETag md5, (d) the local manifest hash while its version token
still holds. A mismatch names the key, writes nothing, and makes `sync` exit
nonzero; objects with no evidence at all are restored but counted as
`unverified` and reported.

**2. The push publishes the checksum ledger** the pull needs, at
`<prefix>/<ns>/.s3state/checksums.json`. Without it a fresh machine has no
authority: a server-side overwrite yields a *self-consistent* ETag (the bucket
derives it from the bytes it now holds), so an md5 tier alone calls the garbage
"verified". The ledger is our own sha256 per path, written by the same push
that uploaded the objects.

### The control now fires at the ENGINE

`AWS_PROFILE=duckbrain scripts/restore-proof.sh --namespaces hermes --fault corrupt-one`

```
[restore-proof] remote object count == baseline files + one checksum ledger per namespace (15) — PASS
{"corrupted":"restore-proof/20261106T022241Z/hermes/event/2026-11/current.jsonl","bytes":67137}
[S3] pull hermes/event/2026-11/current.jsonl FAILED (integrity): ledger-sha256: sha256 eba9b757…73e6e != ledger af1037f5…b4a24 — corrupt bytes NOT written [key restore-proof/20261106T022241Z/hermes/event/2026-11/current.jsonl]
[S3] pull hermes: 1 object(s) NOT restored (13 restored, 13 verified, 0 unverified)
[S3] pull hermes: downloaded=13 skipped=0 verified=13 unverified=0 failed=1 in 3360ms
  NOT RESTORED restore-proof/20261106T022241Z/hermes/event/2026-11/current.jsonl [verification] ledger-sha256: …
Sync complete: 1 attempted, 0 succeeded, 1 failed
[restore-proof] restore wall clock: 5s (engine exit 1)
[restore-proof] NEGATIVE CONTROL: PASS — the ENGINE refused the faulted object (pull exit 1) and named restore-proof/20261106T022241Z/hermes/event/2026-11/current.jsonl in its own output
[restore-proof] NEGATIVE CONTROL RESULT: PASS — fault 'corrupt-one' was caught AT THE ENGINE (exit 1, key named, corrupt bytes never written).
```

Step 6 then reports the file as missing (`baseline-only=1 restored-only=0`),
which is the correct consequence: the restore is incomplete because the engine
refused to fabricate it. Exit 1 is the EXPECTED outcome of a `--fault` run.

### The clean run stays green

`AWS_PROFILE=duckbrain scripts/restore-proof.sh --namespaces hermes`

```
[restore-proof] remote object count == baseline files + one checksum ledger per namespace (15) — PASS
[S3] pull hermes: downloaded=14 skipped=0 verified=14 unverified=0 failed=0 in 3030ms
Sync complete: 1 attempted, 1 succeeded, 0 failed
[restore-proof] namespace list: PASS (hermes )
[restore-proof] file count: PASS (14 files)
[restore-proof] per-file sha256 (ALL 14 files): PASS — no differences
[restore-proof] known-key read: PASS (3703 bytes served from the restored tree)
[restore-proof] PASS — restore is byte-identical for 14 files across 1 namespace(s), and a scratch daemon read a known key out of the restored tree.
exit status 0
```

Both runs above are from the fixed tree on branch `wt/S3-PULL-INTEGRITY-001`
(2026-11-06T02:22Z). The ledger object is metadata: 14 data files + 1 ledger =
15 remote objects, and the restored tree still holds exactly 14 files.

### Fresh machine with neither ETag nor ledger

Stated rather than papered over: with no ledger entry and no usable ETag
(multipart ETag, or a namespace pushed before the ledger existed) the bytes
**cannot be proven**. They are restored — a DR restore must work on a machine
that has nothing — and the run says so: `unverified=<n>` on the per-namespace
line, the keys listed, and a warning that the bytes are trusted, not proven.
One push fixes it permanently (the ledger travels with the next push).

### What this does NOT prove

- **Not tamper-proofing.** The ledger is unsigned and lives in the same bucket:
  anyone who can rewrite an object can rewrite its ledger entry too. This
  detects corruption and accidental/mid-flight damage, not a malicious writer.
- **A missing object is still only caught by the comparison.** `--fault
  delete-one` removes the object; a pull cannot "verify" bytes that do not
  arrive, so the run is caught by the file-count/sha256 step, not by the
  engine. Fixing that needs a manifest-completeness check (ledger entry present
  on the remote but no object) — filed as a follow-up, not claimed here.
- **Ledger cost scales with the namespace.** `scheduler` (258k files) would
  publish a ~25 MB ledger fetched on every pull; measured only on `hermes`
  (15 objects) here.

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

## Resolved: S3-DEADLINE-001 — work-derived deadline + bounded concurrency

The two defects above were filed as `S3-DEADLINE-001` (deadline) and
`S3-PULL-INTEGRITY-001` (checksums). This section records the closing evidence
for the **deadline** row; the checksum defect is a separate row.

### What changed (`src/s3/sync.ts`)

- `S3_SYNC_NAMESPACE_DEADLINE_S` (default 300) is now the **no-progress
  window**, re-armed every time an object completes, instead of a total
  wall-clock cap. `NamespaceDeadline` runs two clocks: the stall window (a
  hang — S3-GIT-007's epoll case, a black-holed endpoint) and a total
  allowance derived from the work (`syncDeadlineBudgetSeconds` =
  window + objects × 0.53 s × 3 headroom). Both abort the in-flight SDK calls
  before the lock is released and the error **names the namespace and the
  progress reached**.
- Transfers run in a bounded pool — `S3_SYNC_CONCURRENCY`, default 8, clamped
  1..32 — instead of strictly sequentially (`runPool` in `src/s3/sync.ts`).
- `scripts/restore-proof.sh` no longer exports `S3_SYNC_NAMESPACE_DEADLINE_S=1800`.
  That workaround hid the defect it had just found: the proof now runs under
  the shipped defaults, which is the only version of the proof that means
  anything.

### Control that fails on the pre-fix engine

Same scenario, both engines, 40 objects × 60 ms of PUT work, 1 s window
(`syncNamespace(..., "push")`): pre-fix `origin/main` `src/s3/sync.ts` aborts —
`Error: sync deadline exceeded after 1s` — while the fixed engine uploads all
40 (`uploaded=40`, 2.4 s of work). The new suite pins it:
`src/s3/sync-deadline-budget-s3deadline001.test.ts`.

### The stuck case still aborts (black-holed endpoint, real SDK)

```
$ env DUCKBRAIN_CONFIG_PATH=.../duckbrain.config.json \
      DUCKBRAIN_NAMESPACES_PATH=.../namespaces \
      S3_SYNC_NAMESPACE_DEADLINE_S=5 \
      node bin/duckbrain.js s3 sync probe push     # endpoint http://10.255.255.1:9000
[S3] sync probe timed out after 5s (S3-GIT-007)
Error: sync deadline exceeded after 5s for namespace probe (no progress for 5s; 0/0 objects transferred, 5s elapsed)
EXIT=1
```

### End-to-end restore under SHIPPED defaults (no override anywhere)

```
$ env -u S3_SYNC_NAMESPACE_DEADLINE_S -u S3_SYNC_CONCURRENCY \
      AWS_PROFILE=duckbrain scripts/restore-proof.sh --namespaces chat-archive
[restore-proof] sync deadline: shipped default (work-derived)s per namespace
[restore-proof] copied chat-archive: 617 files, 156444434 bytes
[S3] push chat-archive: uploaded=617 downloaded=0 skipped=0 in 37410ms
[restore-proof] remote object count == baseline file count (617) — PASS
[restore-proof] local source tree removed: .../source/namespaces does not exist
[S3] pull chat-archive: downloaded=617 skipped=0 in 50719ms
[restore-proof] namespace list: PASS (chat-archive )
[restore-proof] file count: PASS (617 files)
[restore-proof] per-file sha256 (ALL 617 files): PASS — no differences
[restore-proof] known-key read: GET /api/memories/key/chats/karahermes-set/2026-11-04/part-10?namespace=chat-archive -> HTTP 200
[restore-proof] known-key read: PASS (37978 bytes served from the restored tree)
[restore-proof] MEASURED RTO (largest namespace exercised): chat-archive — 156444434 bytes / 617 files restored in 50.7s
[restore-proof] PASS — restore is byte-identical for 617 files across 1 namespace(s)
```

Measured RTO for `chat-archive` (the namespace that could not be restored at
all under the old default): **50.7 s pull / 38 s push**, 12.17 files/s — the
same namespace was 277.4 s pull / 329.8 s push and *aborted at 570 of 617*
before the fix. The throwaway prefix was deleted by the script's trap.

### What this does NOT prove

- `scheduler` (258,674 syncable objects ≈ 5.9 h at the measured rate) and the
  other large namespaces were **not** transferred end to end; the deadline now
  allows them, the wall clock was not available here. The projection above is
  labelled as a projection.
- The whole-run wrapper cap `S3_SYNC_ALL_DEADLINE_S` (3600 s,
  `scripts/s3/duckbrain-s3-native-sync.sh`) still bounds one `sync all` pass.
  Steady-state passes only move the delta, so it is not the ceiling it was —
  but a COLD full sync of `scheduler` cannot finish inside one wrapper window.
