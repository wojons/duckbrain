# SUPA-7 — Storage Modes: Measured Write-Path Characteristics

- **Board row:** DB-SUPA-7 (storage modes research note)
- **Contract authority:** `docs/specs/SUPA-1-write-durability.md` — this note supplies
  device-dependent numbers only; it changes no mechanism, no default and no code.
- **Companion docs:** `docs/api/http-api.md` (§Write Durability (SUPA-1)),
  `docs/specs/SUPA-2-serialization.md` (block framing + single-writer queue)
- **Harness (checked in):** `scripts/benchmarks/storage-modes.ts`,
  `scripts/benchmarks/mmap-append-probe.c`
- **Status:** measurement record — reproducible on this host; **not** a portability claim

Measured 2026-09-18 (UTC) on `karaHermes-mde-7840hs`. Every number below came from a run
of the checked-in harness on this host, or from a command quoted next to it. Anything not
measured is labelled **expected (not measured)**.

## 1. Purpose and relationship to SUPA-1

SUPA-1 fixes the *mechanisms* — buffered / fsync / direct, the barrier inventory, the
header and health surface — and explicitly leaves the numeric cost shape to this note
(SUPA-1 §Non-Goals: "No device-dependent latency benchmark … measured numbers on real
devices are the deliverable of DB-SUPA-7").

What this note adds:

1. Measured latency distributions and throughput for each mode, at two record sizes,
   through **the shipped appenders** (`appendToJsonl`, `appendJsonlDurable`,
   `appendJsonlDirect`) and at the syscall level around them.
2. A measured support matrix for `O_DIRECT` on the three filesystems that matter here
   (ext4, tmpfs, overlayfs) — with one result that **contradicts a SUPA-1 assumption**
   (§4.2).
3. Bounded crash / torn-line observations per mode, with the limits of what a `SIGKILL`
   experiment can and cannot prove (§6).
4. Per-profile mode recommendations that **preserve SUPA-1's current contract**: buffered
   stays the default for normal/agent traffic, fsync stays the acknowledged durability
   mode, direct stays gated behind SUPA-2 framing (§9).

Nothing in this note changes SUPA-1's implementation or defaults.

## 2. Method

### 2.1 What each measured mode actually is

| id | what runs | relationship to product code |
|---|---|---|
| `sys-buffered` | `open(a)` → `write` → `close` per record | exactly what `fs.appendFileSync` does (`src/storage/jsonl.ts:330`); no barrier |
| `sys-fsync` | `open(a)` → `write` → `fdatasync` → `close` per record | the fd protocol of `appendJsonlDurable` (`src/storage/durability.ts`) |
| `sys-fsync-batch100` | one `open`, 100 writes, **one** `fdatasync`, `close` | mirrors `appendFsyncBatch` (`src/serialization/namespaceWriter.ts:253-300`) — SUPA-2 fan-in amortization |
| `sys-odirect` | `open(O_DIRECT\|O_CREAT\|O_WRONLY\|O_APPEND)` → `write` one 4 KiB frame → `fdatasync` → `close` | the syscall shape of `appendJsonlDirect` |
| `sys-odirect@tmpfs` | same, on `/dev/shm` | SUPA-1 AC-4 "unsupported filesystem" arm |
| `sys-mmap-nomsync` | `mmap(MAP_SHARED)` memcpy append, no barrier | C probe (`scripts/benchmarks/mmap-append-probe.c`); Node has no file-mmap API |
| `sys-mmap-msync100` | same + `msync(MS_SYNC)` on the touched pages every 100 records | mmap analogue of one `fdatasync` per batch |
| `prod-buffered` | the real `appendToJsonl` | shipped code, includes schema validation + rotation check |
| `prod-fsync` | the real `appendJsonlDurable` | shipped code |
| `prod-direct` | the real `appendJsonlDirect` + `frameJsonlRecord` | shipped code |
| `prod-direct@tmpfs` | `prod-direct` on `/dev/shm` | SUPA-1 AC-4 arm through the appender |

### 2.2 Workload, sample size, units

- **Records measured:** 2 000 per mode, plus a **200-record warmup** that is excluded from
  every statistic. Product appenders run their warmup in a separate partition file so the
  measured chunk starts empty.
- **Record size:** target 1 024 bytes/line; **effective measured line = 1 025 B** for all
  three product modes (`logical_bytes / records`). A second workload at target 256 B is
  reported in §3.3 for size sensitivity. For context, live DuckBrain partitions carry
  ~231 B–9.6 KB lines (measured over the 391 lines of
  `namespaces/hermes-memory/config/2026-08/current.jsonl`: min 231 B, p50 709 B,
  p95 1 403 B, max 9 595 B), so 1 025 B is mid-range, not a best case.
- **Units:** nanoseconds from `process.hrtime.bigint()` (Node) / `CLOCK_MONOTONIC` (C probe);
  distributions are p50 / p95 / p99 / max taken over the 2 000 measured samples;
  throughput = 1e9 / mean latency of those samples.
- **Direct mode space accounting:** `logical_bytes` is the JSONL payload; `physical_bytes`
  is what lands on disk (4 096 B/record for direct, because every record is padded to a
  full `DURABILITY_BLOCK_SIZE` frame).
- **Arms that write the warmup into the measured file** (`sys-*`) report `physical_bytes`
  including the 200 warmup records; the per-record figures quoted below are always
  `physical_bytes / 2 000` only where the warmup was isolated (product arms).

### 2.3 Host and filesystem context

```
host            karaHermes-mde-7840hs
kernel          Linux 7.0.0-30-generic (x86_64)
cpu             AMD Ryzen 7 7840HS (16 threads)
node            v22.22.3
bench dir       /tmp/...            -> /dev/nvme0n1p2  ext4  (NVMe SSD, rot=0, 512 B logical block)
tmpfs arm       /dev/shm            -> tmpfs rw,nosuid,nodev,inode64,usrquota
overlayfs arm   docker debian:stable-slim rootfs -> overlay
partition       /dev/nvme0n1p2, 1.8 TiB, 81% used at run time
load average    4.38 / 4.59 / 10.92 at start; 5.58 / 5.26 / 10.07 at end (16 threads)
```

The host is a **shared fleet box**: other agents and cron ticks write to the same NVMe
throughout. Sync latencies therefore carry fleet I/O contention, and they vary run to run
(§2.5). All latency figures should be read as "under concurrent fleet load on this host",
not as device spec numbers.

### 2.4 Safety envelope

- Every byte is written under `<tmpdir>/db-supa-7-bench*`; the harness **refuses to run**
  outside `os.tmpdir()`. No production namespace path is ever opened, no config is written.
- Bounded: 2 000 records × ~1 KB per mode, 4 KiB frames for direct, a 32 MB tmpfs scratch.
- No network, no AWS, no S3. No git operations. No `sudo`, no cache dropping, no kernel knobs.
- The harness removes its workdir at the end unless `--keep` is passed; both `/dev/shm`
  scratch directories are removed by the harness. Crash-battery children are the harness
  itself (`--child-writer`), so no external process is spawned beyond `cc` (mmap probe) and
  the worker children.

### 2.5 Repeatability, and the run-to-run variance you must expect

The documented command was run **three times**: twice at 1 024 B records (run 1, run 2) and
once at 256 B (run 3). Same seed (`--seed 528`) ⇒ identical kill-timing sequence.

| run | date (UTC) | records/mode | wall time phase A (syscall) | wall time phase B (appenders) |
|---|---|---|---|---|
| 1 (primary) | 2026-09-18T14:15:06Z | 2000 + 200 warmup | 75.0 s | 87.4 s |
| 2 (repeat) | 2026-09-18T14:21:51Z | 2000 + 200 warmup | 21.4 s | 71.4 s |
| 3 (256 B) | 2026-09-18T14:23:43Z | 2000 + 200 warmup | 99.3 s | 100.6 s |

Identical work took 21–99 s depending on concurrent fleet I/O. **Per-record sync latency
varies ~4× between identical runs** (`sys-fsync` p50 13.65 ms → 3.46 ms; `sys-odirect` p50
13.93 ms → 3.44 ms), while barrier-free paths are stable (`sys-buffered` p50 4.97 → 5.77 µs;
`sys-mmap-nomsync` p50 40 → 50 ns). Treat any single sync-latency figure as a point sample
of a shared-device distribution, and treat the *ratios* between barrier and non-barrier
paths as the durable finding.

### 2.6 Independent cross-check of the sync cost

To confirm the harness is not the bottleneck, the same device was measured with `dd`
(4 KiB writes, 200 ops) immediately after run 1:

```
$ dd if=/dev/zero of=/tmp/dd-dsync.bin bs=4096 count=200 oflag=dsync
200+0 records out
819200 bytes (819 kB, 800 KiB) copied, 1.32313 s, 619 kB/s      -> ~6.6 ms per sync write
$ dd if=/dev/zero of=/tmp/dd-direct-dsync.bin bs=4096 count=200 oflag=direct,dsync
819200 bytes (819 kB, 800 KiB) copied, 1.11759 s, 733 kB/s      -> ~5.6 ms per sync write
$ dd if=/dev/zero of=/tmp/dd-buf.bin bs=4096 count=200
819200 bytes (819 kB, 800 KiB) copied, 0.000758793 s, 819 MB/s  -> ~3.8 µs per buffered write
```

The independent tool agrees on the order of magnitude (single-digit ms per synchronous
write; microseconds buffered), so the barrier cost measured by the harness is the device
and the queue — not harness overhead.

## 3. Results

### 3.1 Syscall-level (run 1, 1 024 B records, 2 000 samples)

| mode | support | p50 | p95 | p99 | max | rec/s |
|---|---|---|---|---|---|---|
| `sys-buffered` | yes | 4.97 µs | 8.91 µs | 13.95 µs | 1.13 ms | 157,873 |
| `sys-fsync` | yes | 13.65 ms | 56.74 ms | 140.48 ms | 907.99 ms | 55 |
| `sys-fsync-batch100` | yes | 42.32 µs | 172.47 µs | 274.16 µs | 274.16 µs | 10,624 |
| `sys-odirect` | yes | 13.93 ms | 32.63 ms | 62.77 ms | 751.77 ms | 68 |
| `sys-odirect@tmpfs` | yes | 5.43 µs | 16.08 µs | 38.78 µs | 38.78 µs | 96,849 |
| `sys-mmap-nomsync` | yes | 40 ns | 50 ns | 2.69 µs | 26.11 µs | 4,364,906 |
| `sys-mmap-msync100` | yes | 100 ns | 4.06 µs | 84.52 µs | 27.20 ms | 5,434 |

- `sys-fsync-batch100` performed exactly **22 `fdatasync` calls for 2 200 records**
  (`extra.fdatasyncs`), i.e. one barrier per 100 records, and still delivered
  **10 624 rec/s vs 55 rec/s** for a barrier per record — a **~193× throughput difference**
  on the same device. This is the measured version of SUPA-1 AC-8's fan-in amortization.
- The batched arm's p50 (42 µs/record) is ~7× the purely buffered p50 (5 µs/record): the
  amortized barrier cost is real but no longer dominant.
- Every `sys-fsync`/`sys-odirect` distribution has a heavy tail (p99 ≈ 10× p50, max ≈ 900 ms)
  driven by fleet I/O contention, not by the harness.

### 3.2 Shipped appenders (run 1)

| mode | support | p50 | p95 | p99 | max | rec/s | logical B/rec | physical B/rec |
|---|---|---|---|---|---|---|---|---|
| `prod-buffered` | yes | 1.00 ms | 1.76 ms | 11.46 ms | 42.95 ms | 872 | 1 025 | 1 025 |
| `prod-fsync` | yes | 6.15 ms | 25.47 ms | 31.96 ms | 736.46 ms | 96 | 1 025 | 1 025 |
| `prod-direct` | yes | 23.73 ms | 43.86 ms | 79.58 ms | 484.23 ms | 36 | 1 025 | **4 096** |
| `prod-direct@tmpfs` | yes | 170.84 µs | 367.22 µs | 367.22 µs | 367.22 µs | 5 177 | 1 025 | 4 096 |

Three measured facts that matter more than the absolute numbers:

1. **`prod-buffered` is ~200× slower than `sys-buffered`** (1.00 ms vs 4.97 µs p50) with no
   barrier involved. The shipped path adds schema validation plus, on every single append,
   a rotation check that stats the file and **reads it end-to-end**
   (`resolveJsonlTargetPath` → `countLines` → `fs.readFileSync`, `src/storage/jsonl.ts:119-125`,
   called at `:330` via `:171-180`). The write itself is the cheap part.
2. **`prod-fsync` = `prod-buffered` + ~5 ms** (6.15 ms vs 1.00 ms p50): the barrier is
   ~5× the entire application-level cost of the buffered path. Cost shape per SUPA-1's
   Non-Goals expected "sub-millisecond to low-millisecond on SSD-class storage" — measured
   here: p50 3.5–17 ms, p95 25 ms (per single-record ack, unbatched).
3. **`prod-direct` costs 4 096 physical bytes per 1 025-byte record (4.0× amplification)**
   and is the slowest mode (23.73 ms p50, 36 rec/s).

### 3.3 Reproducibility across runs, and record-size sensitivity

| mode | run1 p50 | run1 rec/s | run2 p50 | run2 rec/s | run3 (256 B) p50 | run3 rec/s |
|---|---|---|---|---|---|---|
| `sys-buffered` | 4.97 µs | 157,873 | 5.77 µs | 142,524 | 5.72 µs | 137,681 |
| `sys-fsync` | 13.65 ms | 55 | 3.46 ms | 197 | 3.50 ms | 127 |
| `sys-fsync-batch100` | 42.32 µs | 10,624 | 39.27 µs | 20,063 | 38.64 µs | 14,289 |
| `sys-odirect` | 13.93 ms | 68 | 3.44 ms | 215 | 12.98 ms | 25 |
| `sys-mmap-nomsync` | 40 ns | 4,364,906 | 50 ns | 3,586,801 | 40 ns | 8,438,819 |
| `sys-mmap-msync100` | 100 ns | 5,434 | 90 ns | 27,953 | 50 ns | 5,505 |
| `prod-buffered` | 1.00 ms | 872 | 1.36 ms | 799 | 455.55 µs | 1,628 |
| `prod-fsync` | 6.15 ms | 96 | 8.35 ms | 108 | 17.42 ms | 54 |
| `prod-direct` | 23.73 ms | 36 | 22.01 ms | 42 | 25.51 ms | 36 |
| `prod-direct@tmpfs` | 170.84 µs | 5,177 | 204.46 µs | 4,786 | 235.99 µs | 3,523 |

- The two 1 024 B runs agree on **structure** (ordering of modes, ~200× buffered/validation
  gap, 4× direct space amplification), not on sync point estimates (§2.5).
- Record-size sensitivity: dropping the record from 1 025 B to ~257 B roughly **halves**
  `prod-buffered` (1.00 ms → 0.46 ms) but leaves `prod-direct` unchanged (23.73 → 25.51 ms),
  because direct pays a fixed 4 KiB frame regardless of payload size — its amplification
  becomes 16× at this record size.

### 3.4 Per-append cost grows with the base file (run 1, product modes)

p50 / p95 per 500-record bucket:

| mode | records 1-500 | 501-1000 | 1001-1500 | 1501-2000 |
|---|---|---|---|---|
| `prod-buffered` | 381.90 µs / 751.02 µs | 804.16 µs / 1.12 ms | 1.19 ms / 1.47 ms | 1.46 ms / 6.31 ms |
| `prod-fsync` | 4.71 ms / 27.83 ms | 5.19 ms / 20.19 ms | 9.74 ms / 27.29 ms | 6.67 ms / 25.36 ms |
| `prod-direct` | 21.14 ms / 39.75 ms | 22.98 ms / 47.57 ms | 24.22 ms / 44.99 ms | 31.18 ms / 43.11 ms |

`prod-buffered` p50 grows **3.8×** (381 µs → 1.46 ms) across the run with no barrier
involved. Decomposition as measured: a ~382 µs floor at the smallest base file (record
validation + serialization) plus a component that tracks the base file's size (+~1.08 ms by
the time it holds 1 MB). The mechanism is the per-append read of the whole base file; once
the file is over capacity and rotation has started, the base file never shrinks, so **the
cost does not come back down** (see §8.1 for the on-disk result).

## 4. Direct / O_DIRECT: feasibility, support status, and one contradicted assumption

### 4.1 Support matrix measured on this host

| filesystem | probe | `O_DIRECT` | evidence |
|---|---|---|---|
| ext4 (`/dev/nvme0n1p2`) | harness `sys-odirect` + `prod-direct`, 2 000 records | **accepted**, 0 errors | p50 13.93 ms; 4 096 B/record on disk |
| tmpfs (`/dev/shm`) | `sys-odirect@tmpfs` + `prod-direct@tmpfs` | **accepted**, 0 errors | 16 records → 65 536 B landed; `dd oflag=direct` exit 0, 32 768 B written |
| overlayfs (docker rootfs) | `docker run --rm --network none debian:stable-slim dd if=/dev/zero of=/root/o.bin bs=4096 count=8 oflag=direct` | **accepted**, exit 0 | 32 768 B written, `dd_exit=0` |

### 4.2 The SUPA-1 AC-4 assumption does not hold on this kernel

SUPA-1 AC-4 and its Edge Cases state that `O_DIRECT` fails on **tmpfs and overlayfs**
(`EINVAL`/`EOPNOTSUPP`), and `docs/api/http-api.md` repeats it in the error table
(`DURABILITY_UNSUPPORTED | The filesystem rejects O_DIRECT (tmpfs, overlayfs)`).

**Measured here: both accept `O_DIRECT` on Linux 7.0.0-30-generic** — through the harness,
through the shipped `appendJsonlDirect`, and independently through `dd`. Consequences:

- On this host, the fail-loud path of AC-4 cannot be exercised with tmpfs or overlayfs;
  the SUPA-1 test scenario "direct mode on unsupported filesystem" needs a different
  substrate (e.g. an overlay whose upper layer is itself `O_DIRECT`-hostile, or a fuse/NFS
  mount) before it can be considered covered here.
- Acceptance is not proof of bypass. tmpfs has no backing device, so `O_DIRECT` there is
  almost certainly a no-op flag; overlayfs forwards to its upper filesystem (ext4 here),
  which does support it. Either way **the flag being accepted tells you nothing about
  whether the page cache was bypassed** — do not read this as "direct mode works on tmpfs".
- Products should keep treating "direct supported" as a per-host probe, never as a constant.

### 4.3 Node-level caveats for direct mode

- `O_DIRECT` requires an aligned buffer, length and offset. The shipped framing
  (`frameJsonlRecord`, 4 096-byte blocks) guarantees **length and offset** alignment, and
  `O_APPEND` keeps every write boundary block-aligned. **User-space buffer alignment is not
  guaranteed by Node**: `Buffer.alloc`/`allocUnsafeSlow` give no alignment contract, and on
  this host 2 000/2 000 direct appends happened to be accepted. A host where the allocator
  hands back a less-aligned buffer would surface as `EINVAL` → `DURABILITY_UNSUPPORTED`.
  This note records a *working observation*, not a guarantee.
- Space: 4 096 physical bytes per 1 025-byte record on this workload (4.0×; 16× at 256-byte
  records). Any direct-mode namespace needs capacity planning for that.

## 5. mmap: real numbers, and why they do not change the recommendation

Node exposes no file `mmap`, so the harness compiles `scripts/benchmarks/mmap-append-probe.c`
(70 lines, `cc -O2`) and drives real `mmap(MAP_SHARED)` appends; if no C compiler is present
it falls back to a documented positional-`pwrite` proxy and labels the row `proxy`.

| arm | barrier | p50 | p95 | p99 | max | rec/s | barriers |
|---|---|---|---|---|---|---|---|
| `sys-mmap-nomsync` | none (page cache) | 40 ns | 50 ns | 2.69 µs | 26.11 µs | 4,364,906 | 0 |
| `sys-mmap-msync100` | `msync(MS_SYNC)` every 100 | 100 ns | 4.06 µs | 84.52 µs | 27.20 ms | 5,434 | 22 |

Reading it honestly:

- **mmap without a barrier is not durable**: the memcpy lands in dirty page cache — the same
  durability class as buffered mode, at 40 ns/record. Fast, and useless as a durability story.
- **mmap with a barrier is durable for the same reason `fdatasync` is**: `msync(MS_SYNC)` on
  the touched range pushes those pages to stable storage. Amortized over 100-record batches
  it measured 5 434 rec/s — i.e. **the same class as batched fsync (10 624 rec/s) and
  strictly worse**, while requiring a native addon or helper binary.
- Caveats that keep this a reference point, not a shipping plan: the probe pre-allocates the
  whole file (`ftruncate`) so no file-extension cost is included; the appended region is
  written by memcpy with no reader-visible line discipline; and the `msync` range granularity
  is page-based, not record-based. Mapping appends into an existing file also cannot express
  DuckBrain's chunk rotation.

**Recommendation: do not pursue mmap.** Batched `fdatasync` reaches the same durability class
with a smaller change and no native dependency, and measured ~2× faster.

## 6. Crash and torn-line experiments (bounded)

### 6.1 Protocol

`--child-writer <mode>` runs the harness as a child that appends records through the same
shipped appender as the parent measured. Each record carries `attributes.seq` and a
`sha256(payload)[0:16]` checksum. After **every** append the child writes its sequence number
to `acks.log` and `fdatasync`s the ack fd — i.e. the ack record itself is durable, in every
mode. That is **stricter than DuckBrain's buffered ack** (page cache only) and is paid
identically by all three modes so the comparison stays fair.

The parent waits until the data file is demonstrably growing, sleeps a randomized 60–350 ms
(deterministic from `--seed 528`), sends `SIGKILL`, then replays **every** `*.jsonl` in the
directory line by line: `JSON.parse`, required fields, re-derived checksum. Two runs ×
12 kills × 3 modes = **72 child kills** in total (24 per mode).

### 6.2 Results — run 1 (run 2 in parentheses, same qualitative result)

| mode | runs | valid records | malformed | checksum mismatch | acked | acked-but-missing | runs w/ partial tail |
|---|---|---|---|---|---|---|---|
| buffered | 12 (12) | 234 (191) | 0 (0) | 0 (0) | 234 (191) | **0 (0)** | 0 (0) |
| fsync | 12 (12) | 147 (114) | 0 (0) | 0 (0) | 144 (109) | **0 (0)** | 0 (0) |
| direct | 12 (12) | 171 (162) | 0 (0) | 0 (0) | 166 (157) | **0 (0)** | 0 (0) |

- **No malformed line, no checksum mismatch, no partial trailing line, and no acknowledged
  record missing from the data files — in any mode, in any run.** 72 `SIGKILL`s landed inside
  active write streams and none of them tore a record.
- In fsync and direct modes `valid > acked` in 9/24 and 7/24 runs respectively (e.g. fsync
  run 12: 15 records on disk, 15 acked; fsync run 1: 22 on disk, 21 acked). That is the
  **safe** direction and is consistent with the barrier-before-ack ordering: the record
  reaches the file, then the ack is written, and the kill can land between the two. The
  reverse (`acked` but absent) never happened.

### 6.3 What this does and does not prove

`SIGKILL` terminates a **process**, not the kernel: in-flight writes complete in the kernel,
page-cache pages survive, and the file system stays mounted. Therefore:

- ✅ It is evidence that the appenders do not tear records, and that acked-but-lost does not
  occur under process death — for all three modes.
- ❌ It is **not** an OS-crash or power-loss test, and it cannot discriminate buffered from
  fsync: buffered mode is inherently process-kill-safe (SUPA-1's own contract says so). The
  measured "0 acked-but-missing for buffered" is a property of the page cache, not durability.
- The buffered loss window (SUPA-1: unbounded to power loss; ≤ `gitBatching.maxSeconds`,
  default 30 s, to git/S3) remains **expected, not measured here**. Observing it needs
  `/proc/sys/vm/drop_caches` (root) or real power loss; the harness deliberately does neither.
  A future arm could `sync`-then-`drop_caches` on a scratch mount with root, but that is a
  different experiment with a different risk envelope.

## 7. Interaction with the git debounce and S3-on-commit (source facts only; no S3 called)

No S3 operation was performed in this task. The following is read from source and the local
config, and is stated as design fact, not measurement.

- **Debounce.** JSONL lands first; the git commit is batched per namespace: the first write
  schedules a commit in `gitBatching.maxSeconds` (default 30 s) and the commit fires
  immediately once `gitBatching.maxLines` (default 100) records have accumulated
  (`src/git/autocommit.ts:7-15,342-389`; `DEFAULT_PARAMS` at `:45-47`). Config here:
  `maxLines 100`, `maxSeconds 30`, `enabled true`. So the git boundary adds up to ~30 s of
  exposure on top of whatever the write mode gives, regardless of mode.
- **Commits are namespace-wide.** `commitNamespaceWithParams` runs `git add -A`
  (`src/git/autocommit.ts:309`) — everything in the namespace repo is staged, and
  `asyncChains` serializes work per namespace so two `git add -A` runs never race.
- **What the barrier buys.** In fsync/direct mode the JSONL is already durable when the ack
  is sent, so the debounced commit is history transport, not the durability mechanism
  (SUPA-1 §Contract). In buffered mode the commit *is* the second durability boundary, which
  is why its ≤30 s window is documented rather than engineered away.
- **S3-on-commit.** `maybeSyncOnCommit` is fire-and-forget: it returns immediately unless
  `s3.enabled && s3.pushOnCommit` (`src/s3/index.ts:30-55`), runs the push on a zero-delay
  timer and only logs failures. Local config is `s3.enabled: true` with
  `pushOnCommit: false`, so in this deployment the S3 hook is **inert**: the S3 remote rides
  the same debounce window only when an operator turns `pushOnCommit` on.
- **Where mode choice does not help:** because the commit and the S3 push are batched at the
  namespace level, no write mode shortens the git/S3 exposure — the only lever there is the
  debounce parameters. The barrier modes only shorten the single-node RPO of the JSONL itself.

## 8. Measured side-findings (outside the mode comparison)

These surfaced while benchmarking the shipped appenders. They are recorded here because they
dominate real write latency; they are **out of scope for DB-SUPA-7** and change nothing in
this task.

### 8.1 After a partition's `current.jsonl` reaches capacity, every append creates a new single-line file

Measured on disk after a 2 000-record run through the shipped appenders:

```
prod-buffered   files=1002  size histogram: 1025B x1000, 205000B x1, 1025000B x1
                current.jsonl: 1,025,000 B, 1000 lines  -> capacity reached
prod-fsync      same shape
prod-direct     files=1746  size histogram: 4096B x1744, 819200B x1, 1048576B x1
                current.jsonl: 1,048,576 B (256 frames, 1 MiB byte cap)
```

Mechanism (source): rotation is decided from the **base** file
(`resolveJsonlTargetPath(filePath, line)`, `src/storage/jsonl.ts:171-180`). Once
`current.jsonl` exceeds `MAX_BYTES_PER_CHUNK` (1 MiB) or `MAX_LINES_PER_CHUNK` (1 000), every
subsequent append takes the rotate branch — but the base file never changes, so it keeps
taking it — and the rotation target comes from `getNextChunkName`, which returns the next
**unused** numeric name (`src/storage/jsonl.ts:88-115`). Result: one brand-new chunk file per
record for the rest of the partition's life.

This is not a benchmark artifact — it is live in the production namespaces:

```
namespaces/coding-hermes    numeric_chunks=19798   single_line_chunks=19788   partitions with current.jsonl=12
namespaces/hermes-memory    numeric_chunks=660     single_line_chunks=659     partitions with current.jsonl=21
namespaces/coding-hermes/config/2026-08   current.jsonl=1000 lines, 10000 numeric chunk files in the directory
```

Effects, all measured above: the per-append read of the base file never goes away (§3.4
p50 1.46 ms in the last bucket), the directory grows to thousands of entries (readdir + sort
per append via `getNextChunkName`), and the git layer stages thousands of tiny files per
`git add -A` — i.e. the very loose-object bloat `src/git/autocommit.ts:7-15` already warns
about. Direct mode reaches this state faster (it rotates on the 1 MiB byte cap after
~256 records) and amplifies it with 4 KiB frames.

### 8.2 The other cost components, for the record

- `countLines` (`src/storage/jsonl.ts:119-125`) reads the entire file and splits it on every
  append — the size-dependent term in §3.4. (It filters blank lines, which is why direct-mode
  newline padding does not inflate the *line* count — it rotates on the 1 MiB byte cap
  instead.)
- The ~380 µs floor of `prod-buffered` at a small base file is record validation plus
  serialization (`MemorySchema.parse` + the round-trip guard in `serializeJsonlLine`), i.e.
  ~75× the raw `write`+`open`+`close` cost measured by `sys-buffered`.
- `prod-direct@tmpfs` (170.84 µs p50) shows that when the storage is RAM the appender's own
  overhead dominates the syscall again.

## 9. Recommendations by profile

Caveats that apply to every row: measured on this host, under fleet load, on this NVMe; sync
latency is a distribution (§2.5); **these recommendations do not change SUPA-1's defaults**.

| profile | recommended mode | measured basis | confidence | caveats |
|---|---|---|---|---|
| **agent-cron** (scheduler fleet-sync bursts, archival, regenerable memory) | `buffered` — keep the current default | 872–1 628 rec/s vs 36–108 rec/s for the barrier modes; the data is regenerable and process-kill-safe already | **high** | buffered RPO unchanged: ≤30 s to git/S3, unbounded to power loss; per-append cost degrades as the base file grows (§8.1) |
| **API acknowledgements** (a 2xx that must mean "it is stored") | `fsync`, and only with fan-in batching | single-record fsync costs 3.5–17 ms p50 / ~25 ms p95 here; the same barrier amortized over 100 records costs 42 µs/record (10 624 rec/s) | **high** on correctness, **medium** on cost (device- and load-dependent) | without SUPA-2 batching, fsync puts a multi-millisecond device barrier inside the request; direct must not be used for this (36 rec/s, 4× space) |
| **high-rate ingest** (bulk import, table inserts, log-style ingest) | `buffered` + SUPA-2 single-writer queue; if durability is required, batched `fsync` (one barrier per batch) | batched barrier: 42 µs/record; per-record barrier: 13.65 ms; direct: 23.73 ms and 4 096 B/record | **high** | the serializer's real fan-in path was not driven end-to-end here (see §10); the batch figure mirrors `appendFsyncBatch`'s syscall sequence |
| **direct / `O_DIRECT`** anywhere as a default | **not recommended** | slowest mode measured (36 rec/s), 4× space, alignment depends on an unguaranteed Node buffer alignment, and its advertised unsupported-filesystem failure mode did not trigger on tmpfs/overlayfs here | **high** | revisit only if SUPA-2 framing lands and a target host shows a latency win; keep the per-host support probe |
| **mmap** | **not recommended** | durable mmap (msync every 100) measured 5 434 rec/s — slower than batched fsync's 10 624 rec/s — and needs native code | **medium-high** | probe pre-allocates the file; no file-extension cost measured |

Consequences for SUPA-1's stated cost shape: the "buffered cost plus one device `fdatasync`,
sub-millisecond to low-millisecond" expectation in SUPA-1 §Non-Goals is **optimistic for this
host** — measured single-record p50 is 3.5–17 ms with a p95 near 25 ms under fleet load. The
fan-in amortization claim (AC-8) is confirmed and is the lever that makes fsync affordable:
~193× throughput difference between per-record and per-batch barriers, measured.

## 10. What this note does not establish

- **The SUPA-2 serializer's real fan-in path was not driven end-to-end.** `NamespaceWriter`
  requires table-schema registration and defaults `scheduleCommit` to real git work, so
  driving it was out of the safe envelope for a `/tmp`-only harness. The batched numbers
  mirror `appendFsyncBatch`'s syscall sequence (one open, N writes, one `fdatasync`, close),
  which is what that function does — but that is a mirror, not the serializer itself.
- **No power-loss or OS-crash test.** Acknowledged (`§6.3`).
- **No multi-node, no S3, no cross-machine measurement.** The RPO=0 claim stays single-node.
- **One device, one filesystem family, one host.** Numbers are not portable; the harness is.
- **No tuning study** (mount options, `O_DSYNC`, `sync_file_range`, io_uring, writev batching),
  and no measurement of the git/S3 paths themselves.
- **No change** to SUPA-1's implementation, defaults, config, or docs beyond the link in §11.

## 11. Reproduction

```bash
# from the repository root
cc -O2 -o /tmp/mmap-append-probe scripts/benchmarks/mmap-append-probe.c   # optional; harness compiles it itself

# primary run (what §3.1-§3.4, §6 report)
npx tsx scripts/benchmarks/storage-modes.ts --records 2000 --record-bytes 1024 \
  --warmup 200 --kill-runs 12 --seed 528 --keep --workdir /tmp/db-supa-7-bench

# repeat / size sensitivity
npx tsx scripts/benchmarks/storage-modes.ts --records 2000 --record-bytes 1024 --warmup 200 \
  --kill-runs 12 --seed 528 --keep --workdir /tmp/db-supa-7-bench-r2
npx tsx scripts/benchmarks/storage-modes.ts --records 2000 --record-bytes 256 --warmup 200 \
  --seed 528 --skip-crash --keep --workdir /tmp/db-supa-7-bench-r3

# fast smoke (≈15 s, exercises every phase)
npx tsx scripts/benchmarks/storage-modes.ts --records 40 --warmup 4 --kill-runs 2 --workdir /tmp/supa7-smoke
```

Each run prints a mode table, the crash-battery table and the host/filesystem context, and
writes `summary.json` into its workdir. `--keep` retains the workdir for inspection;
without it the harness deletes it. Flags: `--records`, `--record-bytes`, `--warmup`,
`--kill-runs`, `--seed`, `--workdir`, `--keep`, `--json`, `--skip-mmap`, `--skip-crash`,
`--skip-product`.

**Cleanup**

```bash
rm -rf /tmp/db-supa-7-bench /tmp/db-supa-7-bench-r2 /tmp/db-supa-7-bench-r3 /tmp/supa7-smoke
```

The harness removes its own workdir when `--keep` is not passed and always removes its
`/dev/shm` scratch directories. It writes nothing outside `<tmpdir>`.

## 12. References

- `docs/specs/SUPA-1-write-durability.md` — write-path contract, modes, AC-1…AC-8
- `docs/specs/SUPA-2-serialization.md` — single-writer queue + block framing for direct mode
- `docs/api/http-api.md` §Write Durability (SUPA-1) — public surface, error codes
- `src/storage/jsonl.ts` — buffered append, rotation decision, `countLines`, `getNextChunkName`
- `src/storage/durability.ts` — `appendJsonlDurable`, `appendJsonlDirect`, `frameJsonlRecord`
- `src/serialization/namespaceWriter.ts` — `appendFsyncBatch` fan-in (one `fdatasync` per batch)
- `src/git/autocommit.ts` — git debounce (`maxLines` 100 / `maxSeconds` 30), `git add -A`
- `src/s3/index.ts` — `maybeSyncOnCommit` (inert unless `enabled && pushOnCommit`)
- `scripts/benchmarks/storage-modes.ts`, `scripts/benchmarks/mmap-append-probe.c` — this note's harness
