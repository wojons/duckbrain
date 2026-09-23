#!/usr/bin/env node
/**
 * duckbrain-purge-empty-rows.mjs — remove empty-payload memory rows.
 *
 * WHY: a broken client writes rows whose embedding_text is literally "{}" or "".
 * Measured 2026-09-23: 60,925 such rows in the `scheduler` namespace (33.7% of
 * it), authored `true@duckbrain.local`. They carry no information at all, but
 * they are 33.7% of the row count, and because every one of them hashes the
 * same per key they also dominate duplicate counts. Filed as DB-GAP-056 (P1).
 *
 * WHAT IT DOES NOT DO: it does not fix the writer. Until the writer is fixed,
 * purged rows come back. Run this after, or accept that it is a sweeper.
 *
 * SAFETY:
 *   - `_audit/` is never touched. Audit-ledger rows are a different record type
 *     that merely lives inside the namespace tree.
 *   - Only rows with an explicitly empty embedding_text are candidates. A row
 *     with no embedding_text field is never a candidate.
 *   - Every file is copied to a backup directory before it is rewritten.
 *   - Kept lines are copied through byte-for-byte (the file is treated as
 *     bytes, split on \n, filtered, rejoined) — no JSON re-serialization, so
 *     key order, whitespace and numeric formatting cannot drift.
 *   - After rewriting, the kept line count is re-read from disk and compared.
 *   - Default is a dry run; writing requires --apply.
 *
 * Usage:
 *   node scripts/maintenance/duckbrain-purge-empty-rows.mjs [--apply]
 *        [--root DIR] [--namespace NAME]... [--backup-dir DIR] [--json]
 * Env:
 *   DUCKBRAIN_NAMESPACES_PATH  store root (default: $HOME/duckbrain/namespaces)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const opts = {
  apply: false,
  json: false,
  root:
    process.env.DUCKBRAIN_NAMESPACES_PATH ||
    path.join(os.homedir(), "duckbrain", "namespaces"),
  namespaces: [],
  backupDir: null,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--apply") opts.apply = true;
  else if (a === "--json") opts.json = true;
  else if (a === "--root") opts.root = argv[++i];
  else if (a === "--namespace") opts.namespaces.push(argv[++i]);
  else if (a === "--backup-dir") opts.backupDir = argv[++i];
  else if (a === "-h" || a === "--help") {
    console.log(
      fs
        .readFileSync(new URL(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 30)
        .join("\n"),
    );
    process.exit(0);
  } else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}
if (!fs.existsSync(opts.root)) {
  console.error(`store root not found: ${opts.root}`);
  process.exit(3);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir =
  opts.backupDir ||
  path.join(
    os.homedir(),
    ".hermes",
    "state",
    `duckbrain-purge-empty-backup-${stamp}`,
  );

// A row is an empty payload only if the field is PRESENT and empty.
const EMPTY_RE = /"embedding_text"\s*:\s*"(\{\})?"/;
const TRANSCRIPT_RE = /"(embedding_text|key|content)"\s*:/;

function* walkJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "_audit") yield* walkJsonl(full);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) yield full;
  }
}

const namespaces = opts.namespaces.length
  ? opts.namespaces
  : fs
      .readdirSync(opts.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

const summary = {
  root: opts.root,
  apply: opts.apply,
  backup_dir: opts.apply ? backupDir : null,
  namespaces_scanned: 0,
  files_scanned: 0,
  files_changed: 0,
  rows_total: 0,
  rows_purged: 0,
  bytes_before: 0,
  bytes_after: 0,
  bytes_reclaimed: 0,
  per_namespace: {},
  errors: [],
};

for (const ns of namespaces) {
  const nsDir = path.join(opts.root, ns);
  if (!fs.existsSync(nsDir)) continue;
  const nsStat = {
    rows: 0,
    purged: 0,
    files: 0,
    files_changed: 0,
    reclaimed: 0,
  };
  summary.namespaces_scanned++;

  for (const file of walkJsonl(nsDir)) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      summary.errors.push(`${file}: ${e.message}`);
      continue;
    }
    summary.files_scanned++;
    nsStat.files++;

    const text = buf.toString("utf8");
    // No transcript field at all -> nothing that can be an empty payload row.
    if (!TRANSCRIPT_RE.test(text)) continue;

    const lines = text.split("\n");
    const keep = [];
    let purged = 0;
    let contentLines = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      contentLines++;
      if (t.startsWith("{") && EMPTY_RE.test(line)) {
        purged++;
        continue;
      }
      keep.push(line);
    }
    summary.rows_total += contentLines;
    nsStat.rows += contentLines;

    if (purged === 0) continue;
    summary.rows_purged += purged;
    nsStat.purged += purged;
    summary.bytes_before += buf.length;
    const out = Buffer.from(keep.join("\n"), "utf8");
    summary.bytes_after += out.length;
    const reclaimed = buf.length - out.length;
    summary.bytes_reclaimed += reclaimed;
    nsStat.reclaimed += reclaimed;
    summary.files_changed++;
    nsStat.files_changed++;

    if (!opts.apply) continue;

    // backup, then write, then verify by re-reading
    const rel = path.relative(opts.root, file);
    const dst = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(file, dst);
    fs.writeFileSync(file, out);

    const back = fs.readFileSync(file, "utf8").split("\n");
    if (back.length !== keep.length) {
      summary.errors.push(
        `${file}: VERIFY FAILED expected ${keep.length} lines, found ${back.length}`,
      );
    } else {
      for (let i = 0; i < keep.length; i++) {
        if (back[i] !== keep[i]) {
          summary.errors.push(`${file}: line ${i} differs after write`);
          break;
        }
      }
    }
  }
  if (nsStat.purged > 0) summary.per_namespace[ns] = nsStat;
}

if (opts.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(`empty-payload purge — ${opts.apply ? "APPLY" : "DRY RUN"}`);
  console.log(`  root:        ${summary.root}`);
  console.log(`  namespaces:  ${summary.namespaces_scanned} scanned`);
  console.log(
    `  files:       ${summary.files_scanned} scanned, ${summary.files_changed} with empty rows`,
  );
  console.log(
    `  rows:        ${summary.rows_total.toLocaleString()} total, ${summary.rows_purged.toLocaleString()} empty`,
  );
  console.log(
    `  bytes:       ${mb(summary.bytes_before)} MB -> ${mb(summary.bytes_after)} MB (${mb(summary.bytes_reclaimed)} MB reclaimed)`,
  );
  const top = Object.entries(summary.per_namespace)
    .sort((a, b) => b[1].purged - a[1].purged)
    .slice(0, 8);
  if (top.length) {
    console.log("  worst namespaces:");
    for (const [n, s] of top)
      console.log(
        `    ${n.padEnd(34)} ${String(s.purged).padStart(8)} rows  ${mb(s.reclaimed).padStart(7)} MB`,
      );
  }
  if (opts.apply) console.log(`  backup:      ${backupDir}`);
  else console.log("  nothing was written (dry run). re-run with --apply.");
  if (summary.errors.length) {
    console.log(`  ERRORS: ${summary.errors.length}`);
    for (const e of summary.errors.slice(0, 5)) console.log(`    ${e}`);
  }
}
process.exit(summary.errors.length ? 1 : 0);
