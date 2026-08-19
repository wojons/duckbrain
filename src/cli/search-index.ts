/**
 * `duckbrain search-index` CLI — keyword search index management (RETR-001)
 *
 * Subcommands:
 *   rebuild [--namespace=X] [--detached] [--log=PATH]
 *                                       Rebuild the FTS sidecar for one or all namespaces
 *   status  [--namespace=X]             Show index status for a namespace
 *   install-hooks [--namespace=X]       Install git hooks that rebuild on clone/pull/rewrite
 *
 * The index is a gitignored, rebuildable cache (Q-7 doctrine — mirror of
 * `duckbrain embeddings`). Rebuilds are idempotent: the sidecar directory
 * is wiped and recreated from the namespace JSONL.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getConfig } from "../config/index";
import {
  ensureSearchGitignored,
  indexStatus,
  listNamespaces,
  rebuildAllNamespaces,
  rebuildNamespaceIndex,
  SEARCH_INDEX_DIR,
} from "../search/index";
import { installSearchHooks, SEARCH_SKIP_ENV } from "../search/hooks";
import {
  resolveNamespaceName,
  resolveNamespacePath,
} from "../mcp/tools/shared";

interface SearchIndexArgs {
  action: string;
  namespace?: string;
  detached?: boolean;
  log?: string;
}

export function parseArgs(args: string[]): SearchIndexArgs {
  const out: SearchIndexArgs = { action: args[0] ?? "status" };
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--namespace") {
      // space-separated form: --namespace test-ns (used by git hooks)
      out.namespace = rest[++i];
    } else if (a.startsWith("--namespace=")) {
      out.namespace = a.slice("--namespace=".length);
    } else if (a === "--detached") {
      out.detached = true;
    } else if (a === "--log") {
      out.log = rest[++i];
    } else if (a.startsWith("--log=")) {
      out.log = a.slice("--log=".length);
    }
  }
  return out;
}

async function cmdRebuild(opts: SearchIndexArgs): Promise<void> {
  if (opts.namespace) {
    const nsName = resolveNamespaceName(opts.namespace);
    const nsPath = resolveNamespacePath(nsName);
    if (!fs.existsSync(nsPath)) {
      console.error(`Error: Namespace '${nsName}' not found at ${nsPath}`);
      process.exitCode = 1;
      return;
    }

    if (opts.detached) {
      // Re-spawn detached: git hook context must return immediately
      // (mirror of the embeddings detached rebuild).
      const bin = process.argv[1];
      const childArgs = [
        bin,
        "search-index",
        "rebuild",
        `--namespace=${nsName}`,
      ];
      if (opts.log) childArgs.push(`--log=${opts.log}`);
      const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [SEARCH_SKIP_ENV]: "1" },
      });
      child.unref();
      console.log(
        `Detached search-index rebuild started for namespace '${nsName}' (pid ${child.pid})`,
      );
      return;
    }

    ensureSearchGitignored(nsPath);
    const start = Date.now();
    console.error(
      `[search-index] Rebuilding index for namespace '${nsName}' @ ${path.join(nsPath, SEARCH_INDEX_DIR)}`,
    );
    const meta = await rebuildNamespaceIndex(nsPath);
    if (opts.log) {
      fs.mkdirSync(path.dirname(opts.log), { recursive: true });
      fs.appendFileSync(
        opts.log,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          namespace: nsName,
          ...meta,
        }) + "\n",
      );
    }
    console.log(
      JSON.stringify(
        { namespace: nsName, ...meta, wallMs: Date.now() - start },
        null,
        2,
      ),
    );
    return;
  }

  // No --namespace: rebuild every namespace under the namespaces root.
  const root = getConfig(".").namespacesPath;
  const namespaces = listNamespaces(root);
  if (namespaces.length === 0) {
    console.error(`No namespaces found under ${root} — nothing to rebuild.`);
    process.exitCode = 1;
    return;
  }
  console.error(
    `[search-index] Rebuilding indexes for ${namespaces.length} namespace(s) under ${root}…`,
  );
  const results = await rebuildAllNamespaces(root);
  const summary = Object.fromEntries(
    Object.entries(results).map(([ns, meta]) => [
      ns,
      { rowCount: meta.rowCount, durationMs: meta.durationMs },
    ]),
  );
  console.log(JSON.stringify({ namespaces: summary }, null, 2));
}

async function cmdStatus(opts: SearchIndexArgs): Promise<void> {
  const nsName = resolveNamespaceName(opts.namespace);
  const nsPath = resolveNamespacePath(nsName);
  if (!fs.existsSync(nsPath)) {
    console.error(`Error: Namespace '${nsName}' not found at ${nsPath}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(indexStatus(nsPath), null, 2));
}

async function cmdInstallHooks(opts: SearchIndexArgs): Promise<void> {
  const nsName = resolveNamespaceName(opts.namespace);
  const nsPath = resolveNamespacePath(nsName);
  if (!fs.existsSync(nsPath)) {
    console.error(`Error: Namespace '${nsName}' not found at ${nsPath}`);
    process.exitCode = 1;
    return;
  }
  const written = installSearchHooks(nsPath, nsName);
  console.log(
    `Installed search-index rebuild hooks for namespace '${nsName}':`,
  );
  for (const p of written) console.log(`  ${p}`);
  console.log(
    "Hooks fire detached index rebuilds on clone/pull/rewrite (Q-7 cache doctrine).",
  );
}

export async function runSearchIndexCLI(args: string[]): Promise<void> {
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
    default:
      console.error(`Unknown search-index action: ${opts.action}`);
      console.error("Actions: rebuild | status | install-hooks");
      process.exitCode = 1;
  }
}
