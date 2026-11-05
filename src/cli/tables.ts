/**
 * `duckbrain tables declare` — SUPA6-DECLARE-GAP-001.
 *
 * A fresh install had NO discoverable path to create a table declaration:
 * the generic table→REST layer (DB-SUPA-3, src/http/routes/tables.ts) serves
 * only tables DECLARED on disk (SUPA-6 `schema.json` or the legacy
 * `tables/<table>.table.json`), and nothing on the CLI could write either
 * file. This verb closes that gap from the command line:
 *
 *   duckbrain tables declare <namespace> <table> \
 *     --column name=type [--column name=type ...] \
 *     [--primary <col>] [--format jsonl-objects|jsonl-positional] \
 *     [--legacy] [--force]
 *
 * SURFACE-MCP-DATA-001: the declaration itself lives in
 * src/tables/declare.ts (declareTable) because the MCP `tables_declare` tool
 * exposes the same verb. This module is the argv surface — parse, call, print
 * — so a CLI declaration and an MCP declaration are the same code path and
 * cannot drift apart.
 *
 * Column types on the command line are the DB-SUPA-3 DuckDB-facing names
 * (TABLE_COLUMN_TYPES, reused from src/schema/table-registry.ts — never
 * duplicated here).
 */

import path from "path";
import { resolveNamespacesPath } from "../config/index.js";
import { TABLE_COLUMN_TYPES, TABLE_FORMATS, type TableFormat } from "../schema/table-registry.js";
import { declareTable, TableDeclareError } from "../tables/declare.js";

/** Example JSON value per CLI type, for the printed curl POST example. */
const EXAMPLE_VALUE: Record<string, string> = {
  varchar: '"a"',
  integer: "1",
  bigint: '"1"',
  double: "1.5",
  boolean: "true",
  timestamp: '"2026-10-07T12:00:00.000Z"',
  json: "{}",
};

export const TABLES_DECLARE_USAGE = `Usage: duckbrain tables declare <namespace> <table> --column <name>=<type> [...]

Declare a table so the generic table→REST layer (DB-SUPA-3) can serve it.
Writes the SUPA-6 persistent schema (namespaces/<ns>/schema.json), merging
into an existing schema document; use --legacy to write the historical
tables/<table>.table.json declaration instead. The same declaration is
available to agents as the MCP tool \`tables_declare\`.

Options:
  --column <name>=<type>   Declared column (repeatable, at least one).
                           Types: ${TABLE_COLUMN_TYPES.join("|")}
  --primary <col>          Primary key column (must be a declared column).
                           Defaults to the FIRST declared column.
  --format <fmt>           Row shape: jsonl-objects (default) or
                           jsonl-positional.
  --legacy                 Write tables/<table>.table.json (legacy
                           declaration) instead of schema.json.
  --force                  Replace an existing declaration of the same
                           table name. Without it, a conflicting existing
                           declaration is refused.
  --help, -h               Show this help.

Examples:
  duckbrain tables declare e2e-supagap widgets --column id=integer --column name=varchar --primary id
  duckbrain tables declare notes events --column id=bigint --column at=timestamp --legacy`;

/** A usage/validation failure. The bin layer prints it and exits 1. */
export class TablesCliError extends Error {}

function fail(message: string): never {
  throw new TablesCliError(message);
}

function printHelp(): void {
  console.log(TABLES_DECLARE_USAGE);
}

// ---------------------------------------------------------------------------
// CLI arg parsing (the same --flag VALUE / --flag=VALUE shapes as the rest
// of the duckbrain CLI)
// ---------------------------------------------------------------------------

interface DeclareArgs {
  ns: string;
  table: string;
  columns: Array<{ name: string; type: string }>;
  primary?: string;
  format: TableFormat;
  legacy: boolean;
  force: boolean;
}

/** Returns null when --help printed help (caller exits 0). */
function parseDeclareArgs(argv: string[]): DeclareArgs | null {
  const args: DeclareArgs = {
    ns: "",
    table: "",
    columns: [],
    format: "jsonl-objects",
    legacy: false,
    force: false,
  };
  const positional: string[] = [];
  // Consume-as-you-go: every token (flags AND their values) is consumed
  // exactly once, up-front, so a value can never be re-parsed as a
  // positional argument and an inline --flag=value form can never loop.
  let i = 0;
  const requireValue = (flag: string): string => {
    const value = argv[i];
    i += 1;
    if (value === undefined) fail(`${flag} requires a value`);
    return value;
  };
  while (i < argv.length) {
    const arg = argv[i]!;
    i += 1;
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return null;
    }
    if (arg === "--legacy") {
      args.legacy = true;
      continue;
    }
    if (arg === "--force") {
      args.force = true;
      continue;
    }
    if (arg === "--primary") {
      args.primary = requireValue("--primary");
      continue;
    }
    if (arg.startsWith("--primary=")) {
      args.primary = arg.slice("--primary=".length);
      continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg.startsWith("--format=")
        ? arg.slice("--format=".length)
        : requireValue("--format");
      if (!(TABLE_FORMATS as readonly string[]).includes(value))
        fail(
          `--format must be one of ${TABLE_FORMATS.join("|")}, got '${value}'`,
        );
      args.format = value as TableFormat;
      continue;
    }
    if (arg === "--column" || arg.startsWith("--column=")) {
      const pair = arg.startsWith("--column=")
        ? arg.slice("--column=".length)
        : requireValue("--column");
      const eq = pair.indexOf("=");
      if (eq <= 0 || eq === pair.length - 1)
        fail(
          `--column must be name=type (e.g. --column id=integer), got '${pair}'`,
        );
      args.columns.push({ name: pair.slice(0, eq), type: pair.slice(eq + 1) });
      continue;
    }
    if (arg.startsWith("--")) fail(`Unknown option '${arg}'`);
    positional.push(arg);
  }
  if (positional.length < 2) fail("a namespace and a table name are required");
  if (positional.length > 2)
    fail(`unexpected extra arguments: ${positional.slice(2).join(" ")}`);
  args.ns = positional[0]!;
  args.table = positional[1]!;
  return args;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function exampleBodyFor(
  columns: Array<{ name: string; type: string }>,
): string {
  const parts = columns.map(
    ({ name, type }) => `"${name}": ${EXAMPLE_VALUE[type] ?? "null"}`,
  );
  return `{${parts.join(", ")}}`;
}

function printNextSteps(
  ns: string,
  nsDir: string,
  table: string,
  schemaPath: boolean,
  example: string,
): void {
  console.log("");
  console.log("Next steps:");
  console.log("  1. Start the HTTP server (if it is not already running):");
  console.log("       duckbrain http --auth=none");
  console.log("  2. Insert a row:");
  console.log(
    `       curl -s -X POST "http://localhost:3000/api/ns/${ns}/tables/${table}" \\`,
  );
  console.log(`         -H 'Content-Type: application/json' -d '${example}'`);
  console.log("  3. Read rows:");
  console.log(
    `       curl -s "http://localhost:3000/api/ns/${ns}/tables/${table}"`,
  );
  console.log("  4. Generated OpenAPI:");
  console.log(
    `       curl -s "http://localhost:3000/api/ns/${ns}/openapi.json"`,
  );
  if (schemaPath) {
    console.log("");
    console.log(
      `The declaration lives in ${path.join(nsDir, "schema.json")}; further "duckbrain tables declare" runs merge into the same file.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run `duckbrain tables ...`. Resolves with the process exit code (0 on
 * success); throws TablesCliError for usage/validation failures, which the
 * bin entry prints and turns into exit 1. Only the `declare` subcommand
 * exists today; `tables --help` documents it.
 */
export async function runTablesCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printHelp();
    return 0;
  }
  if (sub !== "declare")
    fail(
      `Unknown tables subcommand: '${sub}' (expected: declare; run "duckbrain tables --help")`,
    );

  const args = parseDeclareArgs(rest);
  if (args === null) return 0;

  let result: Awaited<ReturnType<typeof declareTable>>;
  try {
    result = await declareTable({
      ns: args.ns,
      table: args.table,
      columns: args.columns,
      primary: args.primary,
      format: args.format,
      legacy: args.legacy,
      force: args.force,
    });
  } catch (error) {
    if (error instanceof TableDeclareError) {
      // Usage errors throw (the bin prints them); write refusals are printed
      // here with the historical `Error: ` prefix and exit 1, because they
      // describe state on disk, not a malformed command line.
      if (error.kind === "usage") throw new TablesCliError(error.message);
      console.error(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const nsDir = path.join(path.resolve(resolveNamespacesPath()), result.ns);
  const example = exampleBodyFor(args.columns);
  if (result.format === "legacy") {
    console.log(`Declared table '${result.table}' in ${result.path} (legacy .table.json).`);
    printNextSteps(result.ns, nsDir, result.table, false, example);
    return 0;
  }
  console.log(`Declared table '${result.table}' in ${result.path} (schema.json, SUPA-6).`);
  printNextSteps(result.ns, nsDir, result.table, true, example);
  return 0;
}
