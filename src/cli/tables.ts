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
 * DDL-EVOLVE-001: the same pattern for evolution — `tables alter` calls the
 * DDL coordinator's addColumn/retypeColumn (src/serialization/ddl.ts), the
 * SAME ops the HTTP alter route and the MCP `tables_alter` tool call.
 *
 * Column types on the command line are the DB-SUPA-3 DuckDB-facing names
 * (TABLE_COLUMN_TYPES, reused from src/schema/table-registry.ts — never
 * duplicated here).
 */

import path from "path";
import { resolveNamespacesPath } from "../config/index.js";
import {
  TABLE_COLUMN_TYPES,
  TABLE_FORMATS,
  type TableFormat,
} from "../schema/table-registry.js";
import { declareTable, TableDeclareError } from "../tables/declare.js";
import { auditNamespaceTableKeys } from "../tables/audit.js";
import { addColumn, retypeColumn, type BackfillPolicy } from "../serialization/ddl.js";
import { ApiError } from "../http/middleware/errorHandler.js";
import { DECLARED_TYPES, type DeclaredColumnType } from "../serialization/schemaTypes.js";

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
                           integer and double persist as declared float64
                           (JSON numbers, safe to +/- 2^53); use bigint for
                           exact 64-bit values, which persist as canonical
                           base-10 strings.
  --primary <col>          Primary key column (must be a declared column).
                           Defaults to the FIRST declared column.
  --format <fmt>           Row shape: jsonl-objects (default) or
                           jsonl-positional.
  --legacy                 Write tables/<table>.table.json (legacy
                           declaration) instead of schema.json.
  --force                  Replace an existing declaration of the same
                           table name. Without it, a conflicting existing
                           declaration is refused. A --force that would
                           reshape a POPULATED table is refused
                           (EVOLUTION_REQUIRED): evolve it with
                           \`duckbrain tables alter\` instead.
  --help, -h               Show this help.

Examples:
  duckbrain tables declare e2e-supagap widgets --column id=integer --column name=varchar --primary id
  duckbrain tables declare notes events --column id=bigint --column at=timestamp --legacy`;

export const TABLES_ALTER_USAGE = `Usage:
  duckbrain tables alter <namespace> <table> add-column <name>=<type> [--nullable | --default '<json>'] [--policy null|default|materialize]
  duckbrain tables alter <namespace> <table> retype-column <column> <type>

Evolve a declared table through the production DDL coordinator
(src/serialization/ddl.ts) — the SAME ops the HTTP alter route
(POST /api/ns/:ns/tables/:table/alter) and the MCP \`tables_alter\` tool call.
Both increment the table's schemaVersion and journal under .duckbrain-ddl/.

  add-column     Adds a new column. The type is a declared v1 type
                 (${DECLARED_TYPES.join("|")}). Without --policy the
                 coordinator derives the backfill policy: a default implies
                 'default', nullable implies 'null', and a required column
                 without a default is refused (BACKFILL_POLICY_REQUIRED).
                 --policy materialize physically rewrites the rows into a new
                 immutable generation (requires a default).
  retype-column  Retypes an existing column. Allowed in v1:
                 int64->float64, string->json, string->timestamp. Always
                 materializes: rows are converted and validated into a new
                 generation BEFORE anything is switched (a lossy value aborts
                 with nothing written).

Drop / rename / key changes and view declarations are refused in v1; every
other shape change needs a new table name.`;

export const TABLES_AUDIT_KEYS_USAGE = `Usage: duckbrain tables audit-keys --namespace <namespace>

Read every declared table and report duplicate primary-key values. Tables
without a primary key are reported explicitly. This command is read-only.`;

/** A usage/validation failure. The bin layer prints it and exits 1. */
export class TablesCliError extends Error {}

function fail(message: string): never {
  throw new TablesCliError(message);
}

function printHelp(): void {
  console.log(
    `${TABLES_DECLARE_USAGE}\n\n${TABLES_ALTER_USAGE}\n\n${TABLES_AUDIT_KEYS_USAGE}`,
  );
}

interface AuditKeysArgs {
  namespace: string;
}

function parseAuditKeysArgs(argv: string[]): AuditKeysArgs | null {
  let namespace: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(TABLES_AUDIT_KEYS_USAGE);
      return null;
    }
    if (arg === "--namespace") {
      namespace = argv[++i];
      if (!namespace) fail("--namespace requires a value");
      continue;
    }
    if (arg.startsWith("--namespace=")) {
      namespace = arg.slice("--namespace=".length);
      if (!namespace) fail("--namespace requires a value");
      continue;
    }
    fail(`Unknown option '${arg}'`);
  }
  if (!namespace) fail("--namespace is required");
  return { namespace };
}

function printAuditKeys(
  audit: ReturnType<typeof auditNamespaceTableKeys>,
): void {
  console.log(JSON.stringify(audit, null, 2));
}

// ---------------------------------------------------------------------------
// DDL-EVOLVE-001 — `tables alter` (addColumn / retypeColumn over ddl.ts)
// ---------------------------------------------------------------------------

type AlterArgs =
  | {
      ns: string;
      table: string;
      op: "addColumn";
      column: {
        name: string;
        type: string;
        nullable: boolean;
        default?: unknown;
      };
      policy?: BackfillPolicy;
    }
  | {
      ns: string;
      table: string;
      op: "retypeColumn";
      /** The existing column's NAME. */
      column: string;
      type: string;
    };

/**
 * Parse `alter <ns> <table> <op> ...`. The declared type vocabulary is the
 * ddl.ts canonical one (string|int64|float64|boolean|timestamp|json|bytes) —
 * NOT the DuckDB-facing declare names — because the call goes straight into
 * the DDL coordinator.
 */
function parseAlterArgs(argv: string[]): AlterArgs | null {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === undefined) {
    console.log(TABLES_ALTER_USAGE);
    return null;
  }
  const [ns, table, op, ...rest] = argv;
  if (!ns || !table) fail("a namespace and a table name are required");
  if (op === undefined)
    fail("an operation is required: 'add-column' or 'retype-column'");
  if (op !== "add-column" && op !== "retype-column")
    fail(
      `Unknown alter operation '${op}' (expected: add-column or retype-column)`,
    );

  const isDeclared = (value: string): boolean =>
    (DECLARED_TYPES as readonly string[]).includes(value);

  if (op === "add-column") {
    const flags = { nullable: false, defaultValue: undefined as unknown, hasDefault: false, policy: undefined as BackfillPolicy | undefined };
    const positional: string[] = [];
    let i = 0;
    while (i < rest.length) {
      const arg = rest[i]!;
      i += 1;
      if (arg === "--nullable") {
        flags.nullable = true;
        continue;
      }
      if (arg === "--default" || arg.startsWith("--default=")) {
        const value = arg.startsWith("--default=")
          ? arg.slice("--default=".length)
          : (() => {
              const v = rest[i];
              i += 1;
              if (v === undefined) fail("--default requires a value");
              return v;
            })();
        try {
          flags.defaultValue = JSON.parse(value) as unknown;
        } catch {
          fail(
            `--default must be valid JSON (strings quoted, e.g. --default '"promoted"' or --default 7), got '${value}'`,
          );
        }
        flags.hasDefault = true;
        continue;
      }
      if (arg === "--policy" || arg.startsWith("--policy=")) {
        const value = arg.startsWith("--policy=")
          ? arg.slice("--policy=".length)
          : (() => {
              const v = rest[i];
              i += 1;
              if (v === undefined) fail("--policy requires a value");
              return v;
            })();
        if (!["null", "default", "materialize"].includes(value))
          fail("--policy must be one of null|default|materialize");
        flags.policy = value as BackfillPolicy;
        continue;
      }
      if (arg.startsWith("--")) fail(`Unknown option '${arg}'`);
      positional.push(arg);
    }
    if (positional.length !== 1)
      fail("add-column takes exactly one positional: <name>=<type>");
    const eq = positional[0]!.indexOf("=");
    if (eq <= 0 || eq === positional[0]!.length - 1)
      fail(`--column style name=type expected, got '${positional[0]}'`);
    const name = positional[0]!.slice(0, eq);
    const type = positional[0]!.slice(eq + 1);
    if (!isDeclared(type))
      fail(
        `unsupported declared type '${type}' for column '${name}' (expected one of ${DECLARED_TYPES.join("|")})`,
      );
    return {
      ns,
      table,
      op: "addColumn",
      column: {
        name,
        type,
        nullable: flags.nullable,
        ...(flags.hasDefault ? { default: flags.defaultValue } : {}),
      },
      policy: flags.policy,
    };
  }

  // retype-column: <column> <type> — materialize is implied by the coordinator.
  if (rest.length !== 2)
    fail("retype-column takes exactly two positionals: <column> <type>");
  const [column, type] = rest as [string, string];
  if (!isDeclared(type))
    fail(
      `unsupported declared target type '${type}' (expected one of ${DECLARED_TYPES.join("|")})`,
    );
  return { ns, table, op: "retypeColumn", column, type };
}

/** Run the alter op through the DDL coordinator and print the result. */
async function runAlter(args: AlterArgs): Promise<void> {
  const root = path.resolve(resolveNamespacesPath());
  const options = { namespacesPath: root };
  if (args.op === "addColumn") {
    if (typeof args.column !== "object" || args.column === null)
      fail("add-column requires a name=type column");
    const result = await addColumn(
      args.ns,
      {
        table: args.table,
        column: {
          name: args.column.name,
          type: args.column.type as DeclaredColumnType,
          nullable: args.column.nullable,
          ...(args.column.default !== undefined
            ? { default: args.column.default }
            : {}),
        },
        ...(args.policy !== undefined ? { policy: args.policy } : {}),
      },
      options,
    );
    console.log(
      `Added column '${args.column.name}' to ${args.ns}/${args.table} (schemaVersion ${result.schemaVersion}).`,
    );
    if (result.generation)
      console.log(`Materialized generation: ${result.generation.path}`);
    return;
  }
  const result = await retypeColumn(
    args.ns,
    {
      table: args.table,
      column: args.column,
      type: args.type as DeclaredColumnType,
      policy: "materialize",
    },
    options,
  );
  console.log(
    `Retyped '${args.column}' on ${args.ns}/${args.table} to ${args.type} (schemaVersion ${result.schemaVersion}).`,
  );
  console.log(`Materialized generation: ${result.generation?.path}`);
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
 * success); throws TablesCliError for usage/validation failures, which the bin
 * entry prints and turns into exit 1.
 */
export async function runTablesCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printHelp();
    return 0;
  }
  if (sub === "audit-keys") {
    const args = parseAuditKeysArgs(rest);
    if (args === null) return 0;
    const audit = auditNamespaceTableKeys(args.namespace);
    printAuditKeys(audit);
    return audit.duplicateKeys === 0 ? 0 : 1;
  }
  if (sub === "alter") {
    // DDL-EVOLVE-001: the evolution surface. Usage failures throw
    // TablesCliError (the bin prints them); a DDL refusal is a state-on-disk
    // message printed here with the historical `Error: ` prefix and exit 1.
    const args = parseAlterArgs(rest);
    if (args === null) return 0;
    try {
      await runAlter(args);
      return 0;
    } catch (error) {
      if (error instanceof ApiError) {
        console.error(
          `Error: ${error.message}${error.code ? ` (${error.code})` : ""}`,
        );
        return 1;
      }
      throw error;
    }
  }
  if (sub !== "declare")
    fail(
      `Unknown tables subcommand: '${sub}' (expected: declare, alter or audit-keys; run "duckbrain tables --help")`,
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
    console.log(
      `Declared table '${result.table}' in ${result.path} (legacy .table.json).`,
    );
    printNextSteps(result.ns, nsDir, result.table, false, example);
    return 0;
  }
  console.log(
    `Declared table '${result.table}' in ${result.path} (schema.json, SUPA-6).`,
  );
  printNextSteps(result.ns, nsDir, result.table, true, example);
  return 0;
}
