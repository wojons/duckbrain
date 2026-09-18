/**
 * DB-SUPA-7 — storage-modes benchmark harness (research instrument, not product code).
 *
 * Compares the write paths DuckBrain can plausibly use for JSONL ingestion:
 *
 *   1. sys-buffered        open/write/close per record (exactly what
 *                          `fs.appendFileSync` does — src/storage/jsonl.ts:330)
 *   2. sys-fsync           open/write/fdatasync/close per record (the fd
 *                          protocol of `appendJsonlDurable`,
 *                          src/storage/durability.ts appendJsonlDurable)
 *   3. sys-fsync-batch100  one open, 100 writes, ONE fdatasync, close — the
 *                          syscall sequence of `appendFsyncBatch`
 *                          (src/serialization/namespaceWriter.ts:253-300),
 *                          i.e. SUPA-2 fan-in amortization
 *   4. sys-odirect         O_DIRECT + O_APPEND block-framed appends, fd
 *                          fdatasync per record; run against the ext4 bench dir
 *                          AND /dev/shm (tmpfs) to record the unsupported case
 *   5. sys-mmap            real `mmap(MAP_SHARED)` appends via the compiled
 *                          scripts/benchmarks/mmap-append-probe.c (no msync, and
 *                          msync(MS_SYNC) every 100 records); falls back to a
 *                          documented positional-pwrite PROXY when no C
 *                          compiler is available
 *   6. prod-buffered       the real `appendToJsonl` (src/storage/jsonl.ts)
 *   7. prod-fsync          the real `appendJsonlDurable`
 *   8. prod-direct         the real `appendJsonlDirect` + `frameJsonlRecord`
 *
 * plus a bounded crash battery: a child process writes checksummed records in a
 * given mode and is SIGKILLed mid-write; the data files are then replayed
 * line-by-line and compared against the records the child acknowledged.
 *
 * SAFETY: every byte lands under `<tmpdir>/db-supa-7-bench*`. No production
 * namespace, no network, no S3, no git. Bounded record counts and sizes.
 * SIGKILL of a writer process is NOT an OS-crash/power-loss test (see the note).
 *
 * Usage:
 *   npx tsx scripts/benchmarks/storage-modes.ts                     # full run
 *   npx tsx scripts/benchmarks/storage-modes.ts --records 4000 --kill-runs 20
 *   npx tsx scripts/benchmarks/storage-modes.ts --keep              # keep /tmp workdir
 *   npx tsx scripts/benchmarks/storage-modes.ts --skip-mmap --skip-crash
 *
 * Flags: --records N --record-bytes B --warmup N --kill-runs K --seed S
 *        --workdir DIR --keep --json --skip-mmap --skip-crash --skip-product
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DURABILITY_BLOCK_SIZE,
  appendJsonlDirect,
  appendJsonlDurable,
  frameJsonlRecord,
  isDurabilityError,
} from "../../src/storage/durability";
import { appendToJsonl } from "../../src/storage/jsonl";
import type { MemoryType } from "../../src/schema/memory";

/* ------------------------------------------------------------------ */
/* flags                                                              */
/* ------------------------------------------------------------------ */

interface Flags {
  records: number;
  recordBytes: number;
  warmup: number;
  killRuns: number;
  seed: number;
  workdir: string;
  keep: boolean;
  json: boolean;
  skipMmap: boolean;
  skipCrash: boolean;
  skipProduct: boolean;
  childWriter?: string;
  childDir?: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (name: string, dflt: number): number => {
    const raw = get(name);
    if (raw === undefined) return dflt;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${name}: ${raw}`);
    return n;
  };
  const childWriter = get("--child-writer");
  return {
    records: num("--records", 2000),
    recordBytes: num("--record-bytes", 1024),
    warmup: num("--warmup", 200),
    killRuns: num("--kill-runs", 12),
    seed: num("--seed", 528),
    workdir:
      get("--workdir") ??
      path.join(os.tmpdir(), `db-supa-7-bench-${process.pid}`),
    keep: argv.includes("--keep"),
    json: argv.includes("--json"),
    skipMmap: argv.includes("--skip-mmap"),
    skipCrash: argv.includes("--skip-crash"),
    skipProduct: argv.includes("--skip-product"),
    childWriter,
    childDir: childWriter ? argv[argv.indexOf("--child-writer") + 2] : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* timing helpers                                                     */
/* ------------------------------------------------------------------ */

interface Dist {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function summarize(latencies: number[]): Dist {
  const sorted = [...latencies].sort((a, b) => a - b);
  const pick = (p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)));
    return sorted[idx];
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    mean: sorted.length ? sum / sorted.length : 0,
  };
}

const nsNow = (): bigint => process.hrtime.bigint();

interface Bucket {
  label: string;
  dist: Dist;
}

interface ModeResult {
  id: string;
  kind: "syscall" | "product" | "proxy" | "c-mmap";
  unit: string;
  supported: boolean;
  supportDetail?: string;
  notes?: string;
  dist: Dist | null;
  throughput_rec_per_s: number | null;
  logical_bytes: number;
  physical_bytes: number;
  errors: number;
  firstError?: string;
  buckets?: Bucket[];
  extra?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* record construction                                                */
/* ------------------------------------------------------------------ */

/** A schema-valid memory record padded to roughly `targetBytes` per line. */
function makeRecord(seq: number, targetBytes: number): MemoryType {
  const skeleton = JSON.stringify({
    id: crypto.randomUUID(),
    key: `/bench/supa7/record-${seq}`,
    domain: "raw_note",
    timestamp: new Date().toISOString(),
    author: "bench@duckbrain.local",
    action: "add",
    embedding_text: "",
    attributes: { seq },
  });
  const pad = Math.max(0, targetBytes - skeleton.length);
  return {
    id: crypto.randomUUID(),
    key: `/bench/supa7/record-${seq}`,
    domain: "raw_note",
    timestamp: new Date().toISOString(),
    author: "bench@duckbrain.local",
    action: "add",
    embedding_text: "x".repeat(pad),
    attributes: { seq },
  };
}

function sha16(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Child-writer record: carries the checksum the replay validator re-derives. */
function makeChecksummedRecord(
  seq: number,
  targetBytes: number,
): { record: MemoryType; payload: string } {
  const payload =
    `seq=${seq};` + "y".repeat(Math.max(0, targetBytes - 32)) + `;seq=${seq}`;
  const record: MemoryType = {
    id: crypto.randomUUID(),
    key: `/bench/supa7/crash-${seq}`,
    domain: "raw_note",
    timestamp: new Date().toISOString(),
    author: "bench@duckbrain.local",
    action: "add",
    embedding_text: payload,
    attributes: { seq, checksum: sha16(payload) },
  };
  return { record, payload };
}

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeLineAt(fd: number, line: string): void {
  fs.writeSync(fd, line);
}

/* ------------------------------------------------------------------ */
/* phase A — syscall-level modes                                     */
/* ------------------------------------------------------------------ */

function sysBuffered(
  dir: string,
  records: number,
  warmup: number,
  recordBytes: number,
): ModeResult {
  const file = path.join(dir, "sys-buffered.log");
  const record = makeRecord(1, recordBytes);
  const line = JSON.stringify(record) + "\n";
  const lat: number[] = [];
  let errors = 0;
  let firstError: string | undefined;
  const total = records + warmup;
  for (let i = 0; i < total; i++) {
    const t0 = nsNow();
    try {
      // fs.appendFileSync(path, data) == open(a) -> write -> close
      const fd = fs.openSync(file, "a");
      writeLineAt(fd, line);
      fs.closeSync(fd);
    } catch (err) {
      errors++;
      firstError ??= String(err);
    }
    const t1 = nsNow();
    if (i >= warmup) lat.push(Number(t1 - t0));
  }
  return {
    id: "sys-buffered",
    kind: "syscall",
    unit: "ns per record (open+write+close)",
    supported: true,
    dist: summarize(lat),
    throughput_rec_per_s: throughput(lat),
    logical_bytes: line.length * records,
    physical_bytes: fs.statSync(file).size,
    errors,
    firstError,
    notes: "page-cache append, no barrier (buffered RPO)",
  };
}

function sysFsync(
  dir: string,
  records: number,
  warmup: number,
  recordBytes: number,
): ModeResult {
  const file = path.join(dir, "sys-fsync.log");
  const record = makeRecord(1, recordBytes);
  const line = JSON.stringify(record) + "\n";
  const lat: number[] = [];
  let errors = 0;
  let firstError: string | undefined;
  const total = records + warmup;
  for (let i = 0; i < total; i++) {
    const t0 = nsNow();
    try {
      const fd = fs.openSync(file, "a");
      writeLineAt(fd, line);
      fs.fdatasyncSync(fd);
      fs.closeSync(fd);
    } catch (err) {
      errors++;
      firstError ??= String(err);
    }
    const t1 = nsNow();
    if (i >= warmup) lat.push(Number(t1 - t0));
  }
  return {
    id: "sys-fsync",
    kind: "syscall",
    unit: "ns per record (open+write+fdatasync+close)",
    supported: true,
    dist: summarize(lat),
    throughput_rec_per_s: throughput(lat),
    logical_bytes: line.length * records,
    physical_bytes: fs.statSync(file).size,
    errors,
    firstError,
    notes: "one fdatasync per record; ack-durable protocol",
  };
}

function sysFsyncBatch(
  dir: string,
  records: number,
  warmup: number,
  recordBytes: number,
  batch: number,
): ModeResult {
  const file = path.join(dir, `sys-fsync-batch${batch}.log`);
  const record = makeRecord(1, recordBytes);
  const line = JSON.stringify(record) + "\n";
  const lat: number[] = [];
  let errors = 0;
  let firstError: string | undefined;
  let fdatasyncs = 0;
  const total = records + warmup;
  const batches = Math.ceil(total / batch);
  let seen = 0;
  for (let b = 0; b < batches; b++) {
    const size = Math.min(batch, total - b * batch);
    const t0 = nsNow();
    try {
      const fd = fs.openSync(file, "a");
      for (let i = 0; i < size; i++) writeLineAt(fd, line);
      fs.fdatasyncSync(fd);
      fdatasyncs++;
      fs.closeSync(fd);
    } catch (err) {
      errors++;
      firstError ??= String(err);
    }
    const t1 = nsNow();
    const perRecord = Number(t1 - t0) / size;
    for (let i = 0; i < size; i++) {
      if (seen + i >= warmup) lat.push(perRecord);
    }
    seen += size;
  }
  return {
    id: `sys-fsync-batch${batch}`,
    kind: "syscall",
    unit: "ns per record (amortized over one open + one fdatasync per batch)",
    supported: true,
    dist: summarize(lat),
    throughput_rec_per_s: throughput(lat),
    logical_bytes: line.length * records,
    physical_bytes: fs.statSync(file).size,
    errors,
    firstError,
    notes: `mirrors appendFsyncBatch (namespaceWriter.ts:253-300); fdatasyncs=${fdatasyncs}`,
    extra: { batches, fdatasyncs },
  };
}

function sysOdirect(
  dir: string,
  records: number,
  warmup: number,
  recordBytes: number,
): ModeResult {
  const file = path.join(dir, "sys-odirect.bin");
  const block = DURABILITY_BLOCK_SIZE;
  const blocks = Math.max(1, Math.ceil(recordBytes / block));
  const payload = Buffer.from(
    JSON.stringify({ framed: "odirect", seq: 0, pad: "x".repeat(64) }) + "\n",
    "utf8",
  );
  const buf = Buffer.allocUnsafeSlow(blocks * block);
  buf.fill(0x0a);
  payload.copy(buf, 0);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_APPEND |
    fs.constants.O_DIRECT;
  const lat: number[] = [];
  let errors = 0;
  let firstError: string | undefined;
  let supported = true;
  const total = records + warmup;
  for (let i = 0; i < total; i++) {
    const t0 = nsNow();
    try {
      const fd = fs.openSync(file, flags, 0o644);
      fs.writeSync(fd, buf, 0, buf.length, null);
      fs.fdatasyncSync(fd);
      fs.closeSync(fd);
    } catch (err) {
      errors++;
      const e = err as NodeJS.ErrnoException;
      supported = false;
      firstError ??= `${e.code ?? ""}${e.code ? ": " : ""}${e.message}`;
      break;
    }
    const t1 = nsNow();
    if (i >= warmup) lat.push(Number(t1 - t0));
  }
  return {
    id: "sys-odirect",
    kind: "syscall",
    unit: "ns per record (O_DIRECT open+write block+fdatasync+close)",
    supported,
    supportDetail: supported
      ? `O_DIRECT accepted (${blocks} x ${block}-byte frames)`
      : `O_DIRECT rejected: ${firstError}`,
    dist: supported ? summarize(lat) : null,
    throughput_rec_per_s: supported ? throughput(lat) : null,
    logical_bytes: recordBytes * records,
    physical_bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    errors,
    firstError,
    notes: `direct mode pads every record to a ${block}-byte frame`,
  };
}

function throughput(latencies: number[]): number | null {
  if (latencies.length === 0) return null;
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  return mean > 0 ? 1e9 / mean : null;
}

/* ------------------------------------------------------------------ */
/* phase A5 — real mmap (C probe) or documented proxy                 */
/* ------------------------------------------------------------------ */

function runMmapProbe(
  dir: string,
  records: number,
  warmup: number,
  recordBytes: number,
  msyncEvery: number,
): ModeResult {
  const source = path.join(__dirname, "mmap-append-probe.c");
  const binary = path.join(dir, "mmap-append-probe");
  const id = `sys-mmap${msyncEvery > 0 ? `-msync${msyncEvery}` : "-nomsync"}`;
  const rec = Math.max(recordBytes, 64);
  const cProbe = (): ModeResult | null => {
    if (!fs.existsSync(source)) return null;
    if (!fs.existsSync(binary)) {
      const cc = spawnSync(
        "cc",
        ["-O2", "-o", binary, source],
        { encoding: "utf8" },
      );
      if (cc.status !== 0) return null;
    }
    const run = spawnSync(
      binary,
      [
        path.join(dir, `mmap-${msyncEvery}.bin`),
        String(records),
        String(rec),
        String(msyncEvery),
        String(warmup),
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
    } catch {
      return null;
    }
    if (parsed.ok !== true) return null;
    const mean = Number(parsed.mean_ns);
    return {
      id,
      kind: "c-mmap",
      unit: "ns per record (MAP_SHARED memcpy append)",
      supported: true,
      supportDetail: "real mmap via scripts/benchmarks/mmap-append-probe.c",
      dist: {
        n: Number(parsed.records),
        p50: Number(parsed.p50_ns),
        p95: Number(parsed.p95_ns),
        p99: Number(parsed.p99_ns),
        max: Number(parsed.max_ns),
        mean,
      },
      throughput_rec_per_s: mean > 0 ? 1e9 / mean : null,
      logical_bytes: rec * records,
      physical_bytes: fs.statSync(path.join(dir, `mmap-${msyncEvery}.bin`)).size,
      errors: 0,
      notes:
        msyncEvery > 0
          ? `msync(MS_SYNC) every ${msyncEvery} records (mmap barrier); first-touch page faults included`
          : "no barrier — page-cache writes, buffered-equivalent RPO; first-touch page faults included",
      extra: {
        msync_calls: Number(parsed.msync_calls),
        preallocated: true,
      },
    };
  };

  const fromC = cProbe();
  if (fromC) return fromC;

  // Documented proxy: Node has no file mmap API. Same page-cache write path a
  // MAP_SHARED memcpy takes, over a pre-allocated file, through a reused fd
  // (positional pwrite — no per-record open/close). Excludes page-fault cost.
  const file = path.join(dir, "mmap-proxy.bin");
  const total = records + warmup;
  const size = total * rec;
  const payload = Buffer.alloc(rec, 0x78);
  fs.writeFileSync(file, Buffer.alloc(0));
  fs.truncateSync(file, size);
  const fd = fs.openSync(file, "r+");
  const lat: number[] = [];
  let bars = 0;
  for (let i = 0; i < total; i++) {
    const t0 = nsNow();
    fs.writeSync(fd, payload, 0, rec, i * rec);
    if (msyncEvery > 0 && (i + 1) % msyncEvery === 0) {
      fs.fdatasyncSync(fd);
      bars++;
    }
    const t1 = nsNow();
    if (i >= warmup) lat.push(Number(t1 - t0));
  }
  fs.closeSync(fd);
  return {
    id,
    kind: "proxy",
    unit: "ns per record (positional pwrite into pre-allocated file)",
    supported: true,
    supportDetail:
      "PROXY — no C compiler for a real mmap probe; positional pwrite approximates the MAP_SHARED page-cache write path",
    dist: summarize(lat),
    throughput_rec_per_s: throughput(lat),
    logical_bytes: rec * records,
    physical_bytes: size,
    errors: 0,
    notes:
      msyncEvery > 0
        ? `fdatasync every ${msyncEvery} records as the msync(MS_SYNC) stand-in; no page-fault cost`
        : "no barrier; no page-fault cost (proxy limitation)",
    extra: { barriers: bars, preallocated: true },
  };
}

/* ------------------------------------------------------------------ */
/* phase B — real product appenders                                   */
/* ------------------------------------------------------------------ */

type ProductMode = "buffered" | "fsync" | "direct";

function productAppend(
  mode: ProductMode,
  file: string,
  record: MemoryType,
): void {
  if (mode === "buffered") appendToJsonl(file, record);
  else if (mode === "fsync") appendJsonlDurable(file, record);
  else appendJsonlDirect(file, frameJsonlRecord(record));
}

function productMode(
  mode: ProductMode,
  dir: string,
  records: number,
  warmup: number,
  recordBytes: number,
): ModeResult {
  const partDir = path.join(dir, `prod-${mode}`);
  mkdirp(partDir);
  const file = path.join(partDir, "current.jsonl");
  const warmupFile = path.join(partDir, "warmup.jsonl");

  // Warmup on its own partition file so chunk occupancy is not pre-charged.
  for (let i = 0; i < warmup; i++) {
    try {
      productAppend(mode, warmupFile, makeRecord(i, recordBytes));
    } catch {
      break;
    }
  }

  const lat: number[] = [];
  const buckets: Bucket[] = [];
  const bucketSize = Math.max(1, Math.floor(records / 4));
  let bucketLat: number[] = [];
  let errors = 0;
  let firstError: string | undefined;
  let supported = true;
  let logicalBytes = 0;

  for (let i = 0; i < records; i++) {
    const record = makeRecord(i, recordBytes);
    const t0 = nsNow();
    try {
      productAppend(mode, file, record);
      logicalBytes += Buffer.byteLength(JSON.stringify(record)) + 1;
    } catch (err) {
      errors++;
      const e = err as Error & { code?: string };
      if (isDurabilityError(err) || e.code === "EINVAL" || e.code === "EOPNOTSUPP") {
        supported = false;
      }
      firstError ??= `${e.code ? e.code + ": " : ""}${e.message}`;
      if (!supported) break;
    }
    const t1 = nsNow();
    lat.push(Number(t1 - t0));
    bucketLat.push(Number(t1 - t0));
    if (bucketLat.length === bucketSize || i === records - 1) {
      buckets.push({
        label: `records ${i - bucketLat.length + 1}-${i + 1}`,
        dist: summarize(bucketLat),
      });
      bucketLat = [];
    }
  }

  let physicalBytes = 0;
  for (const entry of fs.readdirSync(partDir)) {
    const st = fs.statSync(path.join(partDir, entry));
    if (st.isFile() && entry.endsWith(".jsonl") && entry !== "warmup.jsonl") {
      physicalBytes += st.size;
    }
  }

  return {
    id: `prod-${mode}`,
    kind: "product",
    unit: "ns per record (real appender, includes rotation check)",
    supported,
    supportDetail: supported ? "appender accepted writes" : `appender failed: ${firstError}`,
    dist: supported ? summarize(lat) : null,
    throughput_rec_per_s: supported ? throughput(lat) : null,
    logical_bytes: logicalBytes,
    physical_bytes: physicalBytes,
    errors,
    firstError,
    buckets,
    notes:
      mode === "direct"
        ? "every record padded to a 4 KiB frame (frameJsonlRecord)"
        : mode === "fsync"
          ? "fdatasync + parent-dir fsync per record; durable namespace"
          : "page-cache append; rotation check (statSync + countLines full read) on every call",
  };
}

/* ------------------------------------------------------------------ */
/* phase C — crash battery (child writer + replay)                    */
/* ------------------------------------------------------------------ */

function childWriterMain(mode: ProductMode, dir: string, recordBytes: number): never {
  mkdirp(dir);
  const file = path.join(dir, "current.jsonl");
  const ackPath = path.join(dir, "acks.log");
  const ackFd = fs.openSync(ackPath, "a");
  let seq = 0;
  process.stdout.write(`CHILD_READY mode=${mode} dir=${dir}\n`);
  for (;;) {
    seq++;
    const { record } = makeChecksummedRecord(seq, recordBytes);
    try {
      productAppend(mode, file, record);
    } catch (err) {
      process.stderr.write(`CHILD_APPEND_ERROR ${String(err)}\n`);
      process.exit(3);
    }
    // Ack protocol: the ack line is fdatasync'd in EVERY mode so that "what the
    // child acknowledged" stays observable after SIGKILL. This is stricter than
    // DuckBrain's buffered ack (page cache only) and is paid identically by all
    // three modes, so the inter-mode comparison stays fair.
    fs.writeSync(ackFd, `${seq}\n`);
    fs.fdatasyncSync(ackFd);
  }
}

interface ReplaySummary {
  dataFiles: number;
  bytes: number;
  totalLines: number;
  valid: number;
  malformed: number;
  checksumMismatch: number;
  trailingPartial: boolean;
  maxObservedSeq: number | null;
  acked: number;
  ackedMissingFromData: number;
  maxAckSeq: number | null;
}

function replay(dir: string): ReplaySummary {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));
  let bytes = 0;
  let totalLines = 0;
  let valid = 0;
  let malformed = 0;
  let checksumMismatch = 0;
  let maxObservedSeq: number | null = null;
  let trailingPartial = false;
  const seen = new Set<number>();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    bytes += Buffer.byteLength(content);
    if (content.length > 0 && !content.endsWith("\n")) trailingPartial = true;
    for (const raw of content.split("\n")) {
      if (raw.trim() === "") continue;
      totalLines++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        malformed++;
        continue;
      }
      const rec = parsed as {
        key?: unknown;
        embedding_text?: unknown;
        attributes?: { seq?: unknown; checksum?: unknown };
      };
      const seq = rec.attributes?.seq;
      const checksum = rec.attributes?.checksum;
      const payload = rec.embedding_text;
      if (typeof seq !== "number" || typeof checksum !== "string" || typeof payload !== "string") {
        malformed++;
        continue;
      }
      if (sha16(payload) !== checksum) {
        checksumMismatch++;
        continue;
      }
      valid++;
      seen.add(seq);
      if (maxObservedSeq === null || seq > maxObservedSeq) maxObservedSeq = seq;
    }
  }

  let acked = 0;
  let ackedMissingFromData = 0;
  let maxAckSeq: number | null = null;
  const ackPath = path.join(dir, "acks.log");
  if (fs.existsSync(ackPath)) {
    for (const line of fs.readFileSync(ackPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const n = Number.parseInt(line, 10);
      if (!Number.isFinite(n)) continue;
      acked++;
      if (maxAckSeq === null || n > maxAckSeq) maxAckSeq = n;
      if (!seen.has(n)) ackedMissingFromData++;
    }
  }

  return {
    dataFiles: files.length,
    bytes,
    totalLines,
    valid,
    malformed,
    checksumMismatch,
    trailingPartial,
    maxObservedSeq,
    acked,
    ackedMissingFromData,
    maxAckSeq,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic PRNG (mulberry32) so the SIGKILL timing is reproducible from
 * --seed. The kill window is deliberately randomized: a fixed delay would
 * sample the same inter-append gap on every run.
 */
let rngState = 528;
function rand(): number {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

async function crashRun(
  mode: ProductMode,
  dir: string,
  recordBytes: number,
): Promise<ReplaySummary> {
  mkdirp(dir);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      __filename,
      "--child-writer",
      mode,
      dir,
      "--record-bytes",
      String(recordBytes),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let childErr = "";
  child.stderr?.on("data", (d: Buffer) => {
    childErr += d.toString();
  });
  child.stdout?.on("data", () => undefined);

  // Wait until the writer is demonstrably mid-stream (data file growing), then
  // kill at a randomized moment so the SIGKILL lands between appends.
  const dataPath = path.join(dir, "current.jsonl");
  const deadline = Date.now() + 5000;
  let lastSize = 0;
  while (Date.now() < deadline) {
    const size = fs.existsSync(dataPath) ? fs.statSync(dataPath).size : 0;
    if (size > 0 && size !== lastSize) {
      lastSize = size;
      break;
    }
    await sleepMs(10);
  }
  await sleepMs(60 + Math.floor(rand() * 290));

  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 4000);
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");

  if (childErr.trim() !== "") {
    process.stdout.write(
      `    child stderr: ${childErr.trim().split("\n")[0]}\n`,
    );
  }
  return replay(dir);
}

/* ------------------------------------------------------------------ */
/* reporting                                                          */
/* ------------------------------------------------------------------ */

function fmtNs(ns: number | null | undefined): string {
  if (ns === null || ns === undefined) return "n/a";
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)}ms`;
  if (ns >= 1000) return `${(ns / 1000).toFixed(1)}µs`;
  return `${ns.toFixed(0)}ns`;
}

function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return "n/a";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function printModeTable(results: ModeResult[]): void {
  const head =
    "mode".padEnd(22) +
    "support".padEnd(9) +
    "p50".padStart(10) +
    "p95".padStart(10) +
    "p99".padStart(10) +
    "max".padStart(10) +
    "rec/s".padStart(12);
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of results) {
    console.log(
      r.id.padEnd(22) +
        (r.supported ? "yes" : "NO").padEnd(9) +
        fmtNs(r.dist?.p50).padStart(10) +
        fmtNs(r.dist?.p95).padStart(10) +
        fmtNs(r.dist?.p99).padStart(10) +
        fmtNs(r.dist?.max).padStart(10) +
        fmtNum(r.throughput_rec_per_s).padStart(12),
    );
  }
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  rngState = flags.seed | 0;

  if (flags.childWriter) {
    const mode = flags.childWriter as ProductMode;
    if (!flags.childDir) throw new Error("--child-writer requires a dir argument");
    childWriterMain(mode, flags.childDir, flags.recordBytes);
  }

  const workdir = path.resolve(flags.workdir);
  if (!workdir.startsWith(path.resolve(os.tmpdir()))) {
    throw new Error(
      `refusing to run outside ${os.tmpdir()} (got ${workdir}) — this harness is /tmp-only by design`,
    );
  }
  fs.rmSync(workdir, { recursive: true, force: true });
  mkdirp(workdir);

  console.log("DB-SUPA-7 storage-modes benchmark");
  console.log(`  date (UTC)      : ${new Date().toISOString()}`);
  console.log(`  host            : ${os.hostname()} (${os.platform()} ${os.release()} ${os.arch()})`);
  console.log(`  node            : ${process.version}`);
  console.log(`  cpus            : ${os.cpus()[0]?.model ?? "unknown"} x${os.cpus().length}`);
  console.log(`  workdir         : ${workdir}`);
  console.log(`  records/mode    : ${flags.records} (+${flags.warmup} warmup)`);
  console.log(`  record size     : ~${flags.recordBytes} bytes/line`);
  console.log(`  kill runs/mode  : ${flags.killRuns}`);
  const fsProbe = spawnSync("df", ["-T", workdir], { encoding: "utf8" });
  console.log(`  filesystem      : ${(fsProbe.stdout ?? "").split("\n")[1]?.trim() ?? "unknown"}`);
  console.log("");

  const results: ModeResult[] = [];

  // -------- phase A: syscall-level
  const sysDir = path.join(workdir, "syscall");
  mkdirp(sysDir);
  const t0 = Date.now();
  results.push(sysBuffered(sysDir, flags.records, flags.warmup, flags.recordBytes));
  results.push(sysFsync(sysDir, flags.records, flags.warmup, flags.recordBytes));
  results.push(sysFsyncBatch(sysDir, flags.records, flags.warmup, flags.recordBytes, 100));
  results.push(sysOdirect(sysDir, flags.records, flags.warmup, flags.recordBytes));
  // tmpfs arm: the SUPA-1 AC-4 "O_DIRECT unsupported" case, measured.
  if (fs.existsSync("/dev/shm")) {
    const shmDir = path.join("/dev/shm", `db-supa-7-bench-${process.pid}`);
    mkdirp(shmDir);
    const shm = sysOdirect(shmDir, 16, 0, flags.recordBytes);
    shm.id = "sys-odirect@tmpfs";
    shm.notes = "SUPA-1 AC-4 arm: tmpfs rejects O_DIRECT (fail-loud path)";
    results.push(shm);
    fs.rmSync(shmDir, { recursive: true, force: true });
  }
  console.log(`[phase A] syscall-level modes done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // -------- phase A5: mmap
  if (!flags.skipMmap) {
    const mmapDir = path.join(workdir, "mmap");
    mkdirp(mmapDir);
    results.push(runMmapProbe(mmapDir, flags.records, flags.warmup, flags.recordBytes, 0));
    results.push(runMmapProbe(mmapDir, flags.records, flags.warmup, flags.recordBytes, 100));
    console.log("[phase A5] mmap probe done");
  }

  // -------- phase B: real product appenders
  if (!flags.skipProduct) {
    const prodDir = path.join(workdir, "product");
    mkdirp(prodDir);
    const t1 = Date.now();
    results.push(productMode("buffered", prodDir, flags.records, flags.warmup, flags.recordBytes));
    results.push(productMode("fsync", prodDir, flags.records, flags.warmup, flags.recordBytes));
    results.push(productMode("direct", prodDir, flags.records, flags.warmup, flags.recordBytes));
    // tmpfs arm for the shipped direct appender (SUPA-1 AC-4, product path).
    if (fs.existsSync("/dev/shm")) {
      const shmRoot = path.join("/dev/shm", `db-supa-7-prod-${process.pid}`);
      mkdirp(shmRoot);
      const direct = productMode("direct", shmRoot, 8, 0, flags.recordBytes);
      direct.id = "prod-direct@tmpfs";
      direct.notes = "SUPA-1 AC-4 arm through the shipped appender on tmpfs";
      results.push(direct);
      fs.rmSync(shmRoot, { recursive: true, force: true });
    }
    console.log(`[phase B] product appenders done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }

  console.log("");
  printModeTable(results);
  console.log("");

  for (const r of results) {
    const bits = [
      r.supportDetail,
      r.notes,
      r.errors ? `errors=${r.errors}${r.firstError ? ` (${r.firstError})` : ""}` : undefined,
    ].filter(Boolean);
    if (bits.length) console.log(`  ${r.id}: ${bits.join(" | ")}`);
  }

  // -------- phase C: crash battery
  const crash: Record<string, ReplaySummary[]> = {};
  if (!flags.skipCrash) {
    console.log("");
    console.log("[phase C] crash battery (SIGKILL of the writer mid-stream)");
    const crashRoot = path.join(workdir, "crash");
    mkdirp(crashRoot);
    for (const mode of ["buffered", "fsync", "direct"] as ProductMode[]) {
      const runs: ReplaySummary[] = [];
      for (let i = 0; i < flags.killRuns; i++) {
        const dir = path.join(crashRoot, `${mode}-${i}`);
        const summary = await crashRun(mode, dir, flags.recordBytes);
        runs.push(summary);
        process.stdout.write(
          `  ${mode} run ${i + 1}/${flags.killRuns}: valid=${summary.valid} malformed=${summary.malformed} mismatch=${summary.checksumMismatch} acked=${summary.acked} ackMissing=${summary.ackedMissingFromData}\n`,
        );
      }
      crash[mode] = runs;
    }
    const head =
      "mode".padEnd(12) +
      "runs".padStart(5) +
      "valid".padStart(9) +
      "malformed".padStart(10) +
      "chksum-bad".padStart(11) +
      "ackd".padStart(9) +
      "ack-missing".padStart(12);
    console.log("");
    console.log(head);
    console.log("-".repeat(head.length));
    for (const [mode, runs] of Object.entries(crash)) {
      const sum = (f: (r: ReplaySummary) => number): number =>
        runs.reduce((acc, r) => acc + f(r), 0);
      console.log(
        mode.padEnd(12) +
          String(runs.length).padStart(5) +
          fmtNum(sum((r) => r.valid)).padStart(9) +
          fmtNum(sum((r) => r.malformed)).padStart(10) +
          fmtNum(sum((r) => r.checksumMismatch)).padStart(11) +
          fmtNum(sum((r) => r.acked)).padStart(9) +
          fmtNum(sum((r) => r.ackedMissingFromData)).padStart(12),
      );
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown",
      cpus: os.cpus().length,
      filesystem: (fsProbe.stdout ?? "").split("\n")[1]?.trim() ?? "unknown",
    },
    params: {
      records: flags.records,
      recordBytes: flags.recordBytes,
      warmup: flags.warmup,
      killRuns: flags.killRuns,
      workdir,
    },
    results,
    crash,
  };
  const summaryPath = path.join(workdir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`summary json : ${summaryPath}`);

  if (!flags.keep) {
    fs.rmSync(workdir, { recursive: true, force: true });
    console.log("workdir removed (pass --keep to retain it)");
  } else {
    console.log(`workdir kept : ${workdir}`);
  }
  if (flags.json) console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
