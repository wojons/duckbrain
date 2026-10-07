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
 * The schema.json path is NOT a hand-rolled writer: it goes through the same
 * primitives the DDL coordinator (src/serialization/ddl.ts) uses — the
 * cross-process namespace fence and the atomic temp+rename schema switch —
 * and every switch is journaled-shaped under `.duckbrain-ddl/` conventions
 * exactly like a DDL operation, because an UNJOURNALED schema switch poisons
 * later crash recovery (a future DDL journal must stay classifiable against
 * the live schema hash). The candidate document is validated with the
 * production validator (schemaDocumentProblems) BEFORE the switch and proven
 * loadable through the REAL loader (loadNamespaceSchema) AFTER it; any
 * failure rolls the previous schema text back, so a failed declare never
 * leaves the namespace with a broken schema.
 *
 * Column types on the command line are the DB-SUPA-3 DuckDB-facing names
 * (TABLE_COLUMN_TYPES, reused from src/schema/table-registry.ts — never
 * duplicated here). They are translated to the SUPA-6 canonical declared
 * types the schema document carries:
 *
 *   varchar → string    integer → float64    bigint → int64
 *   double → float64    boolean → boolean    timestamp → timestamp
 *   json → json
 *
 * `integer` deliberately maps to `float64` (not `int64`): the SUPA-6 write
 * path is canonical-only (an int64 row value must arrive as a base-10
 * STRING — a JSON number is rejected), so an `integer` column declared as
 * int64 would refuse the natural POST {"id": 1}. float64 stores the JSON
 * number exactly for every value below 2^53 and is a legal key-column type.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { resolveNamespacesPath } from "../config/index.js";
import { releaseNamespaceWriteLock } from "../serialization/lock.js";
import {
  DDL_DIR,
  acquireDdlFence,
  writeSchemaTextAtomic,
} from "../serialization/ddl.js";
import {
  emptySchemaDocument,
  formatSchemaDocument,
  parseSchemaDocument,
  sameCanonicalTable,
  schemaDocumentProblems,
  type SchemaDocument,
  type SchemaTable,
} from "../serialization/schemaJson.js";
import {
  SCHEMA_FILE_NAME,
  invalidateNamespaceSchema,
  loadNamespaceSchema,
} from "../serialization/schemaRegistry.js";
import {
  COLUMN_NAME_PATTERN,
  RESOURCE_NAME_PATTERN,
  isReservedResourceName,
  type DeclaredColumn,
  type DeclaredColumnType,
  type RowShape,
} from "../serialization/schemaTypes.js";
import {
  TABLE_COLUMN_TYPES,
  TABLE_FORMATS,
  invalidateTableRegistry,
  listTables,
  type TableFormat,
} from "../schema/table-registry.js";

/** DB-SUPA-3 column type → SUPA-6 canonical declared type (see module docs). */
const CLI_TYPE_TO_DECLARED: Record<string, DeclaredColumnType> = {
  varchar: "string",
  integer: "float64",
  bigint: "int64",
  double: "float64",
  boolean: "boolean",
  timestamp: "timestamp",
  json: "json",
};

/** Namespace/table segments must be URL-safe and filesystem-safe. */
const NAME_PATTERN = /^[a-z0-9_-]+$/;

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
tables/<table>.table.json declaration instead.

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  console.log(TABLES_DECLARE_USAGE);
}

function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
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

function validateName(kind: string, value: string): void {
  if (!NAME_PATTERN.test(value))
    fail(
      `${kind} name '${value}' must match ${NAME_PATTERN.source} (lowercase letters, digits, '-', '_')`,
    );
}

function buildDeclaredColumns(args: DeclareArgs): {
  columns: DeclaredColumn[];
  primary: string;
} {
  if (args.columns.length === 0)
    fail("at least one --column name=type is required");
  // The primary key defaults to the FIRST declared column, decided BEFORE
  // nullability is assigned — a declared key column is always non-nullable,
  // and deciding it after the loop would mint a nullable key column that
  // the schema validator rejects (key columns must be non-nullable).
  const primary = args.primary ?? args.columns[0]!.name;
  const seen = new Set<string>();
  const columns: DeclaredColumn[] = [];
  for (const { name, type } of args.columns) {
    if (!COLUMN_NAME_PATTERN.test(name))
      fail(
        `column name '${name}' is not a valid identifier (letters, digits, '_', starting with a letter or '_')`,
      );
    if (seen.has(name)) fail(`duplicate column '${name}'`);
    seen.add(name);
    if (!(TABLE_COLUMN_TYPES as readonly string[]).includes(type))
      fail(
        `unsupported column type '${type}' for column '${name}' (expected one of ${TABLE_COLUMN_TYPES.join("|")})`,
      );
    columns.push({
      name,
      type: CLI_TYPE_TO_DECLARED[type]!,
      nullable: name !== primary,
    });
  }
  if (args.primary !== undefined) {
    if (!columns.some((column) => column.name === args.primary))
      fail(`--primary '${args.primary}' must name one of the declared columns`);
  }
  return { columns, primary };
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
  console.log(
    "  1. Start the HTTP server (if it is not already running):",
  );
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
      `The declaration lives in ${path.join(nsDir, SCHEMA_FILE_NAME)}; further "duckbrain tables declare" runs merge into the same file.`,
    );
  }
}

// ---------------------------------------------------------------------------
// schema.json path (SUPA-6)
// ---------------------------------------------------------------------------

async function declareIntoSchemaJson(options: {
  ns: string;
  nsDir: string;
  root: string;
  table: string;
  candidate: SchemaTable;
  force: boolean;
  /** Pre-rendered curl example body (keyed by CLI type names). */
  example: string;
}): Promise<number> {
  const { ns, nsDir, root, table, candidate, force, example } = options;
  const schemaFile = path.join(nsDir, SCHEMA_FILE_NAME);
  const fence = await acquireDdlFence(ns, root, 30_000);
  try {
    // Merge decision INSIDE the fence, so no concurrent DDL can interleave.
    const previousText = readTextOrNull(schemaFile);
    let document: SchemaDocument = emptySchemaDocument();
    if (previousText !== null) {
      try {
        document = parseSchemaDocument(JSON.parse(previousText), {
          where: schemaFile,
        });
      } catch (error) {
        console.error(
          `Error: refusing to merge into an invalid ${SCHEMA_FILE_NAME}: ${messageOf(error)}`,
        );
        return 1;
      }
    }

    const existing = document.tables[table];
    if (existing && !force && !sameCanonicalTable(existing, candidate)) {
      console.error(
        `Error: table '${table}' is already declared in ${schemaFile} with a different contract. Re-run with --force to replace it.`,
      );
      return 1;
    }

    const nextDocument: SchemaDocument = {
      ...document,
      tables: { ...document.tables, [table]: candidate },
    };
    // Validate the candidate document BEFORE writing anything: an invalid
    // declaration must fail without leaving a single byte behind.
    const problems = schemaDocumentProblems(nextDocument);
    if (problems.length > 0) {
      console.error(
        `Error: the resulting ${SCHEMA_FILE_NAME} would be invalid: ${problems.join("; ")}`,
      );
      return 1;
    }

    const restore = (): void => {
      if (previousText !== null)
        writeSchemaTextAtomic(nsDir, previousText, { ns });
      else {
        try {
          fs.unlinkSync(schemaFile);
        } catch {
          // best effort — there was no previous document
        }
      }
    };

    const switchText = formatSchemaDocument(nextDocument);
    const switched = writeSchemaTextAtomic(nsDir, switchText, { ns });
    // Journal the switch in the DDL journal format BEFORE reporting success
    // (and AFTER the atomic rename), so crash-recovery evidence stays
    // classifiable: recovery compares the live schema hash against the
    // journaled old/new hashes. `switched` is also a status journal here —
    // the declare already completed before it was written, so recovery
    // finalizes it without touching the file again.
    writeJsonAtomic(
      path.join(nsDir, DDL_DIR, `declare-${Date.now().toString(36)}-${crypto
        .randomBytes(4)
        .toString("hex")}.json`),
      {
        operation: "createTable",
        ns,
        table,
        status: "finalized",
        request: {
          table,
          rowShape: candidate.rowShape,
          keyColumns: candidate.keyColumns,
          columns: candidate.columns,
          storagePath: candidate.storage.path,
        },
        oldSchemaHash:
          previousText === null ? null : sha256Hex(previousText),
        newSchemaHash: switched.hash,
        detail:
          "declared via `duckbrain tables declare` (no generation published)",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    );
    // Prove the result through the REAL loader (no mock of the validator).
    invalidateNamespaceSchema(ns);
    invalidateTableRegistry(ns);
    const loaded = loadNamespaceSchema(ns, {
      namespacesPath: root,
      force: true,
    });
    if (!loaded.present || loaded.error !== null) {
      restore();
      invalidateNamespaceSchema(ns);
      invalidateTableRegistry(ns);
      console.error(
        `Error: the written ${SCHEMA_FILE_NAME} failed the real schema loader: ${
          loaded.error?.message ?? "document did not load"
        }. The previous schema was restored.`,
      );
      return 1;
    }

    console.log(
      `Declared table '${table}' in ${switched.path} (schema.json, SUPA-6).`,
    );
    printNextSteps(ns, nsDir, table, true, example);
    return 0;
  } finally {
    releaseNamespaceWriteLock(fence);
    // Same post-fence invalidation pattern as the DDL coordinator: the next
    // read in ANY surface sees the file that is on disk now.
    invalidateNamespaceSchema(ns);
    invalidateTableRegistry(ns);
    loadNamespaceSchema(ns, { namespacesPath: root, force: true });
  }
}

// ---------------------------------------------------------------------------
// legacy path (tables/<table>.table.json)
// ---------------------------------------------------------------------------

function declareLegacyFile(options: {
  ns: string;
  nsDir: string;
  table: string;
  declaration: Record<string, unknown>;
  example: string;
}): number {
  const { ns, nsDir, table, declaration } = options;
  const tablesDir = path.join(nsDir, "tables");
  const file = path.join(tablesDir, `${table}.table.json`);
  const previousText = readTextOrNull(file);

  fs.mkdirSync(tablesDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(declaration, null, 2)}\n`);

  // Validate through the REAL legacy registry: listTables reads and
  // validates every declaration file and throws on a bad one — the same
  // validator src/http/routes/tables.ts serves through. The cache is
  // dropped first so this read is guaranteed to hit the disk.
  let problem: string | null = null;
  try {
    invalidateTableRegistry(ns);
    listTables(ns);
  } catch (error) {
    problem = messageOf(error);
  }
  if (problem !== null) {
    if (previousText !== null) fs.writeFileSync(file, previousText);
    else {
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
    }
    invalidateTableRegistry(ns);
    console.error(
      `Error: the written declaration failed the legacy table registry: ${problem}. The previous state was restored.`,
    );
    return 1;
  }

  console.log(`Declared table '${table}' in ${file} (legacy .table.json).`);
  printNextSteps(ns, nsDir, table, false, options.example);
  return 0;
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
  validateName("Namespace", args.ns);
  validateName("Table", args.table);
  const { columns, primary } = buildDeclaredColumns(args);
  const example = exampleBodyFor(args.columns);

  // GAP-062 path resolution: the same config-resolved namespaces root the
  // rest of the CLI/HTTP surface uses (never the caller's cwd).
  const root = path.resolve(resolveNamespacesPath());
  const nsDir = path.join(root, args.ns);

  if (args.legacy) {
    // The legacy TableDeclaration shape (src/schema/table-registry.ts):
    // CLI column types are used VERBATIM (they ARE the legacy types), the
    // name must equal the declaration file base name, and the glob is
    // relative to the namespace dir.
    const declaration = {
      name: args.table,
      format: args.format,
      columns: args.columns.map(({ name, type }) => ({ name, type })),
      primary: args.primary ?? null,
      glob: `tables/${args.table}.jsonl`,
    };
    return declareLegacyFile({
      ns: args.ns,
      nsDir,
      table: args.table,
      declaration,
      example,
    });
  }

  // SUPA-6 path: the table name must satisfy the stricter schema-document
  // rules (RESOURCE_NAME_PATTERN + reserved names) because schema.json is
  // the DDL surface — the production validator would reject anything else.
  if (!RESOURCE_NAME_PATTERN.test(args.table))
    fail(
      `table name '${args.table}' must match ${RESOURCE_NAME_PATTERN.source} for a schema.json declaration (use --legacy for the permissive legacy shape)`,
    );
  if (isReservedResourceName(args.table))
    fail(`table name '${args.table}' is a reserved resource name`);

  const candidate: SchemaTable = {
    schemaVersion: 1,
    storage: { path: `tables/${args.table}/current.jsonl` },
    rowShape: (args.format === "jsonl-positional"
      ? "positional"
      : "object") as RowShape,
    keyColumns: [primary],
    columns,
  };
  return declareIntoSchemaJson({
    ns: args.ns,
    nsDir,
    root,
    table: args.table,
    candidate,
    force: args.force,
    example,
  });
}
