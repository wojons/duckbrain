/**
 * `duckbrain query` — read-only SQL query surface (RETR-009).
 *
 * Usage:
 *   duckbrain query "SELECT key, timestamp FROM memories WHERE key LIKE '/incidents/%'"
 *   duckbrain query --template incidents-by-day [--namespace=<name>]
 *   duckbrain query --template per-project-status [--namespace=<name>]
 *   duckbrain query --template cost-series [--namespace=<name>]
 *
 * The SQL runs against a `memories` view of the selected namespace (latest
 * record per id, tombstones excluded, validity-filtered — same semantics as
 * recall). The
 * surface is strictly read-only and auto-capped at QUERY_MAX_ROWS rows
 * (src/duckdb/query-surface.ts); mutating statements, non-numeric LIMITs,
 * and namespace-escaping table functions are rejected.
 */

import { getConfig } from "../config";
import { resolveNamespacePath } from "../mcp/tools/shared";
import {
  runReadOnlyQuery,
  resolveQueryTemplate,
  ReadOnlyQueryError,
  QUERY_MAX_ROWS,
  QUERY_PRINT_ROWS,
} from "../duckdb/query-surface";

const QUERY_USAGE = `duckbrain query — read-only SQL over a namespace's memory store.

Usage:
  duckbrain query "SELECT ..." [--namespace=<name>] [--limit=<n>]
  duckbrain query --template <name> [--namespace=<name>]

The SQL runs against a \`memories\` view (latest record per id, tombstones
excluded, validity-filtered). Read-only: mutating statements are rejected, results are
auto-capped at ${QUERY_MAX_ROWS} rows.

Options:
  --namespace=<name>  Select namespace (default: config defaultNamespace;
                      templates use their own default)
  --template=<name>   Run a saved query template:
                        incidents-by-day     daily incident counts (/incidents/YYYY-MM-DD)
                        per-project-status   latest /fleet/projects/<name>/status rows
                        cost-series          daily estimated cost from /usage/YYYY-MM-DD
  --limit=<n>         Max rows (default ${QUERY_MAX_ROWS}, never exceeds it)
  --help, -h          Show this help

Examples:
  duckbrain query "SELECT key, timestamp FROM memories WHERE key LIKE '/projects/%'"
  duckbrain query "SELECT count(*) AS n FROM memories" --namespace=hermes-telemetry
  duckbrain query --template cost-series
  duckbrain query --template per-project-status --namespace=coding-hermes`;

/**
 * Normalize the space-separated `--namespace <name>` / `--template <name>`
 * forms to `--flag=<name>` before parseArgs (which only splits on `=`).
 * Mirrors the RETR-008 normalizeNamespaceArgs pattern.
 */
function normalizeFlagArgs(args: string[]): string[] {
  const out = args.slice();
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === "--namespace" || out[i] === "--template") {
      out.splice(i, 2, `${out[i]}=${out[i + 1]}`);
      // Deliberately no break: later bare flags shift down one slot and
      // must also be normalized (e.g. --template X --namespace Y).
    }
  }
  return out;
}

/**
 * Parse and validate the --limit flag (GAP-023 doctrine): negative and
 * non-numeric values are rejected loudly; positive values are capped at
 * QUERY_MAX_ROWS. Absent → QUERY_MAX_ROWS.
 */
function parseQueryLimit(flags: Record<string, string>): number {
  const raw = flags.limit;
  if (raw === undefined) return QUERY_MAX_ROWS;
  if (!/^\d+$/.test(raw)) {
    console.error(`✗ --limit must be a non-negative integer (got '${raw}').`);
    process.exit(1);
  }
  const parsed = parseInt(raw, 10);
  return Math.min(parsed, QUERY_MAX_ROWS);
}

/**
 * Local flag extraction for the query command. Only `--flag[=value]` args
 * are treated as flags; everything else (including SQL fragments such as
 * negative numbers) stays positional. parseArgs in human.ts is not reused:
 * importing it would create a human.ts <-> query.ts import cycle.
 */
function parseQueryArgs(args: string[]): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = "true";
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/** Run the `duckbrain query` command. */
export async function queryCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(QUERY_USAGE);
    return;
  }

  const { positional, flags } = parseQueryArgs(normalizeFlagArgs(args));

  const templateName = flags.template;
  if (templateName && positional.length > 0) {
    console.error(
      "✗ --template and an inline SQL statement are mutually exclusive.",
    );
    console.error('Usage: duckbrain query "SELECT ..." | --template <name>');
    process.exit(1);
  }

  const cap = parseQueryLimit(flags);

  let sql: string;
  let namespace: string;
  if (templateName) {
    let template;
    try {
      template = resolveQueryTemplate(templateName);
    } catch (error) {
      console.error(
        "✗",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
    sql = template.sql;
    namespace = flags.namespace || template.defaultNamespace;
  } else {
    sql = positional.join(" ").trim();
    if (!sql) {
      console.error(
        'Usage: duckbrain query "SELECT ..." [--namespace=<name>] [--limit=<n>] or --template=<name>',
      );
      process.exit(1);
    }
    namespace = flags.namespace || getConfig().defaultNamespace || "default";
  }

  const namespacePath = resolveNamespacePath(namespace);

  try {
    const result = await runReadOnlyQuery(namespacePath, sql, cap);

    console.log(`columns: ${result.columns.join(", ")}`);
    console.log(`rows: ${result.count}`);
    for (const row of result.rows.slice(0, QUERY_PRINT_ROWS)) {
      console.log(JSON.stringify(row));
    }
    if (result.count > QUERY_PRINT_ROWS) {
      console.log(`... ${result.count - QUERY_PRINT_ROWS} more`);
    }
    if (result.truncated) {
      console.error(
        `Note: results auto-capped at ${cap} rows (read-only surface) — add a LIMIT clause to refine.`,
      );
    }
  } catch (error) {
    if (error instanceof ReadOnlyQueryError) {
      console.error("✗", error.message);
    } else {
      console.error(
        "✗ Query failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    process.exit(1);
  }
}
