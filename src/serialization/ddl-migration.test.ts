/**
 * DB-SUPA-6 AC-5 — single-switch materialized migration and recovery.
 *
 * Every crash point is a REAL process death (`crashAfter` makes the coordinator
 * exit at that durability boundary) and recovery is always driven from a FRESH
 * process, so nothing here depends on in-process state. The checks inspect the
 * schema file, BOTH immutable generations and the migration journal.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { addColumn, createTable, type DdlCallOptions } from "./ddl";
import { loadNamespaceSchema, declaredRowValidator } from "./schemaRegistry";
import {
  getTable,
  invalidateTableRegistry,
  namespaceDir,
} from "../schema/table-registry";
import { buildSelectPlan, executeSelectPlan } from "../duckdb/table-store";
import type { AuthPrincipal } from "../auth/middleware";

// TEST-002: file-scoped test budget only — the pre-switch crash test exceeds
// the 15s default under full-suite host load.
vi.setConfig({ testTimeout: 60_000 });

const NS = "supa6-migration";
const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const roots: string[] = [];
const children: ChildProcess[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-migration-"));
  roots.push(root);
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
  fs.mkdirSync(path.join(root, NS), { recursive: true });
  return root;
}

function options(root: string): DdlCallOptions {
  return {
    namespacesPath: root,
    principal: ADMIN,
    scheduleCommit: () => undefined,
  };
}

const schemaPath = (root: string): string => path.join(root, NS, "schema.json");
const storagePath = (root: string): string =>
  path.join(root, NS, "tables", "migration", "current.jsonl");
const generationDir = (root: string): string =>
  path.join(root, NS, "tables", "migration", "generations");

function sha(file: string): string {
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

function journals(
  root: string,
  operation?: string,
): Array<Record<string, unknown>> {
  const dir = path.join(root, NS, ".duckbrain-ddl");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readJson<Record<string, unknown>>(path.join(dir, entry)))
    .filter(
      (journal) => operation === undefined || journal.operation === operation,
    );
}

async function readRows(table: string): Promise<Record<string, unknown>[]> {
  invalidateTableRegistry(NS);
  const declaration = getTable(NS, table);
  const plan = buildSelectPlan(declaration, { limit: 100 });
  const result = await executeSelectPlan(namespaceDir(NS), declaration, plan);
  return result.rows;
}

/** Seed a namespace with a declared table and two existing rows. */
async function seed(root: string): Promise<void> {
  fs.mkdirSync(path.dirname(storagePath(root)), { recursive: true });
  fs.writeFileSync(
    storagePath(root),
    `${JSON.stringify({ id: "a", big: "12" })}\n${JSON.stringify({ id: "b", big: "42" })}\n`,
  );
  const created = await createTable(
    NS,
    {
      table: "migration",
      rowShape: "object",
      keyColumns: ["id"],
      storagePath: "tables/migration/current.jsonl",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "big", type: "int64", nullable: false },
      ],
    },
    options(root),
  );
  expect(created.ok).toBe(true);
}

/** The child-process harness: run one DDL action, optionally crashing. */
function writeChildScript(root: string): string {
  const ddlModule = JSON.stringify(path.resolve(__dirname, "ddl.ts"));
  const script = [
    `import fs from "fs";`,
    `import { addColumn, createTable, retypeColumn, recoverNamespaceDdl, namespaceDdlFailClosed } from ${ddlModule};`,
    `const spec = JSON.parse(process.argv[2]);`,
    `const options = {`,
    `  namespacesPath: spec.root,`,
    `  scheduleCommit: () => undefined,`,
    `  ...(spec.crashAfter ? { crashAfter: spec.crashAfter } : {}),`,
    `  ...(spec.readyFile`,
    `    ? { onFenceAcquired: async () => {`,
    `        fs.writeFileSync(spec.readyFile, "ready");`,
    `        while (!fs.existsSync(spec.releaseFile)) await new Promise((resolve) => setTimeout(resolve, 20));`,
    `      } }`,
    `    : {}),`,
    `};`,
    `void (async () => {`,
    `  if (spec.action === "recover") {`,
    `    const outcomes = await recoverNamespaceDdl(spec.ns, options);`,
    `    console.log("OUTCOMES " + JSON.stringify(outcomes));`,
    `    console.log("FAILCLOSED " + String(namespaceDdlFailClosed(spec.ns, options)));`,
    `    return;`,
    `  }`,
    `  if (spec.action === "createTable") {`,
    `    const result = await createTable(`,
    `      spec.ns,`,
    `      {`,
    `        table: spec.table,`,
    `        rowShape: "object",`,
    `        keyColumns: ["id"],`,
    `        storagePath: "tables/migration/current.jsonl",`,
    `        columns: [`,
    `          { name: "id", type: "string", nullable: false },`,
    `          { name: "big", type: "int64", nullable: false },`,
    `        ],`,
    `      },`,
    `      options,`,
    `    );`,
    `    console.log("OK " + JSON.stringify(result));`,
    `    return;`,
    `  }`,
    `  if (spec.action === "addColumn") {`,
    `    const result = await addColumn(spec.ns, { table: spec.table, column: spec.column, ...(spec.policy ? { policy: spec.policy } : {}) }, options);`,
    `    console.log("OK " + JSON.stringify(result));`,
    `    return;`,
    `  }`,
    `  if (spec.action === "retypeColumn") {`,
    `    const result = await retypeColumn(spec.ns, { table: spec.table, column: spec.columnName, type: spec.columnType, policy: "materialize" }, options);`,
    `    console.log("OK " + JSON.stringify(result));`,
    `    return;`,
    `  }`,
    `})().catch((error) => {`,
    `  const failure = error as { code?: string; message?: string };`,
    `  console.error("CHILD_ERROR " + (failure.code ?? "") + " " + (failure.message ?? String(error)));`,
    `  process.exit(1);`,
    `});`,
    ``,
  ].join("\n");
  const file = path.join(root, "ddl-child.ts");
  fs.writeFileSync(file, script);
  return file;
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runChild(script: string, spec: unknown): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, JSON.stringify(spec)],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit: ${stdout}${stderr}`));
    }, 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  children.length = 0;
  invalidateTableRegistry(NS);
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

describe("SUPA-6 materialized migration and recovery", () => {
  it("pre-switch crash preserves old schema and generation", async () => {
    const root = makeRoot();
    await seed(root);
    const script = writeChildScript(root);
    const schemaBefore = sha(schemaPath(root));
    const storageBefore = sha(storagePath(root));

    const crashed = await runChild(script, {
      root,
      ns: NS,
      action: "addColumn",
      table: "migration",
      column: {
        name: "tag",
        type: "string",
        nullable: false,
        default: "promoted",
      },
      policy: "materialize",
      crashAfter: "generation-written",
    });
    expect(crashed.code).toBe(97); // hard crash at the durability boundary

    // Pre-switch state: old schema + old path + old data stay live, and the
    // unpublished generation exists but is referenced by nobody.
    expect(sha(schemaPath(root))).toBe(schemaBefore);
    expect(sha(storagePath(root))).toBe(storageBefore);
    const generations = fs.readdirSync(generationDir(root));
    expect(generations).toHaveLength(1);
    const unpublished = path.join(generationDir(root), generations[0]!);
    expect(fs.readFileSync(unpublished, "utf-8")).toMatch(/promoted/);
    const preSwitch = loadNamespaceSchema(NS, {
      namespacesPath: root,
    }).document;
    expect(preSwitch.tables.migration?.storage.path).toBe(
      "tables/migration/current.jsonl",
    );
    expect(preSwitch.tables.migration?.schemaVersion).toBe(1);
    // Readers see the OLD shape: no `tag` column at all.
    expect(await readRows("migration")).toEqual([
      { id: "a", big: "12" },
      { id: "b", big: "42" },
    ]);

    // Recovery in a FRESH process removes only the unpublished generation.
    const recovered = await runChild(script, {
      root,
      ns: NS,
      action: "recover",
    });
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toMatch(/"action":"abandoned"/);
    expect(recovered.stdout).toMatch(/unpublished generation/);
    expect(fs.existsSync(unpublished)).toBe(false);
    expect(sha(schemaPath(root))).toBe(schemaBefore);
    expect(sha(storagePath(root))).toBe(storageBefore);
    expect(
      journals(root, "addColumn").map((journal) => journal.status),
    ).toEqual(["abandoned"]);

    // A later operation on the same table works normally.
    const retried = await addColumn(
      NS,
      {
        table: "migration",
        column: {
          name: "tag",
          type: "string",
          nullable: false,
          default: "promoted",
        },
        policy: "materialize",
      },
      options(root),
    );
    expect(retried.ok).toBe(true);
    // The abandoned generation was cleaned up by recovery; only the newly
    // published one remains (the old live generation is a plain file, not a
    // generation entry).
    expect(fs.readdirSync(generationDir(root))).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(root, NS, retried.generation!.path), "utf-8"),
    ).toMatch(/promoted/);
    // The old generation is untouched by the migration.
    expect(sha(storagePath(root))).toBe(storageBefore);
  });

  it("schema switch exposes complete immutable generation", async () => {
    const root = makeRoot();
    await seed(root);
    const script = writeChildScript(root);
    const schemaBefore = sha(schemaPath(root));
    const storageBefore = sha(storagePath(root));

    const crashed = await runChild(script, {
      root,
      ns: NS,
      action: "addColumn",
      table: "migration",
      column: {
        name: "tag",
        type: "string",
        nullable: false,
        default: "promoted",
      },
      policy: "materialize",
      crashAfter: "schema-switched",
    });
    expect(crashed.code).toBe(97);

    // The ONLY reader-visible switch happened: schema.json points at the new,
    // fully valid immutable generation; the old generation is untouched.
    const schema = loadNamespaceSchema(NS, { namespacesPath: root }).document;
    expect(sha(schemaPath(root))).not.toBe(schemaBefore);
    const table = schema.tables.migration!;
    expect(table.storage.path).toMatch(
      /^tables\/migration\/generations\/addColumn-.*\.jsonl$/,
    );
    expect(table.schemaVersion).toBe(2);
    expect(table.columns.map((column) => column.name)).toContain("tag");
    expect(sha(storagePath(root))).toBe(storageBefore);

    // Every row of the new generation validates against the new declaration.
    const generation = path.join(root, NS, table.storage.path);
    const lines = fs
      .readFileSync(generation, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
    const validator = declaredRowValidator(table);
    for (const line of lines) {
      const parsed = validator.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      expect(JSON.parse(line).tag).toBe("promoted");
    }
    // The journal is still pre-finalization (the crash landed between the
    // switch and the journal update) — recovery classifies by hash, not status.
    expect(
      journals(root, "addColumn").map((journal) => journal.status),
    ).toEqual(["generation-written"]);
    // Readers now see the new shape through the declared path.
    expect(await readRows("migration")).toEqual([
      { id: "a", big: "12", tag: "promoted" },
      { id: "b", big: "42", tag: "promoted" },
    ]);
  });

  it("post-switch crash verifies and finalizes without rollback", async () => {
    const root = makeRoot();
    await seed(root);
    const script = writeChildScript(root);
    const storageBefore = sha(storagePath(root));

    const crashed = await runChild(script, {
      root,
      ns: NS,
      action: "addColumn",
      table: "migration",
      column: {
        name: "tag",
        type: "string",
        nullable: false,
        default: "promoted",
      },
      policy: "materialize",
      crashAfter: "schema-switched",
    });
    expect(crashed.code).toBe(97);
    const schemaAfterCrash = sha(schemaPath(root));
    const switched = loadNamespaceSchema(NS, { namespacesPath: root }).document
      .tables.migration!;
    const generation = path.join(root, NS, switched.storage.path);

    // Recovery in a fresh process verifies the new path + digest and finalizes.
    const recovered = await runChild(script, {
      root,
      ns: NS,
      action: "recover",
    });
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toMatch(/"action":"finalized"/);
    expect(recovered.stdout).toMatch(/FAILCLOSED false/);
    expect(
      journals(root, "addColumn").map((journal) => journal.status),
    ).toEqual(["finalized"]);
    // No rollback: the schema is exactly what the crashed process published.
    expect(sha(schemaPath(root))).toBe(schemaAfterCrash);
    expect(
      loadNamespaceSchema(NS, { namespacesPath: root }).document.tables
        .migration?.storage.path,
    ).toBe(switched.storage.path);
    // The old generation survives, untouched, and is unreferenced.
    expect(sha(storagePath(root))).toBe(storageBefore);
    expect(fs.existsSync(generation)).toBe(true);
    expect(
      loadNamespaceSchema(NS, { namespacesPath: root }).document.tables
        .migration?.schemaVersion,
    ).toBe(2);

    // Fail-closed sub-case: if the published generation's evidence is missing,
    // recovery refuses to guess and generic work is refused until an operator
    // resolves it.
    const secondRoot = makeRoot();
    await seed(secondRoot);
    const secondScript = writeChildScript(secondRoot);
    const secondCrash = await runChild(secondScript, {
      root: secondRoot,
      ns: NS,
      action: "addColumn",
      table: "migration",
      column: {
        name: "tag",
        type: "string",
        nullable: false,
        default: "promoted",
      },
      policy: "materialize",
      crashAfter: "schema-switched",
    });
    expect(secondCrash.code).toBe(97);
    const secondSchema = loadNamespaceSchema(NS, {
      namespacesPath: secondRoot,
    }).document.tables.migration!;
    // Tamper with the published generation: the journaled digest no longer
    // matches what is on disk.
    fs.appendFileSync(
      path.join(secondRoot, NS, secondSchema.storage.path),
      `${JSON.stringify({ id: "truncated" })}\n`,
    );
    const tamperedRecovery = await runChild(secondScript, {
      root: secondRoot,
      ns: NS,
      action: "recover",
    });
    expect(tamperedRecovery.code).toBe(0);
    expect(tamperedRecovery.stdout).toMatch(/"action":"fail-closed"/);
    expect(tamperedRecovery.stdout).toMatch(/FAILCLOSED true/);
    expect(sha(schemaPath(secondRoot))).not.toBe("");
    // Nothing was rolled back by the fail-closed verdict either.
    expect(
      loadNamespaceSchema(NS, { namespacesPath: secondRoot }).document.tables
        .migration?.storage.path,
    ).toBe(secondSchema.storage.path);
  });

  it("first declaration crash on a legacy namespace classifies by hash", async () => {
    const root = makeRoot();
    // A legacy namespace: no schema.json at all yet.
    expect(fs.existsSync(schemaPath(root))).toBe(false);
    const script = writeChildScript(root);

    // Pre-switch crash (the "prepared" boundary, before the rename).
    const preSwitch = await runChild(script, {
      root,
      ns: NS,
      action: "createTable",
      table: "migration",
      crashAfter: "generation-written",
    });
    expect(preSwitch.code).toBe(97);
    expect(fs.existsSync(schemaPath(root))).toBe(false);
    const abandoned = await runChild(script, {
      root,
      ns: NS,
      action: "recover",
    });
    expect(abandoned.stdout).toMatch(/"action":"abandoned"/);
    expect(fs.existsSync(schemaPath(root))).toBe(false);

    // Post-switch crash: the first declaration is already published, so
    // recovery finalizes instead of rolling back to "no schema".
    const postSwitch = await runChild(script, {
      root,
      ns: NS,
      action: "createTable",
      table: "migration",
      crashAfter: "schema-switched",
    });
    expect(postSwitch.code).toBe(97);
    expect(fs.existsSync(schemaPath(root))).toBe(true);
    const finalized = await runChild(script, {
      root,
      ns: NS,
      action: "recover",
    });
    expect(finalized.stdout).toMatch(/"action":"finalized"/);
    expect(finalized.stdout).toMatch(/FAILCLOSED false/);
    expect(
      loadNamespaceSchema(NS, { namespacesPath: root }).document.tables
        .migration?.storage.path,
    ).toBe("tables/migration/current.jsonl");
  });

  it("conversion failure preserves old state", async () => {
    const root = makeRoot();
    await seed(root);
    fs.writeFileSync(
      path.join(root, NS, "tables", "migration", "current.jsonl"),
      `${JSON.stringify({ id: "a", big: "9223372036854775807" })}\n`,
    );
    const schemaBefore = sha(schemaPath(root));
    const storageBefore = sha(storagePath(root));

    // A required column cannot be materialized without a value for every row.
    await expect(
      addColumn(
        NS,
        {
          table: "migration",
          column: { name: "wide", type: "float64", nullable: false },
          policy: "materialize",
        },
        options(root),
      ),
    ).rejects.toMatchObject({ code: "BACKFILL_POLICY_REQUIRED" });
    // A lossy int64 → float64 conversion aborts before ANY write.
    await expect(
      (await import("./ddl.js")).retypeColumn(
        NS,
        {
          table: "migration",
          column: "big",
          type: "float64",
          policy: "materialize",
        },
        options(root),
      ),
    ).rejects.toMatchObject({ code: "CONVERSION_FAILED" });

    // Old schema, old path and old data are exactly as they were.
    expect(sha(schemaPath(root))).toBe(schemaBefore);
    expect(sha(storagePath(root))).toBe(storageBefore);
    expect(fs.existsSync(generationDir(root))).toBe(false);
    // The journal records the failure rather than dangling as "started".
    expect(
      journals(root, "retypeColumn").map((journal) => journal.status),
    ).toEqual(["failed"]);
    // The policy rejection happens before the fence, so no journal was opened
    // (and therefore no generation or unpublished state exists).
    expect(journals(root, "addColumn")).toEqual([]);
    expect(await readRows("migration")).toEqual([
      { id: "a", big: "9223372036854775807" },
    ]);

    // A malformed source line is a conversion failure too (never auto-repaired).
    fs.writeFileSync(
      path.join(root, NS, "tables", "migration", "current.jsonl"),
      `${JSON.stringify({ id: "a", big: "12" })}\nnot json at all\n`,
    );
    const beforeMalformed = sha(storagePath(root));
    await expect(
      addColumn(
        NS,
        {
          table: "migration",
          column: {
            name: "tag",
            type: "string",
            nullable: false,
            default: "x",
          },
          policy: "materialize",
        },
        options(root),
      ),
    ).rejects.toMatchObject({ code: "CONVERSION_FAILED" });
    expect(sha(schemaPath(root))).toBe(schemaBefore);
    expect(sha(storagePath(root))).toBe(beforeMalformed);
    expect(fs.existsSync(generationDir(root))).toBe(false);
    expect(
      journals(root, "addColumn").map((journal) => journal.status),
    ).toEqual(["failed"]);
  });
});
