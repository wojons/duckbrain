/**
 * Table declaration core (SURFACE-MCP-DATA-001)
 *
 * The `duckbrain tables declare` verb used to own this logic end to end, so
 * the only way to declare a table was argv. The MCP surface needs the same
 * capability, and "the same implementation the CLI and HTTP routes call (no
 * second code path)" is literal here: this module IS the CLI's declaration
 * path. `src/cli/tables.ts` parses argv and prints; it calls declareTable()
 * for every byte that lands on disk, exactly like the MCP tables_declare tool
 * does.
 *
 * Two on-disk shapes, both preserved verbatim from the CLI:
 *
 *   - SUPA-6 `schema.json` — merged into the namespace schema document under
 *     the cross-process DDL fence, validated with the production validator
 *     BEFORE the atomic switch, journaled in the DDL journal directory, and
 *     proven loadable through the REAL loader AFTER it (any failure rolls the
 *     previous text back).
 *   - legacy `tables/<table>.table.json` — written atomically and validated
 *     through the REAL legacy registry (listTables), with rollback on a
 *     rejected declaration.
 *
 * Failures throw TableDeclareError carrying the exact message the CLI used to
 * print, so both surfaces refuse identically.
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

/** DB-SUPA-3 column type → SUPA-6 canonical declared type. */
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

/**
 * A declaration the spec cannot be applied.
 *
 * `kind` preserves the CLI's historical split, which its tests pin:
 *   - "usage": the ARGUMENTS are wrong (bad name, unknown type, missing
 *     column) — the CLI throws TablesCliError, the bin prints it, exit 1.
 *   - "refusal": the arguments are well-formed but the WRITE is refused
 *     (conflicting declaration, invalid document, loader rejection) — the
 *     CLI prints `Error: <message>` and exits 1, because the message is about
 *     state on disk, not about the command line.
 */
export class TableDeclareError extends Error {
  readonly kind: "usage" | "refusal";

  constructor(message: string, kind: "usage" | "refusal" = "usage") {
    super(message);
    this.name = "TableDeclareError";
    this.kind = kind;
  }
}

function fail(message: string): never {
  throw new TableDeclareError(message, "usage");
}

/** A well-formed request refused by the state on disk. */
function refuse(message: string): never {
  throw new TableDeclareError(message, "refusal");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** A declaration request, transport-neutral (CLI argv or MCP arguments). */
export interface DeclareTableSpec {
  ns: string;
  table: string;
  /** Column list in CLI/DB-SUPA-3 type names (`id=integer`). */
  columns: Array<{ name: string; type: string }>;
  primary?: string;
  format?: TableFormat;
  /** Write tables/<table>.table.json instead of the SUPA-6 schema.json. */
  legacy?: boolean;
  /** Replace an existing declaration of the same table name. */
  force?: boolean;
}

export interface DeclareTableResult {
  ns: string;
  table: string;
  /** Absolute path of the file the declaration landed in. */
  path: string;
  /** Which on-disk shape was written. */
  format: "schema.json" | "legacy";
  /** True when an existing identical declaration already matched. */
  replacedExisting: boolean;
}

function validateName(kind: string, value: string): void {
  if (!NAME_PATTERN.test(value))
    fail(
      `${kind} name '${value}' must match ${NAME_PATTERN.source} (lowercase letters, digits, '-', '_')`,
    );
}

function buildDeclaredColumns(spec: DeclareTableSpec): {
  columns: DeclaredColumn[];
  primary: string;
} {
  if (spec.columns.length === 0)
    fail("at least one --column name=type is required");
  // The primary key defaults to the FIRST declared column, decided BEFORE
  // nullability is assigned — a declared key column is always non-nullable,
  // and deciding it after the loop would mint a nullable key column that the
  // schema validator rejects (key columns must be non-nullable).
  const primary = spec.primary ?? spec.columns[0]!.name;
  const seen = new Set<string>();
  const columns: DeclaredColumn[] = [];
  for (const { name, type } of spec.columns) {
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
  if (spec.primary !== undefined) {
    if (!columns.some((column) => column.name === spec.primary))
      fail(`--primary '${spec.primary}' must name one of the declared columns`);
  }
  return { columns, primary };
}

/**
 * Declare a table. Throws TableDeclareError on any validation or write
 * refusal; resolves only when the declaration is on disk AND proven loadable
 * through the real registry loader.
 */
export async function declareTable(
  spec: DeclareTableSpec,
): Promise<DeclareTableResult> {
  if (!TABLE_FORMATS.includes(spec.format ?? "jsonl-objects"))
    fail(
      `--format must be one of ${TABLE_FORMATS.join("|")}, got '${spec.format}'`,
    );
  validateName("Namespace", spec.ns);
  validateName("Table", spec.table);
  const { columns, primary } = buildDeclaredColumns(spec);

  // GAP-062 path resolution: the same config-resolved namespaces root the
  // rest of the CLI/HTTP surface uses (never the caller's cwd).
  const root = path.resolve(resolveNamespacesPath());
  const nsDir = path.join(root, spec.ns);
  const format = spec.format ?? "jsonl-objects";

  if (spec.legacy) {
    // The legacy TableDeclaration shape (src/schema/table-registry.ts): CLI
    // column types are used VERBATIM (they ARE the legacy types), the name
    // must equal the declaration file base name, and the glob is relative to
    // the namespace dir.
    const declaration = {
      name: spec.table,
      format,
      columns: spec.columns.map(({ name, type }) => ({ name, type })),
      primary: spec.primary ?? null,
      glob: `tables/${spec.table}.jsonl`,
    };
    return declareLegacyFile({
      ns: spec.ns,
      nsDir,
      table: spec.table,
      declaration,
    });
  }

  // SUPA-6 path: the table name must satisfy the stricter schema-document
  // rules (RESOURCE_NAME_PATTERN + reserved names) because schema.json is the
  // DDL surface — the production validator would reject anything else.
  if (!RESOURCE_NAME_PATTERN.test(spec.table))
    fail(
      `table name '${spec.table}' must match ${RESOURCE_NAME_PATTERN.source} for a schema.json declaration (use --legacy for the permissive legacy shape)`,
    );
  if (isReservedResourceName(spec.table))
    fail(`table name '${spec.table}' is a reserved resource name`);

  const candidate: SchemaTable = {
    schemaVersion: 1,
    storage: { path: `tables/${spec.table}/current.jsonl` },
    rowShape: (format === "jsonl-positional" ? "positional" : "object") as RowShape,
    keyColumns: [primary],
    columns,
  };
  return declareIntoSchemaJson({
    ns: spec.ns,
    nsDir,
    root,
    table: spec.table,
    candidate,
    force: spec.force === true,
  });
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
}): Promise<DeclareTableResult> {
  const { ns, nsDir, root, table, candidate, force } = options;
  const schemaFile = path.join(nsDir, SCHEMA_FILE_NAME);
  const fence = await acquireDdlFence(ns, root, 30_000);
  let result: DeclareTableResult | null = null;
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
        refuse(
          `refusing to merge into an invalid ${SCHEMA_FILE_NAME}: ${messageOf(error)}`,
        );
      }
    }

    const existing = document.tables[table];
    if (existing && !force && !sameCanonicalTable(existing, candidate)) {
      refuse(
        `table '${table}' is already declared in ${schemaFile} with a different contract. Re-run with --force to replace it.`,
      );
    }

    const nextDocument: SchemaDocument = {
      ...document,
      tables: { ...document.tables, [table]: candidate },
    };
    // Validate the candidate document BEFORE writing anything: an invalid
    // declaration must fail without leaving a single byte behind.
    const problems = schemaDocumentProblems(nextDocument);
    if (problems.length > 0) {
      refuse(`the resulting ${SCHEMA_FILE_NAME} would be invalid: ${problems.join("; ")}`);
    }

    const restore = (): void => {
      if (previousText !== null) writeSchemaTextAtomic(nsDir, previousText, { ns });
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
      path.join(
        nsDir,
        DDL_DIR,
        `declare-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.json`,
      ),
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
        oldSchemaHash: previousText === null ? null : sha256Hex(previousText),
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
    const loaded = loadNamespaceSchema(ns, { namespacesPath: root, force: true });
    if (!loaded.present || loaded.error !== null) {
      restore();
      invalidateNamespaceSchema(ns);
      invalidateTableRegistry(ns);
      refuse(
        `the written ${SCHEMA_FILE_NAME} failed the real schema loader: ${
          loaded.error?.message ?? "document did not load"
        }. The previous schema was restored.`,
      );
    }

    result = {
      ns,
      table,
      path: switched.path,
      format: "schema.json",
      replacedExisting: existing !== undefined,
    };
    return result;
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
}): DeclareTableResult {
  const { ns, nsDir, table, declaration } = options;
  const tablesDir = path.join(nsDir, "tables");
  const file = path.join(tablesDir, `${table}.table.json`);
  const previousText = readTextOrNull(file);

  fs.mkdirSync(tablesDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(declaration, null, 2)}\n`);

  // Validate through the REAL legacy registry: listTables reads and validates
  // every declaration file and throws on a bad one — the same validator
  // src/http/routes/tables.ts serves through. The cache is dropped first so
  // this read is guaranteed to hit the disk.
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
    refuse(`the written declaration failed the legacy table registry: ${problem}. The previous state was restored.`);
  }

  return {
    ns,
    table,
    path: file,
    format: "legacy",
    replacedExisting: previousText !== null,
  };
}
