/**
 * Phase 8b probe — rotation past segment 9999 (DB-GAP-049).
 *
 * Usage: npx tsx ops/dogfood-phase8-rotation.ts <probe-dir>
 * Expects <probe-dir> to hold 9999.jsonl (1000 valid records, at the
 * MAX_LINES_PER_CHUNK cap) and an empty 10000.jsonl — the exact freeze shape.
 * Appends one record to the full 9999 segment, then asserts:
 *   ok1 — the append landed in a NEW segment (10001.jsonl), not 10000.jsonl
 *   ok2 — readPartition returns all 1001 records in numeric append order
 * Prints a single JSON line {ok1, ok2, files, count, lastKey}.
 */
import fs from "fs";
import { appendToJsonl, readPartition } from "../src/storage/jsonl";
import type { MemoryType } from "../src/schema/memory";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: tsx ops/dogfood-phase8-rotation.ts <probe-dir>");
  process.exit(2);
}

const f9999 = dir + "/9999.jsonl";
const lines = fs.readFileSync(f9999, "utf8").trim().split("\n");
const last = JSON.parse(lines[lines.length - 1]) as MemoryType;

appendToJsonl(
  f9999,
  { ...last, id: "00000000-0000-4000-8000-100000000000", key: "/rot/new" },
);

const names = fs.readdirSync(dir).sort();
const recs = readPartition(dir).filter((r) => r.key.startsWith("/rot/"));
const ok1 = names.includes("10001.jsonl");
const ok2 = recs[recs.length - 1]?.key === "/rot/new" && recs.length === 1001;
console.log(
  JSON.stringify({ ok1, ok2, files: names, count: recs.length, lastKey: recs[recs.length - 1]?.key }),
);
