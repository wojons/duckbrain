# Verdict: DB-SUPA-7-528

**Task:** SUPA storage modes research note
**Evaluated:** 2026-09-18T14:34:31.681046
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m9:32AM[0m [32mINF[0m [1mscanned ~9829563 bytes (9.83 MB) in 2.57s[0m
[90m9:32AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)

- ✓ **tier2**
  - COMPLETE
  ✓ Deliver a reproducible benchmark note comparing buffered append, fsync append, O_DIRECT/direct mode feasibility, and mmap on the actual host; report latency/throughput/torn-line observations and recommendations without changing product code.: Deliverable in commit 0968fce: docs/specs/SUPA-7-storage-modes.md (506 lines) with checked-in harness scripts/benchmarks/storage-modes.ts (1083 lines) and scripts/benchmarks/mmap-append-probe.c (181 lines). All four modes compared: buffered (§3.1 sys-buffered, §3.2 prod-buffered), fsync (§3.1 sys-fsync + sys-fsync-batch100, §3.2 prod-fsync), O_DIRECT/direct feasibility (§4.1 support matrix on ext4/tmpfs/overlayfs, §4.2 documents that SUPA-1 AC-4's tmpfs/overlayfs rejection assumption does NOT hold on this kernel, §4.3 Node buffer-alignment caveats), mmap (§5 real mmap(MAP_SHARED) via compiled C probe, msync every 100). Latency/throughput reported as p50/p95/p99/max + rec/s in §3.1, §3.2, §3.3 (3 runs incl. 256B size sensitivity). Torn-line: §6 crash battery, 72 SIGKILLs across 3 modes, 0 malformed / 0 checksum mismatch / 0 partial tail / 0 acked-but-missing. Recommendations: §9 per-profile table (agent-cron, API acks, high-rate ingest, direct, mmap). Reproducibility verified by me: ran `npx tsx scripts/benchmarks/storage-modes.ts --records 40 --warmup 4 --kill-runs 2` → EXIT=0, reproduced mode ordering, O_DIRECT accepted on tmpfs, 0 torn lines; C probe compiled with `cc -O2` and ran OK ({"ok":true,...}). No product code changed: `git show --stat 0968fce` touches only .gitreins/tasks.yaml, docs/specs/SUPA-1-write-durability.md (1-line cross-link), docs/specs/SUPA-7-storage-modes.md, and the two scripts/benchmarks/ files — no src/ or packages/ files.
The DB-SUPA-7 research note and its reproducible harness are delivered, cover all four storage modes with latency/throughput/torn-line data and recommendations, run successfully on this host, and change no product code.

## Summary

Judge Result: DB-SUPA-7-528

Stage tier1: PASS
    ✓ secrets: [90m9:32AM[0m [32mINF[0m [1mscanned ~9829563 bytes (9.83 MB) in 2.57s[0m
[90m9:32AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)


Stage tier2: PASS
  COMPLETE
  ✓ Deliver a reproducible benchmark note comparing buffered append, fsync append, O_DIRECT/direct mode feasibility, and mmap on the actual host; report latency/throughput/torn-line observations and recommendations without changing product code.: Deliverable in commit 0968fce: docs/specs/SUPA-7-storage-modes.md (506 lines) with checked-in harness scripts/benchmarks/storage-modes.ts (1083 lines) and scripts/benchmarks/mmap-append-probe.c (181 lines). All four modes compared: buffered (§3.1 sys-buffered, §3.2 prod-buffered), fsync (§3.1 sys-fsync + sys-fsync-batch100, §3.2 prod-fsync), O_DIRECT/direct feasibility (§4.1 support matrix on ext4/tmpfs/overlayfs, §4.2 documents that SUPA-1 AC-4's tmpfs/overlayfs rejection assumption does NOT hold on this kernel, §4.3 Node buffer-alignment caveats), mmap (§5 real mmap(MAP_SHARED) via compiled C probe, msync every 100). Latency/throughput reported as p50/p95/p99/max + rec/s in §3.1, §3.2, §3.3 (3 runs incl. 256B size sensitivity). Torn-line: §6 crash battery, 72 SIGKILLs across 3 modes, 0 malformed / 0 checksum mismatch / 0 partial tail / 0 acked-but-missing. Recommendations: §9 per-profile table (agent-cron, API acks, high-rate ingest, direct, mmap). Reproducibility verified by me: ran `npx tsx scripts/benchmarks/storage-modes.ts --records 40 --warmup 4 --kill-runs 2` → EXIT=0, reproduced mode ordering, O_DIRECT accepted on tmpfs, 0 torn lines; C probe compiled with `cc -O2` and ran OK ({"ok":true,...}). No product code changed: `git show --stat 0968fce` touches only .gitreins/tasks.yaml, docs/specs/SUPA-1-write-durability.md (1-line cross-link), docs/specs/SUPA-7-storage-modes.md, and the two scripts/benchmarks/ files — no src/ or packages/ files.
The DB-SUPA-7 research note and its reproducible harness are delivered, cover all four storage modes with latency/throughput/torn-line data and recommendations, run successfully on this host, and change no product code.

Overall: PASS ✓
