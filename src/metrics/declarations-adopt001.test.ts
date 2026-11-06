/**
 * ADOPT-DECLARED-001 — declaration adoption is a number, not a one-off `find`.
 *
 * The gap the row records: 0 namespaces ran the SUPA-6 `schema.json` path while
 * 949 legacy `tables/*.table.json` declarations served every real table, and
 * nothing on the scrape surface could notice the difference. These tests pin
 * the census (what is counted, and that a namespace holding both shapes is
 * counted honestly in both populations) and the two gauges that publish it.
 *
 * Also pinned: an unmeasurable store produces NO sample — never a 0, which
 * would read as "nobody adopted" when the truth is "we could not look".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  measureDeclarations,
  createDeclarationSampler,
  DECLARATION_SCAN_TTL_MS,
} from "./declarations";
import { createHttpMetrics } from "../http/metrics";

const HEALTHY = {
  status: "healthy" as const,
  providers: [],
  durationsMs: { embedding: 0, keys: 0, total: 0 },
};

let root = "";

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-adopt-declared-"));
}

function writeSchema(ns: string, tables: string[]): void {
  const dir = path.join(root, ns);
  fs.mkdirSync(dir, { recursive: true });
  const doc: Record<string, unknown> = {
    schemaVersion: 1,
    tables: Object.fromEntries(
      tables.map((table) => [
        table,
        {
          schemaVersion: 1,
          storage: { path: `tables/${table}/current.jsonl` },
          rowShape: "object",
          keyColumns: ["id"],
          columns: [{ name: "id", type: "int64", nullable: false }],
        },
      ]),
    ),
    views: {},
  };
  fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify(doc, null, 2));
}

function writeLegacy(ns: string, tables: string[]): void {
  const dir = path.join(root, ns, "tables");
  fs.mkdirSync(dir, { recursive: true });
  for (const table of tables) {
    fs.writeFileSync(
      path.join(dir, `${table}.table.json`),
      JSON.stringify({
        name: table,
        format: "jsonl-objects",
        columns: [{ name: "id", type: "integer" }],
        primary: "id",
        glob: `tables/${table}.jsonl`,
      }),
    );
  }
}

/** Read one labeled series out of a Prometheus text exposition body. */
function seriesValue(
  text: string,
  name: string,
  labels: Record<string, string>,
): number | null {
  const matcher = new RegExp(
    `^${name}\\{${Object.entries(labels)
      .map(([key, value]) => `${key}="${value}"`)
      .join(",")}\\} (\\S+)$`,
    "m",
  );
  const match = text.match(matcher);
  return match ? Number(match[1]) : null;
}

beforeEach(() => {
  root = scratchDir();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("measureDeclarations", () => {
  it("counts both declaration shapes per namespace, including namespaces holding both", async () => {
    writeSchema("alpha", ["widgets", "gadgets"]); // schema.json, 2 tables
    writeLegacy("beta", ["lanes"]); // legacy only, 1 table
    writeSchema("gamma", ["items"]); // both shapes in one namespace
    writeLegacy("gamma", ["scores", "runs"]);
    fs.mkdirSync(path.join(root, "delta"), { recursive: true }); // declares nothing

    const census = await measureDeclarations(root);

    expect(census).toEqual({
      namespaces: 4,
      namespacesWithSchemaJson: 2,
      namespacesWithLegacy: 2,
      tablesInSchemaJson: 3,
      tablesLegacy: 3,
    });
  });

  it("counts an unreadable schema.json as a namespace with the file but no readable tables", async () => {
    const dir = path.join(root, "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "schema.json"), "{ not json");

    const census = await measureDeclarations(root);
    expect(census.namespacesWithSchemaJson).toBe(1);
    expect(census.tablesInSchemaJson).toBe(0);
  });

  it("throws when the store itself cannot be read (no measurement, no fabricated zero)", async () => {
    await expect(
      measureDeclarations(path.join(root, "does-not-exist")),
    ).rejects.toThrow();
  });
});

describe("createDeclarationSampler", () => {
  it("reuses one walk inside the TTL and re-walks after it", async () => {
    writeSchema("alpha", ["widgets"]);
    let now = 1_000;
    let walks = 0;
    const sampler = createDeclarationSampler({
      namespacesPath: () => root,
      now: () => now,
      measure: async (namespacesPath) => {
        walks += 1;
        return measureDeclarations(namespacesPath);
      },
    });

    const first = await sampler.read();
    expect(first?.namespacesWithSchemaJson).toBe(1);

    writeSchema("beta", ["items"]);
    now += DECLARATION_SCAN_TTL_MS - 1;
    const cached = await sampler.read();
    expect(cached?.namespacesWithSchemaJson).toBe(1);
    expect(walks).toBe(1);

    now += 2;
    const fresh = await sampler.read();
    expect(fresh?.namespacesWithSchemaJson).toBe(2);
    expect(walks).toBe(2);
  });

  it("keeps the last real measurement when a later walk fails", async () => {
    let fail = false;
    let now = 1_000;
    const sampler = createDeclarationSampler({
      namespacesPath: () => root,
      now: () => now,
      measure: async (namespacesPath) => {
        if (fail) throw new Error("store unreadable");
        return measureDeclarations(namespacesPath);
      },
    });
    writeSchema("alpha", ["widgets"]);
    expect((await sampler.read())?.namespacesWithSchemaJson).toBe(1);

    fs.rmSync(root, { recursive: true, force: true });
    fail = true;
    now += DECLARATION_SCAN_TTL_MS + 1;
    expect((await sampler.read())?.namespacesWithSchemaJson).toBe(1);
  });
});

describe("/metrics — declaration adoption gauges", () => {
  it("publishes namespaces and tables per declaration shape", async () => {
    writeSchema("alpha", ["widgets", "gadgets"]);
    writeLegacy("beta", ["lanes"]);

    const metrics = createHttpMetrics({
      evaluateHealth: async () => HEALTHY,
      namespacesPath: root,
    });
    const text = await metrics.render();

    expect(
      seriesValue(text, "duckbrain_table_declaration_namespaces", {
        format: "schema.json",
      }),
    ).toBe(1);
    expect(
      seriesValue(text, "duckbrain_table_declaration_namespaces", {
        format: "legacy",
      }),
    ).toBe(1);
    expect(
      seriesValue(text, "duckbrain_table_declarations", { format: "schema.json" }),
    ).toBe(2);
    expect(
      seriesValue(text, "duckbrain_table_declarations", { format: "legacy" }),
    ).toBe(1);
  });

  it("follows the store: a namespace that adopts schema.json moves the number", async () => {
    writeLegacy("beta", ["lanes"]);
    let now = 1_000;
    const metrics = createHttpMetrics({
      evaluateHealth: async () => HEALTHY,
      namespacesPath: root,
      now: () => now,
    });

    let text = await metrics.render();
    expect(
      seriesValue(text, "duckbrain_table_declaration_namespaces", {
        format: "schema.json",
      }),
    ).toBe(0);
    expect(
      seriesValue(text, "duckbrain_table_declaration_namespaces", {
        format: "legacy",
      }),
    ).toBe(1);

    writeSchema("alpha", ["widgets"]);
    now += DECLARATION_SCAN_TTL_MS + 1;
    text = await metrics.render();
    expect(
      seriesValue(text, "duckbrain_table_declaration_namespaces", {
        format: "schema.json",
      }),
    ).toBe(1);
  });

  it("emits no adoption series for an embedder that declared no store", async () => {
    const metrics = createHttpMetrics({ evaluateHealth: async () => HEALTHY });
    const text = await metrics.render();
    expect(text).not.toMatch(/^duckbrain_table_declaration_namespaces\{/m);
    expect(text).not.toMatch(/^duckbrain_table_declarations\{/m);
  });
});
