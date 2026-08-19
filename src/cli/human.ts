/**
 * Human Operator CLI Commands
 *
 * Provides human-readable CLI commands for managing memories.
 * These commands call the underlying MCP tools internally.
 *
 * Commands:
 * - remember <key> --domain=<domain> [--content=<text>|--text=<text>|stdin] --attr=<json> [--namespace=<name>]
 * - recall [options]
 * - list-keys [options]
 * - forget <id> [--reason=<reason>]
 * - config show|set
 * - namespaces list|add
 * - status [--namespace=<name>]
 * - ssh-test --host=<user@server>
 */

import { recallTool } from "../mcp/tools/recall";
import { resolveNamespacePath } from "../mcp/tools/shared";
import { resolveAsOfRef } from "../git/asof";
import { searchTool } from "../mcp/tools/search";
import { listKeysTool } from "../mcp/tools/list_keys";
import { rememberTool } from "../mcp/tools/remember";
import { safeJsonStringify } from "../utils/serialize";
import { parseTimeRange } from "../utils/timerange";
import { buildKeyTree, renderKeyTreeText } from "../utils/keyTree";
import { forgetTool } from "../mcp/tools/forget";
import { squashTool, getCompactionStatsTool } from "../mcp/tools/squash";
import {
  getConfig,
  setConfig,
  updateConfig,
  registerNamespace,
} from "../config/index";
import { s3Command } from "../s3/cli";
import {
  connectToRemote,
  checkRemoteInstall,
  installRemote,
} from "../ssh/client";
import { createTunnel, listTunnels } from "../ssh/tunnel";
import { execSync } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

function getDefaultNamespace(): string {
  return getConfig().defaultNamespace || "default";
}

/**
 * Parse command-line arguments
 * Returns object with positional args and named flags
 */
function parseArgs(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      flags[key] = value || "true";
    } else if (arg.startsWith("-")) {
      // Short flags
      flags[arg.slice(1)] = "true";
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

/**
 * Format memory output for human readability
 * Handles BigInt serialization that DuckDB may return
 */
function formatMemory(memory: any): string {
  return safeJsonStringify(memory, 2);
}

/**
 * Format key list as an indented plain-text tree for human readability.
 *
 * Reuses the same hierarchical builder as the REST /api/keys route so the CLI
 * tree and the API tree never drift apart. Keys carry a leading slash
 * ("/projects/duckbrain/status"); the builder filters empty path segments, so
 * no `""` root node is produced (DOGFOOD-009).
 */
function formatKeyTree(keys: string[], depth: number = 2): string {
  return renderKeyTreeText(buildKeyTree(keys, depth));
}

/**
 * Allowed flags for the `remember` command. Any flag outside this set is a
 * typo (e.g. `--conent`) and must be rejected loudly rather than silently
 * ignored — the old parseArgs dropped unknown flags, which let bad invocations
 * store the key as the record body instead of the intended content.
 */
const REMEMBER_FLAGS = new Set([
  "domain",
  "attr",
  "namespace",
  "wait",
  "embedding-text",
  "content",
  "text",
]);

/**
 * Minimal reader surface readStdinBody needs from a Readable stream. Defined as
 * a structural interface so tests can inject a fake reader without touching the
 * real process.stdin fd (which hangs under vitest).
 */
interface StdinLike {
  isTTY?: boolean;
  once(
    event: "data" | "end" | "close" | "error",
    listener: (...a: any[]) => void,
  ): unknown;
}

/**
 * Read a body from stdin when content is piped (non-TTY). Returns the trimmed
 * body, or empty string when stdin is a terminal or produces no data.
 *
 * DOGFOOD-003: the previous implementation stored the KEY as embedding_text by
 * default; the CLI had no way to provide a real memory body. We now prefer an
 * explicit --content/--text flag, and fall back to a piped stdin body when no
 * flag is given. If stdin is a terminal (no pipe) we keep the legacy behaviour
 * of defaulting the body to the key.
 */
async function readStdinBody(
  reader: StdinLike,
  timeoutMs: number = 1000,
): Promise<string> {
  // A real terminal has no piped body to read.
  if (reader.isTTY) return "";
  return new Promise<string>((resolve) => {
    let data = "";
    let settled = false;
    const done = (value: string) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    // Guard against a non-emitting stream (vitest stdin never fires 'end').
    const timer = setTimeout(() => done(data), timeoutMs);
    reader.once("end", () => {
      clearTimeout(timer);
      done(data);
    });
    reader.once("data", (chunk: any) => {
      data += typeof chunk === "string" ? chunk : chunk.toString();
    });
    reader.once("error", () => {
      clearTimeout(timer);
      done("");
    });
    reader.once("close", () => {
      clearTimeout(timer);
      done(data);
    });
  });
}

/** Exported for testing: resolves the body text for a remember invocation. */
export async function resolveRememberBody(
  flags: Record<string, string>,
  key: string,
  reader?: StdinLike,
): Promise<string> {
  // Explicit content flag wins (--content, --text, legacy --embedding-text).
  const explicit = flags.content || flags.text || flags["embedding-text"];
  if (explicit) return explicit;
  // Otherwise try a piped stdin body.
  const body = await readStdinBody(reader ?? process.stdin);
  return body.trim() || key;
}

/**
 * Remember command
 */
async function rememberCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);

  // Reject unknown flags loudly (scoped to remember only — do NOT change
  // parseArgs globally; other commands keep their loose flag handling).
  for (const flag of Object.keys(flags)) {
    if (!REMEMBER_FLAGS.has(flag)) {
      console.error(`Error: unknown flag '--${flag}' for 'remember'.`);
      console.error(
        "Valid flags: --domain=<d> --attr=<json> --namespace=<name> --wait --content=<text> --text=<text> --embedding-text=<text>",
      );
      console.error(
        "Usage: duckbrain remember <key> --domain=<domain> [--content=<text> | --text=<text>] [--attr=<json>] [--namespace=<name>] [--wait]",
      );
      process.exit(1);
    }
  }

  if (positional.length < 1) {
    console.error(
      "Usage: duckbrain remember <key> --domain=<domain> [--content=<text> | --text=<text>] [--attr=<json>] [--namespace=<name>] [--wait]",
    );
    process.exit(1);
  }

  const key = positional[0];
  const domain = flags.domain || "general";
  const namespace = flags.namespace || getDefaultNamespace();
  // Content/body precedence: explicit flag > piped stdin body > key fallback.
  const embeddingText = await resolveRememberBody(flags, key);
  let attributes = {};

  if (flags.attr) {
    try {
      attributes = JSON.parse(flags.attr);
    } catch (error) {
      console.error("Error: --attr must be valid JSON");
      process.exit(1);
    }
  }

  try {
    const result = await rememberTool({
      key,
      domain: domain as
        "message" | "person" | "event" | "concept" | "config" | "raw_note",
      attributes,
      embedding_text: embeddingText,
      namespace,
    });

    if (result.success) {
      console.log(
        `✓ Remembered ${key} (ID: ${result.id}) - will be committed in batch`,
      );
    } else {
      console.error("✗ Failed to remember:", result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * RETR-006: collect repeatable --attr filters from raw args.
 *
 * Supports both `--attr=<name>=<value>` and bare `--attr <name>=<value>`
 * (the bare form's pair lands in `positional`, hence the raw-args scan).
 * Malformed pairs exit with a usage error — never silently dropped.
 */
function collectAttrFilters(
  args: string[],
  positional: string[],
): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let pair: string | undefined;
    if (arg.startsWith("--attr=")) {
      pair = arg.slice("--attr=".length);
    } else if (arg === "--attr") {
      pair = args[i + 1];
      // A following --flag is not a pair — the value is missing.
      if (pair === undefined || pair.startsWith("--")) pair = undefined;
    } else {
      continue;
    }
    if (pair === undefined) {
      console.error(
        "Error: --attr requires <name>=<value> (e.g. --attr=domain=config or --attr domain=config)",
      );
      process.exit(1);
    }
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      console.error(
        `Error: --attr must be <name>=<value> — got '${pair}' (e.g. --attr=domain=config)`,
      );
      process.exit(1);
    }
    attrs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  // Bare `--attr name=value` also reaches `positional` via parseArgs.
  for (const p of positional) {
    const eq = p.indexOf("=");
    if (eq > 0 && eq < p.length - 1) {
      attrs[p.slice(0, eq)] = p.slice(eq + 1);
    }
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

/**
 * Recall command
 */
async function recallCommand(args: string[]): Promise<void> {
  // Handle --help before running any query
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: duckbrain recall [options]`);
    console.log("");
    console.log(
      "Query memories. Defaults to a prefix search over the whole store.",
    );
    console.log("");
    console.log("Options:");
    console.log("  --key=<key>        Exact key lookup");
    console.log("  --prefix=<prefix>  Prefix search (default: /)");
    console.log(
      "  --domain=<domain>  Filter by domain (person|event|concept|message|config|raw_note)",
    );
    console.log("  --query=<text>     Semantic search");
    console.log(
      "  --contains=<text>  Keyword filter (offline full-text search; needs search-index rebuild)",
    );
    console.log(
      "  --after=<iso>      Only rows at or after this ISO-8601 date/datetime (e.g. 2026-08-10 or 2026-08-10T12:00:00Z)",
    );
    console.log(
      "  --before=<iso>     Only rows at or before this ISO-8601 date/datetime (date-only = end of that day)",
    );
    console.log(
      "  --between=<a,b>    Only rows between two ISO-8601 values (shorthand for --after + --before)",
    );
    console.log(
      "  --as-of=<ref>      Read the namespace state as of a git ref or ISO-8601 date (date = nearest commit at-or-before it)",
    );
    console.log(
      "  --attr=<name>=<value>  Attribute filter: only rows whose attributes match name=value (repeatable, e.g. --attr=domain=config --attr=tick=403)",
    );
    console.log("  --limit=<n>        Max results (default: 10)");
    console.log(
      "  --namespace=<name> Select namespace (default: config defaultNamespace)",
    );
    console.log("  --help, -h         Show this help message");
    return;
  }

  const { flags, positional } = parseArgs(args);

  // RETR-006: attribute filters — repeatable --attr=<name>=<value> (or
  // bare `--attr <name>=<value>`). Malformed pairs exit cleanly above.
  const attrFilters = collectAttrFilters(args, positional);

  // RETR-003: time-scoped recall — validate + normalize --after/--before/
  // --between before they reach the tool. Invalid ISO-8601 values exit
  // cleanly with a message (no stack, no partial query).
  let timeRange: { after?: string; before?: string };
  try {
    timeRange = parseTimeRange({
      after: flags.after,
      before: flags.before,
      between: flags.between,
    });
  } catch (error) {
    console.error("✗", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // RETR-004: memory-as-of — resolve --as-of to a concrete commit up front
  // (date → nearest commit at-or-before; hash/branch/tag used directly).
  // Invalid values exit cleanly, mirroring the time-range validation above.
  let asOfRef: string | undefined;
  if (flags["as-of"] !== undefined) {
    const nsPath = resolveNamespacePath(
      flags.namespace || getDefaultNamespace(),
    );
    try {
      asOfRef = resolveAsOfRef(flags["as-of"], nsPath);
    } catch (error) {
      console.error("✗", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  const input: any = {
    namespace: flags.namespace || getDefaultNamespace(),
    limit: parseInt(flags.limit) || 10,
    ...(timeRange.after ? { after: timeRange.after } : {}),
    ...(timeRange.before ? { before: timeRange.before } : {}),
    // RETR-004: pass the RESOLVED commit so the tool never re-resolves
    // against a different HEAD mid-request.
    ...(asOfRef ? { asOf: asOfRef } : {}),
    // RETR-006: repeatable --attr filters (empty = no-op).
    ...(attrFilters ? { attr: attrFilters } : {}),
  };

  if (flags.key) {
    input.mode = "exact";
    input.key = flags.key;
  } else if (flags.prefix) {
    input.mode = "prefix";
    input.prefix = flags.prefix;
  } else if (flags.domain) {
    input.mode = "domain";
    input.domain = flags.domain;
  } else if (flags.query) {
    input.mode = "semantic";
    input.query = flags.query;
  } else if (flags.contains) {
    // RETR-001: keyword filter path (offline).
    input.mode = "keyword";
    input.contains = flags.contains;
  } else {
    input.mode = "prefix";
    input.prefix = "/";
  }

  try {
    const result = await recallTool(input);

    if (result.memories && result.memories.length > 0) {
      console.log(`Found ${result.memories.length} memories:`);
      for (const memory of result.memories) {
        console.log(formatMemory(memory));
      }
    } else {
      console.log("No memories found");
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Search command (RETR-001)
 *
 * Keyword full-text search over a namespace's rebuilt FTS sidecar:
 * `duckbrain search "GAP-020"`. Offline — no embedding provider needed.
 */
async function searchCommand(args: string[]): Promise<void> {
  // Handle --help before running any query
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: duckbrain search <query> [options]`);
    console.log("");
    console.log(
      "Full-text keyword search over memories (content, key, attributes).",
    );
    console.log("Requires the search index: duckbrain search-index rebuild");
    console.log("");
    console.log("Options:");
    console.log(
      "  --namespace=<name> Select namespace (default: config defaultNamespace)",
    );
    console.log("  --limit=<n>        Max results (default: 10)");
    console.log("  --help, -h         Show this help message");
    console.log("");
    console.log("Examples:");
    console.log('  duckbrain search "GAP-020"');
    console.log('  duckbrain search "GAP-02*" --namespace=default --limit=20');
    return;
  }

  const { positional, flags } = parseArgs(args);

  const query = positional.join(" ").trim();
  if (!query) {
    console.error("Error: search requires a query");
    console.error(
      "Usage: duckbrain search <query> [--namespace=<name>] [--limit=<n>]",
    );
    process.exit(1);
  }

  const limit = parseInt(flags.limit) || 10;
  const namespace = flags.namespace || getDefaultNamespace();

  try {
    const result = await searchTool({
      query,
      namespace,
      limit,
    });

    if (result.error) {
      console.error(`✗ ${result.error}`);
      process.exit(1);
    }

    if (result.memories.length > 0) {
      const noun = result.memories.length === 1 ? "memory" : "memories";
      const totNoun = result.total === 1 ? "match" : "matches";
      console.log(
        `Found ${result.memories.length} ${noun} (${result.total} total ${totNoun}):`,
      );
      for (const memory of result.memories) {
        console.log("");
        console.log(
          `=== ${memory.key} [${memory.domain} · ${memory.timestamp}] (score ${memory.score.toFixed(4)}) ===`,
        );
        console.log(memory.snippet);
      }
    } else {
      console.log("No memories found");
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * List-keys command
 */
async function listKeysCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);

  const input: any = {
    namespace: flags.namespace || getDefaultNamespace(),
    limit: parseInt(flags.limit) || 50,
    offset: parseInt(flags.offset) || 0,
  };

  if (flags.prefix) {
    input.prefix = flags.prefix;
  }

  if (flags.depth) {
    input.depth = parseInt(flags.depth);
  }

  if (flags.regex) {
    input.regex = flags.regex;
  }

  try {
    const result = await listKeysTool(input);

    if (result.keys && result.keys.length > 0) {
      console.log(`Keys (${result.keys.length} total):`);
      console.log(formatKeyTree(result.keys, input.depth || 2));

      if (result.hasMore) {
        console.log(
          `\nPage ${Math.floor(input.offset / input.limit) + 1} - Use --offset=${input.offset + input.limit} for next page`,
        );
      }
    } else {
      console.log("No keys found");
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Forget command
 */
async function forgetCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);

  if (positional.length < 1) {
    console.error("Usage: duckbrain forget <id> [--reason=<reason>]");
    process.exit(1);
  }

  const id = positional[0];
  const reason = flags.reason || "User requested";

  try {
    const result = await forgetTool({ id, namespace: "default", reason });

    if (result.success) {
      console.log(`✓ Forgotten ${id}`);
    } else {
      console.error("✗ Failed to forget:", result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Key mapping for user-friendly flat keys to schema structure
 * Maps: git.batchLines -> gitBatching.maxLines
 */
const KEY_MAP: Record<string, string> = {
  "git.batchLines": "gitBatching.maxLines",
  "git.batchIntervalSeconds": "gitBatching.maxSeconds",
  "git.batchIntervalMs": "gitBatching.maxSeconds",
  "git.batching.enabled": "gitBatching.enabled",
};

/**
 * Resolve user-friendly key to schema key
 */
function resolveKey(userKey: string): string {
  return KEY_MAP[userKey] || userKey;
}

/**
 * Get a config value by dot-notation key
 */
async function getConfigValue(
  key: string,
): Promise<string | number | boolean | undefined> {
  const config = getConfig();
  const resolvedKey = resolveKey(key);
  const keys = resolvedKey.split(".");
  let value: any = config;
  for (const k of keys) {
    value = value?.[k];
  }
  return value;
}

/**
 * Config command
 */
async function configCommand(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const subcommand = positional[0];

  if (!subcommand) {
    console.error("Usage: duckbrain config <show|set|get>");
    process.exit(1);
  }

  if (subcommand === "show") {
    try {
      const config = getConfig();
      console.log("DuckBrain Configuration:");
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error(
        "Error reading config:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  } else if (subcommand === "set") {
    const key = positional[1];
    const value = positional[2];

    if (!key || value === undefined) {
      console.error("Usage: duckbrain config set <key> <value>");
      process.exit(1);
    }

    // Handle nested keys like git.batchLines
    // Handle nested keys like git.batchLines
    if (key === "git.batchLines") {
      const config = getConfig();
      config.gitBatching.maxLines = parseInt(value, 10);
      setConfig("gitBatching", config.gitBatching);
      console.log(`✓ Config git.batchLines set to ${value}`);
    } else if (key === "git.batchIntervalMs") {
      const config = getConfig();
      config.gitBatching.maxSeconds = Math.floor(parseInt(value, 10) / 1000);
      setConfig("gitBatching", config.gitBatching);
      console.log(`✓ Config git.batchIntervalMs set to ${value}`);
    } else if (key === "git.batchIntervalSeconds") {
      const config = getConfig();
      config.gitBatching.maxSeconds = parseInt(value, 10);
      setConfig("gitBatching", config.gitBatching);
      console.log(`✓ Config git.batchIntervalSeconds set to ${value}`);
    } else if (key === "git.batching.enabled") {
      const config = getConfig();
      config.gitBatching.enabled = value === "true";
      setConfig("gitBatching", config.gitBatching);
      console.log(`✓ Config git.batching.enabled set to ${value}`);
    } else {
      setConfig(key as any, value);
      console.log(`✓ Config ${key} set to ${value}`);
    }
  } else if (subcommand === "get") {
    const key = positional[1];

    if (!key) {
      console.error("Usage: duckbrain config get <key>");
      process.exit(1);
    }

    try {
      const value = await getConfigValue(key);
      if (value !== undefined) {
        console.log(value);
      } else {
        console.error(`Config key '${key}' not found`);
        process.exit(1);
      }
    } catch (error) {
      console.error(
        "Error reading config:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  } else {
    console.error(`Unknown config subcommand: ${subcommand}`);
    process.exit(1);
  }
}

/**
 * Namespaces command - Full namespace management
 */
async function namespacesCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const subcommand = positional[0];

  if (!subcommand) {
    console.error(
      "Usage: duckbrain namespace <create|list|delete|use|set-remote>",
    );
    process.exit(1);
  }

  // Alias 'switch' to 'use'
  const cmd = subcommand === "switch" ? "use" : subcommand;

  if (cmd === "list") {
    try {
      const config = getConfig();
      const namespaces = config.namespaceMappings || {
        default: "./memory/default",
      };
      const currentNs = config.defaultNamespace;

      console.log("Configured namespaces:");
      for (const [name, nsPath] of Object.entries(namespaces)) {
        const marker = name === currentNs ? " (active)" : "";
        const isDefault = name === "default" ? " (default)" : "";
        console.log(`  ${name}${marker}${isDefault}: ${nsPath}`);
      }
    } catch (error) {
      console.error(
        "Error reading namespaces:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  } else if (cmd === "create") {
    const name = positional[1];
    const setDefault = flags.default !== undefined;

    if (!name) {
      console.error("Usage: duckbrain namespace create <name> [--default]");
      process.exit(1);
    }

    try {
      const config = getConfig();
      const nsPath = path.join(config.namespacesPath, name);

      // Create namespace directory
      if (!fs.existsSync(nsPath)) {
        fs.mkdirSync(nsPath, { recursive: true });
      }

      // Initialize git repo
      try {
        execSync("git init", { cwd: nsPath, stdio: "pipe" });
      } catch (gitError) {
        console.warn(
          `Warning: Could not init git: ${(gitError as Error).message}`,
        );
      }

      // Create initial manifest
      const manifestPath = path.join(nsPath, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        fs.writeFileSync(
          manifestPath,
          JSON.stringify(
            {
              version: "1.0",
              createdAt: new Date().toISOString(),
              partitions: [],
            },
            null,
            2,
          ) + "\n",
        );
      }

      // Update config
      registerNamespace(".", name, nsPath);

      if (setDefault) {
        setConfig("defaultNamespace", name);
      }

      console.log(`✓ Created namespace '${name}' at ${nsPath}`);
    } catch (error) {
      console.error(
        "Error creating namespace:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  } else if (cmd === "delete") {
    const name = positional[1];
    const force = flags.force !== undefined;
    const purge = flags.purge !== undefined;

    if (!name) {
      console.error(
        "Usage: duckbrain namespace delete <name> --force [--purge]",
      );
      process.exit(1);
    }

    if (!force) {
      console.error("Error: --force flag required to delete namespace");
      console.error(
        "This is a destructive operation. Use --purge to also delete the directory.",
      );
      process.exit(1);
    }

    try {
      const config = getConfig();
      const nsPath = config.namespaceMappings?.[name];

      if (!nsPath) {
        console.error(`Error: Namespace '${name}' not found`);
        process.exit(1);
      }

      // Remove from config
      if (config.namespaceMappings && name in config.namespaceMappings) {
        const { [name]: _, ...rest } = config.namespaceMappings;
        updateConfig(".", { namespaceMappings: rest });
      }

      // Optionally delete directory
      if (purge && fs.existsSync(nsPath)) {
        fs.rmSync(nsPath, { recursive: true, force: true });
        console.log(`✓ Deleted namespace '${name}' and removed directory`);
      } else {
        console.log(`✓ Deleted namespace '${name}' (directory preserved)`);
      }
    } catch (error) {
      console.error(
        "Error deleting namespace:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  } else if (cmd === "use") {
    const name = positional[1];

    if (!name) {
      console.error("Usage: duckbrain namespace use <name>");
      process.exit(1);
    }

    try {
      const config = getConfig();

      if (!config.namespaceMappings?.[name]) {
        console.error(
          `Error: Namespace '${name}' not found. Run 'duckbrain namespace list' to see available namespaces.`,
        );
        process.exit(1);
      }

      setConfig("defaultNamespace", name);
      console.log(`✓ Switched to namespace '${name}'`);
    } catch (error) {
      console.error(
        "Error switching namespace:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  } else if (cmd === "set-remote") {
    const name = positional[1];
    const url = positional[2];

    if (!name || !url) {
      console.error("Usage: duckbrain namespace set-remote <name> <url>");
      process.exit(1);
    }

    try {
      const config = getConfig();
      const nsPath = config.namespaceMappings?.[name];

      if (!nsPath) {
        console.error(`Error: Namespace '${name}' not found`);
        process.exit(1);
      }

      // Configure git remote
      execSync(`git remote add origin ${url}`, { cwd: nsPath, stdio: "pipe" });
      console.log(`✓ Set remote for '${name}' to ${url}`);
    } catch (error) {
      // Remote might already exist - try to update it
      try {
        const config = getConfig();
        const nsPath = config.namespaceMappings?.[name];
        if (nsPath) {
          execSync(`git remote set-url origin ${url}`, {
            cwd: nsPath,
            stdio: "pipe",
          });
          console.log(`✓ Updated remote for '${name}' to ${url}`);
          return;
        }
      } catch {}

      console.error(
        "Error setting remote:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  } else {
    console.error(`Unknown namespace subcommand: ${cmd}`);
    console.error("Valid: create, list, delete, use, set-remote");
    process.exit(1);
  }
}

/**
 * Status command
 */
async function statusCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const namespace = flags.namespace || getDefaultNamespace();

  try {
    const config = getConfig();
    const nsPath = config.namespaceMappings?.[namespace] || "./memory/default";

    console.log(`DuckBrain Status`);
    console.log(`================`);
    console.log(`Namespace: ${namespace}`);
    console.log(`Path: ${nsPath}`);
    console.log(`Status: OK`);
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * SSH test command
 */
async function sshTestCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const host = flags.host;

  if (!host) {
    console.error("Usage: duckbrain ssh-test --host=<user@server>");
    process.exit(1);
  }

  console.log(`SSH Tunnel Test`);
  console.log(`===============`);
  console.log(`Host: ${host}`);
  console.log(``);
  console.log(`To connect via SSH tunnel:`);
  console.log(`  ssh ${host} "duckbrain stdio"`);
  console.log(``);
  console.log(`For Claude Desktop config, add to claude_desktop_config.json:`);
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "duckbrain": {`);
  console.log(`        "command": "ssh",`);
  console.log(`        "args": ["${host}", "duckbrain", "stdio"]`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
}

/**
 * SSH connect command - Full SSH tunnel with auto-install
 */
async function sshConnectCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const host = flags.host;
  const name =
    flags.name || host.split("@").pop()?.replace(/\./g, "-") || "default";
  const identityFile = flags["identity-file"];
  const port = flags.port ? parseInt(flags.port) : undefined;

  if (!host) {
    console.error(
      "Usage: duckbrain ssh-connect --host=<user@server> [--name=<name>] [--identity-file=<path>] [--port=<port>]",
    );
    process.exit(1);
  }

  console.log(`SSH Connect`);
  console.log(`===========`);
  console.log(`Host: ${host}`);
  console.log(`Name: ${name}`);

  // Step 1: Verify SSH connectivity
  console.log(`\nConnecting via SSH...`);
  const connected = await connectToRemote({ host, identityFile, port });
  if (!connected) {
    console.error("✗ Failed to connect via SSH. Check host and credentials.");
    process.exit(1);
  }
  console.log("✓ SSH connection established");

  // Step 2: Check remote DuckBrain installation
  console.log(`\nChecking remote DuckBrain installation...`);
  const status = await checkRemoteInstall(host);

  if (!status.installed) {
    console.log("DuckBrain not found on remote. Installing...");
    const installed = await installRemote(host);
    if (!installed) {
      console.error(
        "✗ Could not auto-install DuckBrain on remote. See instructions above.",
      );
      process.exit(1);
    }
    console.log("✓ DuckBrain installed on remote");
  } else if (status.needsUpdate) {
    console.log(`DuckBrain v${status.version} found (update available)`);
    console.log("Run: duckbrain ssh-connect --host=... to reinstall");
  } else {
    console.log(`✓ DuckBrain v${status.version} found`);
  }

  // Step 3: Create SSH tunnel
  const socketPath = path.join(
    os.homedir(),
    ".duckbrain",
    "sockets",
    `${name}.sock`,
  );
  console.log(`\nCreating SSH tunnel...`);

  try {
    const tunnelPath = await createTunnel({
      remoteHost: host,
      localSocketPath: socketPath,
      remotePort: 3000,
    });
    console.log(`✓ SSH tunnel established`);
    console.log(`\nSocket: ${tunnelPath}`);
    console.log(`\nTo use this connection:`);
    console.log(`  duckbrain --socket=${name} status`);
    console.log(`  duckbrain --socket=${name} recall --prefix=/`);
  } catch (error) {
    console.error(
      "✗ Failed to create tunnel:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

/**
 * Socket connect command - Run CLI commands via Unix socket
 */
async function socketConnectCommand(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  const socketName = flags.socket;

  if (!socketName) {
    console.error("Usage: duckbrain --socket=<name> <command> [options]");
    console.error("\nAvailable sockets:");
    const tunnels = listTunnels();
    if (tunnels.length === 0) {
      console.error(
        "  No active tunnels. Run: duckbrain ssh-connect --host=<server>",
      );
    } else {
      for (const t of tunnels) {
        console.error(`  ${t.name} -> ${t.remoteHost}`);
      }
    }
    process.exit(1);
  }

  const socketPath = path.join(
    os.homedir(),
    ".duckbrain",
    "sockets",
    `${socketName}.sock`,
  );

  if (!fs.existsSync(socketPath)) {
    console.error(`Error: Socket '${socketName}' not found at ${socketPath}`);
    console.error("\nAvailable sockets:");
    const tunnels = listTunnels();
    if (tunnels.length === 0) {
      console.error(
        "  No active tunnels. Run: duckbrain ssh-connect --host=<server>",
      );
    } else {
      for (const t of tunnels) {
        console.error(`  ${t.name} -> ${t.remoteHost}`);
      }
    }
    process.exit(1);
  }

  // Forward command to remote DuckBrain via HTTP over Unix socket
  const command = positional.join(" ");
  if (!command) {
    console.error("Error: No command specified");
    console.error("Usage: duckbrain --socket=<name> <command> [options]");
    process.exit(1);
  }

  // Build request body for remote CLI execution
  const requestBody = JSON.stringify({ command, args: positional.slice(1) });

  // HTTP request over Unix socket
  const options = {
    socketPath,
    path: "/cli",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(requestBody),
    },
  };

  return new Promise<void>((resolve) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const response = JSON.parse(data);
          if (response.output) {
            console.log(response.output);
          }
          if (response.error) {
            console.error(response.error);
          }
          resolve();
        } catch {
          console.log(data);
          resolve();
        }
      });
    });

    req.on("error", (err) => {
      console.error(`Error connecting to remote DuckBrain: ${err.message}`);
      console.error("Make sure the remote DuckBrain HTTP server is running.");
      process.exit(1);
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * Servers command - Manage named server connections
 */
async function serversCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const subcommand = positional[0];

  if (!subcommand) {
    console.error("Usage: duckbrain servers <list|add|remove>");
    process.exit(1);
  }

  const serversPath = path.join(os.homedir(), ".duckbrain", "servers.json");

  // Load or initialize servers config
  function loadServers(): Record<string, { host: string; addedAt: string }> {
    if (fs.existsSync(serversPath)) {
      return JSON.parse(fs.readFileSync(serversPath, "utf-8"));
    }
    return {};
  }

  function saveServers(
    servers: Record<string, { host: string; addedAt: string }>,
  ): void {
    const dir = path.dirname(serversPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(serversPath, JSON.stringify(servers, null, 2) + "\n");
  }

  if (subcommand === "list") {
    const servers = loadServers();
    const entries = Object.entries(servers);

    if (entries.length === 0) {
      console.log("No servers configured.");
      console.log(
        "Add one with: duckbrain servers add --name=<name> --host=<user@server>",
      );
      return;
    }

    console.log("Configured servers:");
    for (const [name, info] of entries) {
      console.log(`  ${name} -> ${info.host} (added: ${info.addedAt})`);
    }
  } else if (subcommand === "add") {
    const name = flags.name;
    const host = flags.host;

    if (!name || !host) {
      console.error(
        "Usage: duckbrain servers add --name=<name> --host=<user@server>",
      );
      process.exit(1);
    }

    const servers = loadServers();
    servers[name] = { host, addedAt: new Date().toISOString() };
    saveServers(servers);

    console.log(`✓ Added server '${name}' -> ${host}`);
  } else if (subcommand === "remove") {
    const name = positional[1] || flags.name;

    if (!name) {
      console.error("Usage: duckbrain servers remove <name>");
      process.exit(1);
    }

    const servers = loadServers();
    if (!(name in servers)) {
      console.error(`Error: Server '${name}' not found`);
      process.exit(1);
    }

    delete servers[name];
    saveServers(servers);
    console.log(`✓ Removed server '${name}'`);
  } else {
    console.error(`Unknown servers subcommand: ${subcommand}`);
    console.error("Valid: list, add, remove");
    process.exit(1);
  }
}

/**
 * Pull command - Pull from remote with auto-merge
 */
async function pullCommand(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const namespace = positional[0] || "default";

  try {
    const config = getConfig();
    const nsPath = config.namespaceMappings?.[namespace];

    if (!nsPath) {
      console.error(`Error: Namespace '${namespace}' not found`);
      process.exit(1);
    }

    console.log(`Pulling ${namespace}...`);

    // Pull without committing (allows us to merge conflicts)
    execSync("git pull --no-commit", { cwd: nsPath, stdio: "inherit" });

    // If we get here, pull succeeded (possibly with conflicts auto-resolved)
    console.log(`✓ Pulled ${namespace}`);
  } catch (error) {
    console.error(
      "Error pulling:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

/**
 * Push command - Push to remote
 */
async function pushCommand(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const namespace = positional[0] || "default";

  try {
    const config = getConfig();
    const nsPath = config.namespaceMappings?.[namespace];

    if (!nsPath) {
      console.error(`Error: Namespace '${namespace}' not found`);
      process.exit(1);
    }

    console.log(`Pushing ${namespace}...`);
    execSync("git push", { cwd: nsPath, stdio: "inherit" });
    console.log(`✓ Pushed ${namespace}`);
  } catch (error) {
    console.error(
      "Error pushing:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

/**
 * Remote command - Manage remotes
 */
async function remoteCommand(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const subcommand = positional[0];

  if (!subcommand) {
    console.error("Usage: duckbrain remote <add|remove> <namespace> [url]");
    process.exit(1);
  }

  if (subcommand === "add") {
    const namespace = positional[1];
    const url = positional[2];

    if (!namespace || !url) {
      console.error("Usage: duckbrain remote add <namespace> <url>");
      process.exit(1);
    }

    // Delegate to namespace set-remote
    await namespacesCommand(["set-remote", namespace, url]);
  } else if (subcommand === "remove") {
    const namespace = positional[1];

    if (!namespace) {
      console.error("Usage: duckbrain remote remove <namespace>");
      process.exit(1);
    }

    try {
      const config = getConfig();
      const nsPath = config.namespaceMappings?.[namespace];

      if (!nsPath) {
        console.error(`Error: Namespace '${namespace}' not found`);
        process.exit(1);
      }

      execSync("git remote remove origin", { cwd: nsPath, stdio: "pipe" });
      console.log(`✓ Removed remote from '${namespace}'`);
    } catch (error) {
      console.error(
        "Error removing remote:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  } else {
    console.error(`Unknown remote subcommand: ${subcommand}`);
    console.error("Valid: add, remove");
    process.exit(1);
  }
}

/**
 * Squash command
 */
async function squashCommand(args: string[]): Promise<void> {
  // Handle --help before any namespace checks
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: duckbrain squash [options]`);
    console.log("");
    console.log("Options:");
    console.log("  --stats           Show compaction statistics");
    console.log(
      "  --dry-run         Preview what would be compacted without making changes",
    );
    console.log("  --partition <id>  Compact specific partition only");
    console.log(
      "  --aggressive      More aggressive compaction (lower thresholds)",
    );
    console.log("  --help, -h        Show this help message");
    console.log("");
    console.log(
      "Squashes/compacts memory partitions by converting old JSONL files to Parquet",
    );
    console.log(
      "and removing tombstoned records. Also squashes git history for compacted partitions.",
    );
    return;
  }

  const { flags } = parseArgs(args);

  const input: any = {
    dryRun: flags["dry-run"] || false,
    aggressive: flags.aggressive || false,
  };

  if (flags.partition) {
    input.partition = flags.partition;
  }

  // Handle --stats flag separately
  if (flags.stats) {
    try {
      const result = await getCompactionStatsTool({});

      if (result.success && result.stats) {
        const stats = result.stats;
        console.log("DuckBrain Compaction Statistics");
        console.log("================================");
        console.log(
          `Total Size: ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`,
        );
        console.log(`Total Partitions: ${stats.totalPartitions}`);
        console.log(`  - JSONL: ${stats.jsonlPartitions}`);
        console.log(`  - Parquet: ${stats.parquetPartitions}`);
        console.log(``);
        console.log(`Total Records: ${stats.totalRecords.toLocaleString()}`);
        console.log(
          `Tombstones: ${stats.tombstoneRecords.toLocaleString()} (${stats.tombstonePercent}%)`,
        );
        console.log(`Parquet Ratio: ${stats.parquetRatio}%`);
        console.log(``);

        if (stats.oldPartitions.length > 0) {
          console.log(
            `Old Partitions (>30 days): ${stats.oldPartitions.length}`,
          );
          for (const p of stats.oldPartitions.slice(0, 5)) {
            console.log(`  - ${p}`);
          }
          if (stats.oldPartitions.length > 5) {
            console.log(`  ... and ${stats.oldPartitions.length - 5} more`);
          }
        }

        if (stats.largePartitions.length > 0) {
          console.log(``);
          console.log(
            `Large Partitions (>1000 records): ${stats.largePartitions.length}`,
          );
          for (const p of stats.largePartitions.slice(0, 5)) {
            console.log(
              `  - ${p.path}: ${p.records.toLocaleString()} records, ${(p.size / 1024).toFixed(2)} KB`,
            );
          }
          if (stats.largePartitions.length > 5) {
            console.log(`  ... and ${stats.largePartitions.length - 5} more`);
          }
        }
      } else {
        console.error("Error getting stats:", result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
    return;
  }

  try {
    const result = await squashTool(input);

    if (result.success) {
      console.log(result.message);
      if (result.stats) {
        console.log("");
        console.log("Statistics:");
        if (result.stats.partitionsCompacted !== undefined) {
          console.log(
            `  Partitions compacted: ${result.stats.partitionsCompacted}`,
          );
        }
        if (result.stats.totalRecordsKept !== undefined) {
          console.log(
            `  Records kept: ${result.stats.totalRecordsKept.toLocaleString()}`,
          );
        }
        if (result.stats.totalRecordsRemoved !== undefined) {
          console.log(
            `  Records removed: ${result.stats.totalRecordsRemoved.toLocaleString()}`,
          );
        }
      }
      if (result.errors && result.errors.length > 0) {
        console.log("");
        console.log("Warnings:");
        for (const err of result.errors) {
          console.log(`  - ${err}`);
        }
      }
    } else {
      console.error("✗ Squash failed:", result.message);
      if (result.errors) {
        for (const err of result.errors) {
          console.error(`  - ${err}`);
        }
      }
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Token command - Generate API token for HTTP authentication
 *
 * DB-GAP-031: --namespace=NS grants — repeatable AND comma-separated
 * (parseArgs keeps only the last --flag=value, so grants are collected by
 * re-scanning the raw args). Absent = unrestricted token (backward compat).
 */
async function tokenCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const crypto = await import("crypto");

  const namespaceGrants: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value: string | undefined;
    if (arg === "--namespace") {
      value = args[i + 1];
    } else if (arg.startsWith("--namespace=")) {
      value = arg.slice("--namespace=".length);
    }
    if (value === undefined) continue;
    for (const ns of value.split(",")) {
      const trimmed = ns.trim();
      if (trimmed && !namespaceGrants.includes(trimmed)) {
        namespaceGrants.push(trimmed);
      }
    }
  }

  // Generate secure random token
  const token = crypto.randomBytes(32).toString("hex");

  // Determine auth config path
  const authPath = path.join(os.homedir(), ".duckbrain", "auth.json");

  // Load or create auth config
  let authConfig: any = { apiKeys: [] };
  if (fs.existsSync(authPath)) {
    try {
      authConfig = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    } catch {
      // Ignore parse errors
    }
  }

  // Add new token — namespaces carries the grants when scoped
  const tokenName = flags.name || `token-${Date.now()}`;
  if (!authConfig.apiKeys) {
    authConfig.apiKeys = [];
  }
  const tokenEntry: any = { key: token, name: tokenName };
  if (namespaceGrants.length > 0) {
    tokenEntry.namespaces = namespaceGrants;
  }
  authConfig.apiKeys.push(tokenEntry);

  // Ensure directory exists
  const authDir = path.dirname(authPath);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // Write config
  fs.writeFileSync(authPath, JSON.stringify(authConfig, null, 2) + "\n");

  console.log("Generated API token:");
  console.log(token);
  console.log("");
  if (namespaceGrants.length > 0) {
    console.log(`Namespace grants: ${namespaceGrants.join(", ")}`);
    console.log("(requests to other namespaces will be rejected with 403)");
  } else {
    console.log("Namespace grants: all namespaces (unrestricted)");
  }
  console.log("");
  console.log("Use with HTTP requests:");
  console.log(`  curl -H "X-API-Key: ${token}" http://localhost:3000/health`);
  console.log("");
  console.log(`Token saved to ${authPath}`);
}

/**
 * Show help message
 */
function showHelp(): void {
  console.log(
    `
  DuckBrain v1.0.0 - AI Memory System

  Usage: duckbrain <command> [options]

  Commands:
    stdio              Start MCP server for local Claude
    remember <key>     Remember a memory (body via --content=, --text=, or stdin)
    recall             Query memories
    search <query>     Keyword full-text search (offline; needs search-index rebuild)
    search-index       Manage the keyword search index (rebuild|status)
    list-keys          Browse memory structure
    forget <id>        Delete a memory
    config             Show or set configuration
    namespace(s)       Manage namespaces
    pull               Pull from remote (auto-merge conflicts)
    push               Push to remote
    remote             Manage remotes (add|remove)
    status             Show system status
    token              Generate API token for HTTP authentication
                       (--name=NAME, --namespace=NS[,NS...] for scoped grants)
    ssh-test           Test SSH tunnel setup
    ssh-connect        Connect to remote DuckBrain via SSH tunnel
    servers            Manage server connections (list|add|remove)
    squash             Compact old partitions
    s3                 Native S3 sync/query (status|sync|query|config)
    help               Show this help

  Options:
    --namespace=NAME   Select namespace (default: config defaultNamespace)
    --socket=NAME      Use remote connection via Unix socket
    --wait             Wait for git commit (remember command only)
    SSH Options:
    --host=USER@HOST   Remote host for SSH connection
    --name=NAME        Name for the tunnel/socket (default: derived from host)
    --identity-file=PATH  SSH identity file (key)
    --port=PORT        SSH port (default: 22)

  Squash Options:
    --partition=PATH   Target specific partition
    --dry-run          Preview without modifying files
    --aggressive       Include git history squashing
    --stats            Show compaction statistics

  Examples:
    duckbrain stdio
    duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice"}' --content='Met at conference'
    duckbrain echo "project notes body" | duckbrain remember /notes/test --domain=raw_note --wait
    duckbrain recall --prefix=/projects/
    duckbrain recall --prefix=/chats/ --after=2026-08-10 --before=2026-08-12
    duckbrain recall --between=2026-08-10,2026-08-12
    duckbrain list-keys --depth=3 --limit=20
    duckbrain forget abc-123 --reason="obsolete"
    duckbrain status --namespace=default
    duckbrain config set git.batchLines 100
    duckbrain ssh-connect --host=user@server --name=prod
    duckbrain --socket=prod status
    duckbrain servers list
    duckbrain servers add --name=prod --host=user@server
    duckbrain squash --stats
    duckbrain squash --dry-run
    duckbrain squash --partition=person/2025-01 --aggressive
  `.trim(),
  );
}

/**
 * Run human CLI command
 * @param command Command name
 * @param args Command arguments
 */
export async function runHumanCLI(
  command: string,
  args: string[],
): Promise<void> {
  // Check for --socket flag to route through remote connection
  const { flags: globalFlags } = parseArgs(args);
  if (
    globalFlags.socket &&
    command !== "ssh-connect" &&
    command !== "ssh-test" &&
    command !== "servers"
  ) {
    await socketConnectCommand(args);
    return;
  }

  const commands: Record<string, (args: string[]) => Promise<void>> = {
    remember: rememberCommand,
    recall: recallCommand,
    search: searchCommand,
    "list-keys": listKeysCommand,
    forget: forgetCommand,
    config: configCommand,
    namespace: namespacesCommand,
    namespaces: namespacesCommand, // alias
    status: statusCommand,
    token: tokenCommand,
    "ssh-test": sshTestCommand,
    "ssh-connect": sshConnectCommand,
    servers: serversCommand,
    squash: squashCommand,
    pull: pullCommand,
    push: pushCommand,
    remote: remoteCommand,
    s3: (args: string[]) => s3Command(args),
    help: async () => showHelp(),
  };

  const handler = commands[command];

  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "duckbrain help" for usage');
    process.exit(1);
  }

  await handler(args);
}
