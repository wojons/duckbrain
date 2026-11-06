# S3 pull completeness — evidence (S3-PULL-COMPLETENESS-001, 2026-11-06)

**Defect.** Verification added by S3-PULL-INTEGRITY-001 (301468f7) covers bytes
that ARRIVE. An object that is absent remotely produces no download, so the
per-object loop never examines it and `pull` reported success over an
incomplete backup. `restore-proof.sh --fault delete-one` was caught only by the
proof's own file-count/sha256 comparison, never by the engine.

**Mechanism.** `pullNamespace` compares the published checksum ledger
(`<prefix>/<ns>/.s3state/checksums.json`) against the remote listing before
anything is written. A ledger path with no object in the listing is a
`SyncFailure { kind: "missing" }` — key named, exit nonzero, nothing local
written or deleted — and `sync all` counts the namespace as failed through the
same channel S3-PULL-INTEGRITY-001 created. With no ledger there is nothing to
compare, so the pull states that it CANNOT claim completeness (and why).

## 1. Reproduction, pre-fix (control) — `src/s3/pull-completeness-s3pull002.test.ts` on 51a4a692

```
 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)
AssertionError: expected +0 to be 1        # stats.failed after one remote object was deleted
AssertionError: expected '' to contain 'completeness cannot be claimed'
AssertionError: expected +0 to be 1        # syncAllNamespacesResult.failed
```

The one test that passed is the clean-run control: the harness itself was not
broken, only the completeness claim was missing.

## 2. Post-fix, same test file

```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Cases: missing path named + nothing written; clean pull green (verified=2,
failed=0, ledger present); an existing local file whose object went missing is
reported and left byte-identical; no ledger => `failed=0` + "CANNOT claim
completeness"; `sync all pull` reports the namespace as failed naming the key.

## 3. Real bucket — negative control (`--fault delete-one`, hermes, 14 syncable files)

```
[S3] pull hermes/event/2026-11/current.jsonl FAILED (missing): in the checksum ledger but not in the remote listing [key restore-proof/20261106T090407Z/hermes/event/2026-11/current.jsonl]
[S3] pull hermes: 1 object(s) NOT restored (13 restored, 13 verified, 0 unverified)
[S3] pull hermes: downloaded=13 skipped=0 verified=13 unverified=0 failed=1 in 5669ms
[restore-proof] restore wall clock: 8s (engine exit 1)
[restore-proof] NEGATIVE CONTROL: PASS — the ENGINE reported as missing from the remote listing (pull exit 1) and named restore-proof/20261106T090407Z/hermes/event/2026-11/current.jsonl in its own output
[restore-proof]   engine: [S3] pull hermes/event/2026-11/current.jsonl FAILED (missing): in the checksum ledger but not in the remote listing [key restore-proof/20261106T090407Z/hermes/event/2026-11/current.jsonl]
[restore-proof] NEGATIVE CONTROL RESULT: PASS — fault 'delete-one' was caught AT THE ENGINE (exit 1, key named, no unproven bytes written).
[restore-proof] cleanup: {"bucket":"duckbrain","prefix":"restore-proof/20261106T090407Z/","deleted":14,"remaining":0}
```

## 4. Real bucket — clean run (same namespace, no fault)

```
[restore-proof] remote object count == baseline files + one checksum ledger per namespace (15) — PASS
Sync complete: 1 attempted, 1 succeeded, 0 failed
[restore-proof] restore wall clock: 6s (engine exit 0)
[restore-proof] === 6/8 prove equivalence — namespace list, file count, per-file sha256 ===
[restore-proof] namespace list: PASS (hermes )
[restore-proof] file count: PASS (14 files)
[restore-proof] per-file sha256 (ALL 14 files): PASS — no differences
[restore-proof] known-key read: PASS (3703 bytes served from the restored tree)
[restore-proof] PASS — restore is byte-identical for 14 files across 1 namespace(s), and a scratch daemon read a known key out of the restored tree.
```

Both runs used a throwaway prefix under `restore-proof/` (deleted on exit by
the script's trap); production objects were never touched.

## 5. What this evidence does NOT prove

- The ledger only knows what the LAST push published. A namespace never pushed
  since the ledger shipped has no completeness check (the pull says so).
- Deleting an object and then re-pushing the namespace fixes the gap only
  because `computeDeltas` re-uploads any local file with no remote object; the
  pull itself never repairs a missing remote object (it reports it).
- `scripts/restore-proof.sh` was exercised on one small namespace; the large
  namespaces (scheduler, pokemon-global) remain projections, not measurements.
