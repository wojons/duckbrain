/**
 * Keyword search index — rebuildable FTS sidecar (RETR-001).
 *
 * Per-namespace cache living at `<namespace>/.search/` (gitignored, never
 * committed — mirror of the `.embeddings` cache doctrine, Q-7). The index
 * is a DuckDB file holding:
 *
 *   - `memories` — the live (non-tombstoned, latest-per-id) memory rows
 *     with a `raw_text` column (key + content + attributes, untouched) and
 *     a `search_text` column (digit-mapped, see transform.ts) so the FTS
 *     tokenizer can index ticket IDs / cron IDs / UUIDs.
 *   - an FTS index over (id, search_text) via the extension's
 *     `create_fts_index` pragma.
 *
 * Rebuilds are idempotent: the sidecar directory is deleted and rebuilt
 * from the namespace JSONL (parsed with JSON.parse per line — never
 * read_json_auto — per the DOGFOOD-010/018/019 duplicate-key constraint).
 *
 * The FTS extension follows the same INSTALL/LOAD pattern as the VSS
 * extension (src/duckdb/vss.ts): `INSTALL fts` on first use (one-time
 * download), `LOAD fts` thereafter. The sidecar uses its OWN connection —
 * never the namespace singleton, which must stay extension-free
 * (connection.ts Napi::Error history).
 */

import fs from "fs";
import path from "path";
import { Database } from "duckdb";
import { mapDigits } from "./transform";

/** Sidecar directory name inside a namespace (mirrors EMBEDDING_CACHE_DIR). */
export const SEARCH_INDEX_DIR = ".search";

/** DuckDB file holding the base table + FTS index. */
export const INDEX_DB_NAME = "fts.duckdb";

/** Meta file written after every successful rebuild. */
export const INDEX_META_NAME = "meta.json";

/** Explicit all-VARCHAR read_json schema for the staged row file. */
export const SEARCH_ROW_COLUMNS =
  "columns={id:'VARCHAR', key:'VARCHAR', domain:'VARCHAR', timestamp:'VARCHAR', author:'VARCHAR', action:'VARCHAR', embedding_text:'VARCHAR', attributes:'VARCHAR', raw_text:'VARCHAR', search_text:'VARCHAR'}";

/** DuckDB connection options — one thread, matching connection.ts. */
export const DB_CONFIG = { threads: "1" };

export function sidecarDir(namespacePath: string): string {
  return path.join(namespacePath, SEARCH_INDEX_DIR);
}

export function indexDbPath(namespacePath: string): string {
  return path.join(sidecarDir(namespacePath), INDEX_DB_NAME);
}

export function indexMetaPath(namespacePath: string): string {
  return path.join(sidecarDir(namespacePath), INDEX_META_NAME);
}

export interface IndexMeta {
  version: number;
  indexedAt: string;
  rowCount: number;
  sourceFiles: number;
  durationMs: number;
}

/**
 * Ensure the namespace `.gitignore` excludes the search index sidecar.
 * Mirrors ensureCacheGitignored (src/embedding/cache.ts).
 */
export function ensureSearchGitignored(namespacePath: string): void {
  const giPath = path.join(namespacePath, ".gitignore");
  const entry = `/${SEARCH_INDEX_DIR}/`;
  let content = "";
  if (fs.existsSync(giPath)) {
    content = fs.readFileSync(giPath, "utf8");
    if (
      content.includes(entry) ||
      content
        .split("\n")
        .map((l) => l.trim())
        .includes(SEARCH_INDEX_DIR)
    ) {
      return;
    }
    content = content.endsWith("\n") ? content : `${content}\n`;
  }
  fs.writeFileSync(
    giPath,
    `${content}# DuckBrain search index (rebuildable, never commit)\n${entry}\n`,
  );
}

/** A raw memory record as read from a JSONL partition file. */
export interface MemoryRecord {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author: string;
  action: string;
  embedding_text: string;
  attributes: Record<string, unknown>;
}

/**
 * Collect the LIVE memory rows of a namespace.
 *
 * Walks every *.jsonl file under the namespace (skipping git and cache
 * dirs), parses each line with JSON.parse (safe against duplicate keys —
 * the read_json_auto constraint applies to SQL, which this path avoids),
 * keeps the latest record per id (ISO timestamp compare, later file/line
 * wins ties) and drops ids whose latest record is a tombstone — the same
 * semantics as queryMemories' ROW_NUMBER() dedup.
 */
export function collectLiveMemoryRows(namespacePath: string): MemoryRecord[] {
  const latest = new Map<
    string,
    { rec: MemoryRecord; ts: string; order: number }
  >();
  let order = 0;
  let sourceFiles = 0;

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === ".git" ||
          ent.name === ".embeddings" ||
          ent.name === SEARCH_INDEX_DIR
        ) {
          continue;
        }
        walk(full);
      } else if (ent.name.endsWith(".jsonl")) {
        sourceFiles += 1;
        try {
          const lines = fs.readFileSync(full, "utf8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const rec = JSON.parse(line) as Partial<MemoryRecord>;
              if (typeof rec.id !== "string" || !rec.id) continue;
              const text =
                typeof rec.embedding_text === "string"
                  ? rec.embedding_text
                  : typeof (rec as any).content === "string"
                    ? ((rec as any).content as string)
                    : "";
              const norm: MemoryRecord = {
                id: rec.id,
                key: typeof rec.key === "string" ? rec.key : "",
                domain:
                  typeof rec.domain === "string" ? rec.domain : "raw_note",
                timestamp:
                  typeof rec.timestamp === "string" ? rec.timestamp : "",
                author: typeof rec.author === "string" ? rec.author : "",
                action: typeof rec.action === "string" ? rec.action : "add",
                embedding_text: text,
                attributes:
                  rec.attributes && typeof rec.attributes === "object"
                    ? (rec.attributes as Record<string, unknown>)
                    : {},
              };
              const prev = latest.get(norm.id);
              // Latest record wins: newer timestamp, or (on ties) later in
              // the file order — matches ROW_NUMBER() ORDER BY timestamp DESC.
              if (
                !prev ||
                norm.timestamp > prev.ts ||
                (norm.timestamp === prev.ts && order > prev.order)
              ) {
                latest.set(norm.id, { rec: norm, ts: norm.timestamp, order });
              }
            } catch {
              // Unparseable line — skip (mirrors collectEmbeddingTexts).
            }
          }
        } catch {
          // Unreadable file — skip.
        }
        order += 1;
      }
    }
  };
  walk(namespacePath);

  const rows: MemoryRecord[] = [];
  for (const { rec } of latest.values()) {
    if (rec.action === "tombstone") continue;
    rows.push(rec);
  }
  return rows;
}

/** Build the raw searchable text for a record (key + content + attributes). */
export function buildRawText(rec: MemoryRecord): string {
  const attrs = safeStringify(rec.attributes);
  return [rec.key, rec.embedding_text, attrs].filter((s) => s).join(" ");
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

function execAsync(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

function closeAsync(db: Database): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}

/**
 * Rebuild the keyword search index for one namespace. Idempotent: the
 * sidecar directory is deleted first, so a re-run always produces the
 * same index. The DuckDB file is built at a temp path and atomically
 * renamed into place so a concurrent reader never sees a half-written
 * index.
 *
 * @returns rebuild stats (rowCount, sourceFiles, durationMs, indexedAt)
 */
export async function rebuildNamespaceIndex(
  namespacePath: string,
): Promise<IndexMeta> {
  const start = Date.now();
  ensureSearchGitignored(namespacePath);

  const rows = collectLiveMemoryRows(namespacePath);
  const dir = sidecarDir(namespacePath);
  // Cache doctrine: wipe the old sidecar entirely before rebuilding.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const dbPath = indexDbPath(namespacePath);
  const tmpDbPath = path.join(dir, `${INDEX_DB_NAME}.tmp`);
  const tmpRowsPath = path.join(dir, "rows.tmp.jsonl");

  // Stage the rows as a temp JSONL (all strings; safe to re-read with the
  // explicit all-VARCHAR schema + ignore_errors — same pattern as
  // READ_JSON_COLUMNS).
  const lines: string[] = [];
  for (const rec of rows) {
    const rawText = buildRawText(rec);
    const record = {
      id: rec.id,
      key: rec.key,
      domain: rec.domain,
      timestamp: rec.timestamp,
      author: rec.author,
      action: rec.action,
      embedding_text: rec.embedding_text,
      attributes: safeStringify(rec.attributes),
      raw_text: rawText,
      search_text: mapDigits(rawText),
    };
    lines.push(safeStringify(record));
  }
  fs.writeFileSync(
    tmpRowsPath,
    lines.join("\n") + (lines.length ? "\n" : ""),
    "utf8",
  );

  const db = new Database(tmpDbPath, DB_CONFIG);
  try {
    await execAsync(db, "LOAD fts;");
    await execAsync(
      db,
      `CREATE TABLE memories (id VARCHAR, key VARCHAR, domain VARCHAR, timestamp VARCHAR, author VARCHAR, action VARCHAR, embedding_text VARCHAR, attributes VARCHAR, raw_text VARCHAR, search_text VARCHAR)`,
    );
    if (lines.length > 0) {
      const fileList = `'${tmpRowsPath.replace(/\\/g, "/")}'`;
      await execAsync(
        db,
        `INSERT INTO memories SELECT * FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${SEARCH_ROW_COLUMNS})`,
      );
    }
    // Create the FTS index over (id, search_text). `id` is the join key
    // used by match_bm25 at query time.
    await execAsync(
      db,
      `PRAGMA create_fts_index('memories', 'id', 'search_text')`,
    );
  } finally {
    await closeAsync(db);
  }

  // Atomic swap into place; drop the staged rows file.
  fs.renameSync(tmpDbPath, dbPath);
  fs.rmSync(tmpRowsPath, { force: true });

  const meta: IndexMeta = {
    version: 1,
    indexedAt: new Date().toISOString(),
    rowCount: rows.length,
    sourceFiles: countSourceFiles(namespacePath),
    durationMs: Date.now() - start,
  };
  fs.writeFileSync(indexMetaPath(namespacePath), safeStringify(meta), "utf8");
  return meta;
}

function countSourceFiles(namespacePath: string): number {
  let n = 0;
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === ".git" ||
          ent.name === ".embeddings" ||
          ent.name === SEARCH_INDEX_DIR
        ) {
          continue;
        }
        walk(full);
      } else if (ent.name.endsWith(".jsonl")) {
        n += 1;
      }
    }
  };
  walk(namespacePath);
  return n;
}

/**
 * Enumerate namespace directories under a namespaces root (directories
 * that carry a manifest.json — i.e. real namespaces, not stray dirs).
 */
export function listNamespaces(namespacesRoot: string): string[] {
  if (!fs.existsSync(namespacesRoot)) return [];
  return fs
    .readdirSync(namespacesRoot, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        fs.existsSync(path.join(namespacesRoot, e.name, "manifest.json")),
    )
    .map((e) => e.name)
    .sort();
}

/**
 * Rebuild the search index for every namespace under the given root.
 *
 * @returns per-namespace rebuild results keyed by namespace name
 */
export async function rebuildAllNamespaces(
  namespacesRoot: string,
): Promise<Record<string, IndexMeta>> {
  const out: Record<string, IndexMeta> = {};
  for (const ns of listNamespaces(namespacesRoot)) {
    out[ns] = await rebuildNamespaceIndex(path.join(namespacesRoot, ns));
  }
  return out;
}

export interface SearchIndexStatus {
  namespace: string;
  indexExists: boolean;
  dbPath: string;
  meta: IndexMeta | null;
  sizeBytes: number;
  gitignored: boolean;
}

/** Read the meta file, tolerating a missing/corrupt one. */
export function readIndexMeta(namespacePath: string): IndexMeta | null {
  try {
    const raw = fs.readFileSync(indexMetaPath(namespacePath), "utf8");
    const parsed = JSON.parse(raw) as IndexMeta;
    if (typeof parsed?.indexedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function indexStatus(namespacePath: string): SearchIndexStatus {
  const dbPath = indexDbPath(namespacePath);
  const exists = fs.existsSync(dbPath);
  let sizeBytes = 0;
  if (exists) {
    try {
      sizeBytes = fs.statSync(dbPath).size;
    } catch {
      // Best-effort.
    }
  }
  const gi = path.join(namespacePath, ".gitignore");
  let gitignored = false;
  if (fs.existsSync(gi)) {
    gitignored = fs.readFileSync(gi, "utf8").includes(SEARCH_INDEX_DIR);
  }
  return {
    namespace: path.basename(namespacePath),
    indexExists: exists,
    dbPath,
    meta: readIndexMeta(namespacePath),
    sizeBytes,
    gitignored,
  };
}

/** Error thrown when a search is attempted without an index (or a stale
 *  half-written one). Carries the rebuild hint for CLI/HTTP surfacing. */
export class SearchIndexMissingError extends Error {
  constructor(namespace: string, nsPath: string) {
    super(
      `No keyword search index for namespace '${namespace}' at ${sidecarDir(nsPath)} — run 'duckbrain search-index rebuild${namespace !== "default" ? ` --namespace=${namespace}` : ""}' first`,
    );
    this.name = "SearchIndexMissingError";
  }
}
