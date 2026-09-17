/**
 * DB-SUPA-6 AC-6 — serializer fencing and concurrency.
 *
 * The DDL coordinator fences the namespace with the EXISTING cross-process
 * write lock. While it holds that lock, a writer in another process (here: the
 * test process, which is a genuinely different process from the DDL child)
 * receives the defined retryable `SERIALIZER_LOCKED` result and writes neither
 * the source file nor the replacement generation. After the migration, a new
 * write validates against exactly ONE schema version.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { addColumn, createTable, type DdlCallOptions } from "./ddl";
import { getNamespaceWriter } from "./namespaceWriter";
import { loadNamespaceSchema } from "./schemaRegistry";
import {
  getTable,
  invalidateTableRegistry,
  namespaceDir,
} from "../schema/table-registry";
import { buildSelectPlan, executeSelectPlan } from "../duckdb/table-store";
import type { AuthPrincipal } from "../auth/middleware";

const NS = "supa6-concurrency";
const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const roots: string[] = [];
const children: ChildProcess[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-concurrency-"));
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

const storagePath = (root: string): string =>
  path.join(root, NS, "tables", "migration", "current.jsonl");
const generationDir = (root: string): string =>
  path.join(root, NS, "tables", "migration", "generations");

function sha(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

async function seed(root: string): Promise<void> {
  fs.mkdirSync(path.dirname(storagePath(root)), { recursive: true });
  fs.writeFileSync(
    storagePath(root),
    `${JSON.stringify({ id: "a", big: "12" })}\n`,
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

/** A child process that holds the DDL fence until the parent releases it. */
function writeChildScript(root: string): string {
  const ddlModule = JSON.stringify(path.resolve(__dirname, "ddl.ts"));
  const script = [
    `import fs from "fs";`,
    `import { addColumn } from ${ddlModule};`,
    `const spec = JSON.parse(process.argv[2]);`,
    `void (async () => {`,
    `  const result = await addColumn(`,
    `    spec.ns,`,
    `    { table: spec.table, column: spec.column, policy: spec.policy },`,
    `    {`,
    `      namespacesPath: spec.root,`,
    `      scheduleCommit: () => undefined,`,
    `      onFenceAcquired: async () => {`,
    `        fs.writeFileSync(spec.readyFile, "ready");`,
    `        while (!fs.existsSync(spec.releaseFile))`,
    `          await new Promise((resolve) => setTimeout(resolve, 20));`,
    `      },`,
    `    },`,
    `  );`,
    `  console.log("OK " + JSON.stringify(result));`,
    `})().catch((error) => {`,
    `  const failure = error as { code?: string; message?: string };`,
    `  console.error("CHILD_ERROR " + (failure.code ?? "") + " " + (failure.message ?? String(error)));`,
    `  process.exit(1);`,
    `});`,
    ``,
  ].join("\n");
  const file = path.join(root, "ddl-fence-child.ts");
  fs.writeFileSync(file, script);
  return file;
}

function spawnChild(script: string, spec: unknown): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", script, JSON.stringify(spec)],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  return child;
}

function waitForFile(file: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out waiting for ${file}`));
      }
    }, 20);
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit: ${output}`));
    }, 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function readRows(): Promise<Record<string, unknown>[]> {
  invalidateTableRegistry(NS);
  const declaration = getTable(NS, "migration");
  const plan = buildSelectPlan(declaration, { limit: 100 });
  const result = await executeSelectPlan(namespaceDir(NS), declaration, plan);
  return result.rows;
}

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  children.length = 0;
  invalidateTableRegistry(NS);
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

describe("SUPA-6 DDL fencing and concurrency", () => {
  it("DDL fence excludes cross-process write", async () => {
    const root = makeRoot();
    await seed(root);
    const script = writeChildScript(root);
    const readyFile = path.join(root, "fence-ready");
    const releaseFile = path.join(root, "fence-release");
    const storageBefore = sha(storagePath(root));

    const child = spawnChild(script, {
      root,
      ns: NS,
      table: "migration",
      column: {
        name: "tag",
        type: "string",
        nullable: false,
        default: "promoted",
      },
      policy: "materialize",
      readyFile,
      releaseFile,
    });
    // The child is now in its drain/fence phase, holding the namespace lock.
    await waitForFile(readyFile);
    expect(fs.existsSync(generationDir(root))).toBe(false);

    // A write from THIS process must not touch source or replacement data.
    const writer = getNamespaceWriter(NS, {
      namespacesPath: root,
      scheduleCommit: () => undefined,
    });
    const blocked = await writer.enqueue({
      ns: NS,
      table: "migration",
      op: "insert",
      record: { id: "blocked", big: "1" },
      principal: ADMIN,
      targetPath: "tables/migration/current.jsonl",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected the fenced write to be refused");
    expect(blocked.code).toBe("SERIALIZER_LOCKED");
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(sha(storagePath(root))).toBe(storageBefore);
    expect(fs.readFileSync(storagePath(root), "utf-8")).not.toMatch(/blocked/);
    expect(fs.existsSync(generationDir(root))).toBe(false);

    // Release the fence: the migration completes on its own.
    fs.writeFileSync(releaseFile, "go");
    const exited = await waitForExit(child);
    expect(exited.code).toBe(0);
    expect(exited.output).toMatch(/^OK /m);
    const schema = loadNamespaceSchema(NS, { namespacesPath: root }).document;
    const switched = schema.tables.migration!;
    expect(switched.schemaVersion).toBe(2);
    expect(switched.storage.path).toMatch(/generations\/addColumn-/);
    // The blocked write never landed anywhere.
    expect(fs.readFileSync(storagePath(root), "utf-8")).not.toMatch(/blocked/);
    expect(
      fs.readFileSync(path.join(root, NS, switched.storage.path), "utf-8"),
    ).not.toMatch(/blocked/);
    expect(await readRows()).toEqual([{ id: "a", big: "12", tag: "promoted" }]);
  });

  it("post-migration write uses new schema only", async () => {
    const root = makeRoot();
    await seed(root);
    const storageBefore = sha(storagePath(root));

    const migrated = await addColumn(
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
    expect(migrated.ok).toBe(true);
    const generation = path.join(root, NS, migrated.generation!.path);
    const generationBefore = sha(generation);

    // A new write validates against the NEW declaration only: the required
    // column is materialized into the generation that schema.json publishes.
    const writer = getNamespaceWriter(NS, {
      namespacesPath: root,
      scheduleCommit: () => undefined,
    });
    const written = await writer.enqueue({
      ns: NS,
      table: "migration",
      op: "insert",
      record: { id: "new", big: "7", tag: "promoted" },
      principal: ADMIN,
      targetPath: migrated.generation!.path,
    });
    expect(written.ok).toBe(true);
    // The row landed in the NEW generation, exactly once, with the v2 shape.
    const lines = fs
      .readFileSync(generation, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual({
      id: "new",
      big: "7",
      tag: "promoted",
    });
    // The old generation is untouched: no new row, byte-identical content.
    expect(sha(storagePath(root))).toBe(storageBefore);

    // A write that violates the new schema is refused and writes nothing.
    const missingRequired = await writer.enqueue({
      ns: NS,
      table: "migration",
      op: "insert",
      record: { id: "bad", tag: "promoted" },
      principal: ADMIN,
      targetPath: migrated.generation!.path,
    });
    expect(missingRequired.ok).toBe(false);
    expect(sha(generation)).not.toBe(generationBefore); // the valid write above
    expect(
      fs
        .readFileSync(generation, "utf-8")
        .split("\n")
        .filter((line) => line.trim()),
    ).toHaveLength(2);
    expect(await readRows()).toEqual([
      { id: "a", big: "12", tag: "promoted" },
      { id: "new", big: "7", tag: "promoted" },
    ]);
    // Exactly one declared version is live for the table.
    expect(
      loadNamespaceSchema(NS, { namespacesPath: root }).document.tables
        .migration?.schemaVersion,
    ).toBe(2);
  });
});
