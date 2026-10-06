# Verdict: DB-SUPA-7-528

**Task:** SUPA storage modes research note
**Evaluated:** 2026-09-18T14:35:19.613873
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m9:32AM[0m [32mINF[0m [1mscanned ~9829563 bytes (9.83 MB) in 3.01s[0m
[90m9:32AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)

- ✓ **tier2**
  - COMPLETE
  ✓ Deliver a reproducible benchmark note comparing buffered append, fsync append, O_DIRECT/direct mode feasibility, and mmap on the actual host; report latency/throughput/torn-line observations and recommendations without changing product code.: Commit 0968fce delivers docs/specs/SUPA-7-storage-modes.md (506 lines) plus checked-in harness scripts/benchmarks/storage-modes.ts (1083 lines) and scripts/benchmarks/mmap-append-probe.c (181 lines). All four modes covered: buffered append (§3.1 sys-buffered, §3.2 prod-buffered), fsync append (§3.1 sys-fsync + sys-fsync-batch100, §3.2 prod-fsync), O_DIRECT/direct feasibility (§4.1 support matrix on ext4/tmpfs/overlayfs, §4.2 contradicted SUPA-1 AC-4 assumption, §4.3 Node buffer-alignment caveats), mmap (§5 real mmap(MAP_SHARED) via C probe, msync every 100). Latency/throughput reported as p50/p95/p99/max + rec/s (§3.1-3.3) with run-to-run variance (§2.5) and independent dd cross-check (§2.6). Torn-line observations in §6: 72 SIGKILLs across 3 modes, 0 malformed lines, 0 checksum mismatches, 0 acked-but-missing. Recommendations in §9 per-profile table (buffered stays default, fsync only with fan-in batching, direct and mmap not recommended). Reproducibility verified by execution: `npx tsx scripts/benchmarks/storage-modes.ts --records 50 --warmup 10 --kill-runs 1 --seed 528 --skip-crash` exit_code=0, reproduced same host (karaHermes-mde-7840hs, Linux 7.0.0-30-generic, node v22.22.3), same mode ordering and O_DIRECT-accepted-on-tmpfs finding; crash battery run also exit_code=0 with 0 malformed/0 mismatch/0 ackMissing. No product code changed: `git show 0968fce --name-only` lists only .gitreins/tasks.yaml, docs/specs/SUPA-1-write-durability.md (single doc cross-reference link), docs/specs/SUPA-7-storage-modes.md, and the two scripts/benchmarks files — zero src/ files.
The DB-SUPA-7 benchmark note is delivered with a checked-in, independently re-run harness covering buffered/fsync/O_DIRECT/mmap modes with latency, throughput, torn-line data and recommendations, and no product code was modified.

## Summary

Judge Result: DB-SUPA-7-528

Stage tier1: PASS
    ✓ secrets: [90m9:32AM[0m [32mINF[0m [1mscanned ~9829563 bytes (9.83 MB) in 3.01s[0m
[90m9:32AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)


Stage tier2: PASS
  COMPLETE
  ✓ Deliver a reproducible benchmark note comparing buffered append, fsync append, O_DIRECT/direct mode feasibility, and mmap on the actual host; report latency/throughput/torn-line observations and recommendations without changing product code.: Commit 0968fce delivers docs/specs/SUPA-7-storage-modes.md (506 lines) plus checked-in harness scripts/benchmarks/storage-modes.ts (1083 lines) and scripts/benchmarks/mmap-append-probe.c (181 lines). All four modes covered: buffered append (§3.1 sys-buffered, §3.2 prod-buffered), fsync append (§3.1 sys-fsync + sys-fsync-batch100, §3.2 prod-fsync), O_DIRECT/direct feasibility (§4.1 support matrix on ext4/tmpfs/overlayfs, §4.2 contradicted SUPA-1 AC-4 assumption, §4.3 Node buffer-alignment caveats), mmap (§5 real mmap(MAP_SHARED) via C probe, msync every 100). Latency/throughput reported as p50/p95/p99/max + rec/s (§3.1-3.3) with run-to-run variance (§2.5) and independent dd cross-check (§2.6). Torn-line observations in §6: 72 SIGKILLs across 3 modes, 0 malformed lines, 0 checksum mismatches, 0 acked-but-missing. Recommendations in §9 per-profile table (buffered stays default, fsync only with fan-in batching, direct and mmap not recommended). Reproducibility verified by execution: `npx tsx scripts/benchmarks/storage-modes.ts --records 50 --warmup 10 --kill-runs 1 --seed 528 --skip-crash` exit_code=0, reproduced same host (karaHermes-mde-7840hs, Linux 7.0.0-30-generic, node v22.22.3), same mode ordering and O_DIRECT-accepted-on-tmpfs finding; crash battery run also exit_code=0 with 0 malformed/0 mismatch/0 ackMissing. No product code changed: `git show 0968fce --name-only` lists only .gitreins/tasks.yaml, docs/specs/SUPA-1-write-durability.md (single doc cross-reference link), docs/specs/SUPA-7-storage-modes.md, and the two scripts/benchmarks files — zero src/ files.
The DB-SUPA-7 benchmark note is delivered with a checked-in, independently re-run harness covering buffered/fsync/O_DIRECT/mmap modes with latency, throughput, torn-line data and recommendations, and no product code was modified.

Overall: PASS ✓
