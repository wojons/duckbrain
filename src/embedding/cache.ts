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
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

/** Default cache directory name inside a namespace */
export const EMBEDDING_CACHE_DIR = ".embeddings";

/** Per-model entry: content hash → vector (stored as one JSON file per entry) */
export interface CachedEmbedding {
  modelId: string;
  contentHash: string;
  dimensions: number;
  vector: number[];
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
    const key = this.entryKey(modelId, contentHash);
    // Shard by first 2 chars to keep directories small
    return path.join(
      this.root,
      modelId.replace(/[^a-zA-Z0-9._-]/g, "_"),
      key.slice(0, 2),
      `${key}.json`,
    );
  }

  private modelDir(modelId: string): string {
    return path.join(this.root, modelId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  }

  /** Get cached vector for (model, contentHash). Returns null on miss/corrupt. */
  get(modelId: string, contentHash: string): number[] | null {
    const p = this.entryPath(modelId, contentHash);
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
    const entry: CachedEmbedding = {
      modelId,
      contentHash,
      dimensions: vector.length,
      vector,
      createdAt: new Date().toISOString(),
    };
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, p);
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
        else if (ent.name.endsWith(".json")) n++;
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
