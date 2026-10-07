/**
 * Content-Addressed Embedding Cache Store
 *
 * Embeddings are NEVER stored in git. They live in a per-namespace cache
 * directory (default `<namespace>/.embeddings/`, gitignored) keyed by
 * `sha256(modelId + "\x00" + contentHash)` where contentHash is the sha256 of
 * the embedding_text. This gives us:
 *
 *   - Model-agnostic: each model has its own cache namespace. Different people
 *     can use different embedding models without corrupting each other.
 *   - Cache-assisted rebuild: unchanged content hashes hit the cache; only
 *     new/changed content needs re-embedding. Clones/pulls rebuild quickly
 *     with cache assist (old/foreign-model entries just take longer).
 *   - No git bloat: vectors are derivable artifacts, not source of truth.
 *
 * On-disk format (DB-GAP-054): each entry is ONE binary `.bin` file at the
 * same content-addressed path as before:
 *
 *   bytes 0..3   uint32 LE magic 0x44424633 ("DBF3") — anything else is rejected
 *   bytes 4..7   uint32 LE length N of the UTF-8 JSON header
 *   bytes 8..8+N JSON header: {"modelId","contentHash","dimensions","createdAt"}
 *   then         dimensions * 4 bytes LE float32 vector payload
 *
 * Legacy JSON-per-entry files (`<key>.json`) are still READ (read-only
 * fallback) so old caches keep working; `migrate()` converts them to `.bin`
 * and `duckbrain embeddings migrate` invokes it per namespace.
 * A float32 4096-dim entry is ~16 KB vs ~88 KB as JSON (≈5.5x smaller).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

/** Default cache directory name inside a namespace */
export const EMBEDDING_CACHE_DIR = ".embeddings";

/** Per-model entry: content hash → vector (stored as one file per entry) */
export interface CachedEmbedding {
  modelId: string;
  contentHash: string;
  dimensions: number;
  vector: number[];
  createdAt: string;
}

/** Magic "DBF3" little-endian — every new-format cache entry starts with it */
export const EMBEDDING_CACHE_MAGIC = 0x44424633;

interface CacheHeader {
  modelId: string;
  contentHash: string;
  dimensions: number;
  createdAt: string;
}

export class EmbeddingCache {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  static forNamespace(
    namespacePath: string,
    cacheDir = EMBEDDING_CACHE_DIR,
  ): EmbeddingCache {
    return new EmbeddingCache(path.join(namespacePath, cacheDir));
  }

  /** sha256 of raw text — content key, model-independent */
  static contentHash(text: string): string {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
  }

  /** Full cache key: model-scoped hash of the content hash */
  private entryKey(modelId: string, contentHash: string): string {
    return crypto
      .createHash("sha256")
      .update(`${modelId}\x00${contentHash}`, "utf8")
      .digest("hex");
  }

  private entryPath(modelId: string, contentHash: string): string {
    return this.entryPathExt(modelId, contentHash, ".bin");
  }

  private entryPathExt(
    modelId: string,
    contentHash: string,
    ext: string,
  ): string {
    const key = this.entryKey(modelId, contentHash);
    // Shard by first 2 chars to keep directories small
    return path.join(
      this.root,
      modelId.replace(/[^a-zA-Z0-9._-]/g, "_"),
      key.slice(0, 2),
      `${key}${ext}`,
    );
  }

  private modelDir(modelId: string): string {
    return path.join(this.root, modelId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  }

  /** Get cached vector for (model, contentHash). Returns null on miss/corrupt. */
  get(modelId: string, contentHash: string): number[] | null {
    // New binary format first; legacy JSON kept as a read-only fallback so
    // old caches keep working until migrated.
    const bin = this.readBin(
      this.entryPathExt(modelId, contentHash, ".bin"),
    );
    if (bin) return bin;
    return this.readLegacyJson(
      this.entryPathExt(modelId, contentHash, ".json"),
    );
  }

  private readBin(p: string): number[] | null {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(p);
    } catch {
      return null;
    }
    try {
      if (buf.length < 8) return null;
      if (buf.readUInt32LE(0) !== EMBEDDING_CACHE_MAGIC) return null;
      const headerLen = buf.readUInt32LE(4);
      if (8 + headerLen + 4 > buf.length) return null;
      const header = JSON.parse(
        buf.subarray(8, 8 + headerLen).toString("utf8"),
      ) as CacheHeader;
      if (
        !Number.isInteger(header.dimensions) ||
        header.dimensions <= 0 ||
        8 + headerLen + header.dimensions * 4 !== buf.length
      )
        return null;
      const out: number[] = new Array(header.dimensions);
      for (let i = 0; i < header.dimensions; i++) {
        out[i] = buf.readFloatLE(8 + headerLen + i * 4);
      }
      return out;
    } catch {
      return null;
    }
  }

  private readLegacyJson(p: string): number[] | null {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const entry = JSON.parse(raw) as CachedEmbedding;
      if (!Array.isArray(entry.vector) || entry.vector.length === 0)
        return null;
      return entry.vector;
    } catch {
      return null;
    }
  }

  /** Store a vector for (model, contentHash). Atomic write via tmp+rename. */
  set(modelId: string, contentHash: string, vector: number[]): void {
    const p = this.entryPath(modelId, contentHash);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const header: CacheHeader = {
      modelId,
      contentHash,
      dimensions: vector.length,
      createdAt: new Date().toISOString(),
    };
    const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
    const buf = Buffer.allocUnsafe(8 + headerBuf.length + vector.length * 4);
    buf.writeUInt32LE(EMBEDDING_CACHE_MAGIC, 0);
    buf.writeUInt32LE(headerBuf.length, 4);
    headerBuf.copy(buf, 8);
    for (let i = 0; i < vector.length; i++) {
      buf.writeFloatLE(vector[i], 8 + headerBuf.length + i * 4);
    }
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p);
  }

  /**
   * Convert every legacy `<key>.json` entry in the cache dir to the `.bin`
   * format and delete the JSON file. Does NOT re-embed — the in-file vector
   * is re-serialized to float32. Returns converted + skipped counts.
   */
  migrate(legacyOnly = true): { converted: number; skipped: number } {
    let converted = 0;
    let skipped = 0;
    if (!fs.existsSync(this.root)) return { converted, skipped };
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        if (!ent.name.endsWith(".json") || ent.name.endsWith(".json.tmp"))
          continue;
        try {
          const raw = fs.readFileSync(full, "utf8");
          const entry = JSON.parse(raw) as CachedEmbedding;
          if (!Array.isArray(entry.vector) || entry.vector.length === 0) {
            skipped++;
            continue;
          }
          const binPath = `${full.slice(0, -5)}.bin`;
          if (legacyOnly && fs.existsSync(binPath)) {
            skipped++;
            continue;
          }
          fs.mkdirSync(path.dirname(binPath), { recursive: true });
          const header: CacheHeader = {
            modelId: entry.modelId,
            contentHash: entry.contentHash,
            dimensions: entry.dimensions ?? entry.vector.length,
            createdAt: entry.createdAt,
          };
          const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
          const buf = Buffer.allocUnsafe(
            8 + headerBuf.length + entry.vector.length * 4,
          );
          buf.writeUInt32LE(EMBEDDING_CACHE_MAGIC, 0);
          buf.writeUInt32LE(headerBuf.length, 4);
          headerBuf.copy(buf, 8);
          for (let i = 0; i < entry.vector.length; i++) {
            buf.writeFloatLE(entry.vector[i], 8 + headerBuf.length + i * 4);
          }
          fs.writeFileSync(binPath, buf);
          fs.unlinkSync(full);
          converted++;
        } catch {
          skipped++;
        }
      }
    };
    walk(this.root);
    return { converted, skipped };
  }

  /** Has (model, contentHash) got a valid cached vector? */
  has(modelId: string, contentHash: string): boolean {
    return this.get(modelId, contentHash) !== null;
  }

  /** Count entries for a model (or all models when modelId omitted) */
  count(modelId?: string): number {
    const base = modelId ? this.modelDir(modelId) : this.root;
    if (!fs.existsSync(base)) return 0;
    let n = 0;
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith(".json") || ent.name.endsWith(".bin")) n++;
      }
    };
    walk(base);
    return n;
  }

  /** Total size on disk in bytes */
  sizeBytes(): number {
    if (!fs.existsSync(this.root)) return 0;
    let total = 0;
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(this.root);
    return total;
  }

  /** List model ids present in the cache */
  models(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }
}

/**
 * Ensure the namespace `.gitignore` excludes the embedding cache.
 * Creates `.gitignore` if missing; appends the entry if absent.
 */
export function ensureCacheGitignored(
  namespacePath: string,
  cacheDir = EMBEDDING_CACHE_DIR,
): void {
  const giPath = path.join(namespacePath, ".gitignore");
  const entry = `/${cacheDir}/`;
  let content = "";
  if (fs.existsSync(giPath)) {
    content = fs.readFileSync(giPath, "utf8");
    if (
      content.includes(entry) ||
      content
        .split("\n")
        .map((l) => l.trim())
        .includes(cacheDir)
    ) {
      return;
    }
    content = content.endsWith("\n") ? content : `${content}\n`;
  }
  fs.writeFileSync(
    giPath,
    `${content}# DuckBrain embedding cache (rebuildable, never commit)\n${entry}\n`,
  );
}
