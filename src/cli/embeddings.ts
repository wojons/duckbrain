/**
 * `duckbrain embeddings` CLI — embedding cache management
 *
 * Subcommands:
 *   rebuild [--namespace=X] [--force] [--concurrency=N] [--detached] [--log=PATH]
 *   status  [--namespace=X]
 *   install-hooks [--namespace=X]
 *   providers
 *
 * The embedding cache is gitignored and content-addressed (see
 * src/embedding/cache.ts). Rebuilds are cache-assisted: unchanged content is
 * skipped, only new/changed content is embedded.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import {
  EmbeddingCache,
  ensureCacheGitignored,
  EMBEDDING_CACHE_DIR,
} from "../embedding/cache.js";
import {
  rebuildNamespace,
  collectEmbeddingTexts,
} from "../embedding/rebuild.js";
import {
  createAutoProvider,
  listProviders,
  resolveEmbeddingConfig,
} from "../embedding/providers.js";
import {
  installEmbeddingHooks,
  embeddingHooksInstalled,
} from "../embedding/hooks.js";
import { getConfig } from "../config/index.js";

interface EmbeddingsArgs {
  action: string;
  namespace?: string;
  force?: boolean;
  concurrency?: number;
  detached?: boolean;
  log?: string;
}

export function parseArgs(args: string[]): EmbeddingsArgs {
  const out: EmbeddingsArgs = { action: args[0] ?? "status" };
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--force") out.force = true;
    else if (a === "--detached") out.detached = true;
    else if (a === "--namespace") {
      // space-separated form: --namespace test-ns (used by git hooks)
      out.namespace = rest[++i];
    } else if (a.startsWith("--namespace="))
      out.namespace = a.slice("--namespace=".length);
    else if (a === "--concurrency") {
      out.concurrency = parseInt(rest[++i], 10);
    } else if (a.startsWith("--concurrency="))
      out.concurrency = parseInt(a.slice("--concurrency=".length), 10);
    else if (a === "--log") {
      out.log = rest[++i];
    } else if (a.startsWith("--log=")) out.log = a.slice("--log=".length);
  }
  return out;
}

function resolveNamespacePath(name: string | undefined): {
  name: string;
  nsPath: string;
} {
  const config = getConfig();
  const ns = name ?? config.defaultNamespace ?? "default";
  const mapped = config.namespaceMappings?.[ns];
  let nsPath = mapped ?? path.join(process.cwd(), "namespaces", ns);
  if (!path.isAbsolute(nsPath)) {
    nsPath = path.resolve(process.cwd(), nsPath);
  }
  if (!fs.existsSync(nsPath)) {
    throw new Error(`Namespace '${ns}' not found at ${nsPath}`);
  }
  return { name: ns, nsPath };
}

async function cmdRebuild(opts: EmbeddingsArgs): Promise<void> {
  const { name, nsPath } = resolveNamespacePath(opts.namespace);
  const cache = EmbeddingCache.forNamespace(nsPath);
  ensureCacheGitignored(nsPath);

  if (opts.detached) {
    // Re-spawn detached: hook context must return immediately
    const bin = process.argv[1];
    const child = spawn(
      process.execPath,
      [bin, "embeddings", "rebuild", `--namespace=${name}`],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, DUCKBRAIN_SKIP_EMBED_REBUILD: "1" },
      },
    );
    child.unref();
    console.log(
      `Detached rebuild started for namespace '${name}' (pid ${child.pid})`,
    );
    return;
  }

  console.error(
    `[embeddings] Rebuilding cache for namespace '${name}' @ ${cache.root}`,
  );
  console.error(`[embeddings] Scanning JSONL partitions…`);
  const texts = collectEmbeddingTexts(nsPath);
  console.error(`[embeddings] Found ${texts.length} unique embedding texts`);

  const cfg = resolveEmbeddingConfig();
  const provider = await createAutoProvider(cfg);
  if (!provider) {
    console.error(
      `[embeddings] No embedding provider reachable (configured: ${cfg.provider}). ` +
        `Start LM Studio/Ollama or set DUCKBRAIN_EMBEDDING_PROVIDER. Skipping embed.`,
    );
    console.error(
      JSON.stringify(
        {
          namespace: name,
          total: texts.length,
          embedded: 0,
          cacheHits: 0,
          modelId: "none",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  console.error(
    `[embeddings] Using provider ${provider.id} (dims ${provider.dimensions})`,
  );
  const last = { pct: -1 };
  const result = await rebuildNamespace(nsPath, cache, provider, {
    force: opts.force,
    concurrency: opts.concurrency,
    onProgress: ({ done, total, embedded, cacheHits, skipped }) => {
      const pct = Math.floor((done / Math.max(1, total)) * 100);
      if (pct !== last.pct) {
        last.pct = pct;
        console.error(
          `[embeddings] ${pct}% (${done}/${total}) embedded=${embedded} cacheHits=${cacheHits} skipped=${skipped}`,
        );
      }
    },
  });

  if (opts.log) {
    fs.mkdirSync(path.dirname(opts.log), { recursive: true });
    const summary = {
      timestamp: new Date().toISOString(),
      namespace: name,
      ...result,
    };
    fs.appendFileSync(opts.log, JSON.stringify(summary) + "\n");
  }

  console.log(JSON.stringify({ namespace: name, ...result }, null, 2));
  if (result.failed > 0) {
    console.error(`[embeddings] ${result.failed} embeddings failed:`);
    for (const e of result.errors.slice(0, 5)) console.error(`  - ${e}`);
  }
}

async function cmdStatus(opts: EmbeddingsArgs): Promise<void> {
  const { name, nsPath } = resolveNamespacePath(opts.namespace);
  const cache = EmbeddingCache.forNamespace(nsPath);
  const texts = collectEmbeddingTexts(nsPath);
  const models = cache.models();
  const perModel = Object.fromEntries(models.map((m) => [m, cache.count(m)]));
  const hooks = embeddingHooksInstalled(nsPath);
  console.log(
    JSON.stringify(
      {
        namespace: name,
        cacheDir: cache.root,
        cacheExists: fs.existsSync(cache.root),
        sizeBytes: cache.sizeBytes(),
        uniqueTexts: texts.length,
        models,
        entriesPerModel: perModel,
        hooksInstalled: hooks,
        gitignored: cacheGitignored(nsPath),
      },
      null,
      2,
    ),
  );
}

function cacheGitignored(nsPath: string): boolean {
  const gi = path.join(nsPath, ".gitignore");
  if (!fs.existsSync(gi)) return false;
  const content = fs.readFileSync(gi, "utf8");
  return content.includes(EMBEDDING_CACHE_DIR);
}

async function cmdInstallHooks(opts: EmbeddingsArgs): Promise<void> {
  const { name, nsPath } = resolveNamespacePath(opts.namespace);
  const written = installEmbeddingHooks(nsPath, name);
  console.log(`Installed embedding rebuild hooks for namespace '${name}':`);
  for (const p of written) console.log(`  ${p}`);
  console.log(
    "Hooks fire detached rebuilds on clone/pull/rewrite (cache-assisted).",
  );
}

function cmdProviders(): void {
  const cfg = resolveEmbeddingConfig();
  console.log(
    JSON.stringify(
      {
        configured: {
          provider: cfg.provider,
          model: cfg.model,
          dimensions: cfg.dimensions,
        },
        available: listProviders(),
        envOverrides: [
          "DUCKBRAIN_EMBEDDING_PROVIDER",
          "DUCKBRAIN_EMBEDDING_MODEL",
          "DUCKBRAIN_EMBEDDING_BASE_URL",
          "DUCKBRAIN_EMBEDDING_API_KEY",
          "DUCKBRAIN_EMBEDDING_DIMENSIONS",
        ],
      },
      null,
      2,
    ),
  );
}

export async function runEmbeddingsCLI(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  switch (opts.action) {
    case "rebuild":
      await cmdRebuild(opts);
      break;
    case "status":
      await cmdStatus(opts);
      break;
    case "install-hooks":
      await cmdInstallHooks(opts);
      break;
    case "providers":
      cmdProviders();
      break;
    default:
      console.error(`Unknown embeddings action: ${opts.action}`);
      console.error("Actions: rebuild | status | install-hooks | providers");
      process.exitCode = 1;
  }
}
