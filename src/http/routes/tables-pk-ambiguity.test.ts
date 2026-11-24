/**
 * REST-PK-UNIQUENESS-001 AC3 — a pk-addressed mutation touches EXACTLY ONE
 * row, and refuses with 409 `PK_AMBIGUOUS` when the predicate would match
 * more than one.
 *
 * AC1 (tables-write-uniqueness.test.ts) keeps duplicate primary keys out
 * through the API. But a table whose DATA predates that gate can still hold
 * two physical rows with the same pk ("legacy data"), and the
 * rewrite-every-match PATCH/DELETE path would fan out — `{updated: 2}` is a
 * silent corruption, never an acceptable answer. These tests pin the
 * ambiguity refusal by writing the duplicate rows DIRECTLY into the JSONL
 * fixture (bypassing the insert gate) and driving the real HTTP server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createServer, type Server } from "http";
import { createHttpServer } from "../../cli/http";
import { invalidateTableRegistry } from "../../schema/table-registry";
import { removeTempDirSafely } from "../../testing/race-safe-daemon";

const FIXTURE_NS = "pk-ambiguity";

let tmpRoot = "";

function writeTableDeclaration(name: string, glob: string): void {
  const tablesDir = path.join(tmpRoot, FIXTURE_NS, "tables");
  fs.mkdirSync(tablesDir, { recursive: true });
  fs.writeFileSync(
    path.join(tablesDir, `${name}.table.json`),
    JSON.stringify({
      name,
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "varchar" },
      ],
      primary: "id",
      glob,
    }),
  );
}

function writeFixture(): void {
  // "solo": clean table — the single-row positive control.
  writeTableDeclaration("solo", "tables/solo.jsonl");
  fs.writeFileSync(
    path.join(tmpRoot, FIXTURE_NS, "tables", "solo.jsonl"),
    [
      JSON.stringify({ id: 1, name: "one" }),
      JSON.stringify({ id: 2, name: "two" }),
    ].join("\n") + "\n",
  );
  // "dupe": LEGACY data — two physical rows sharing pk 1, written straight
  // to the JSONL so the AC1 insert gate never saw them.
  writeTableDeclaration("dupe", "tables/dupe.jsonl");
  fs.writeFileSync(
    path.join(tmpRoot, FIXTURE_NS, "tables", "dupe.jsonl"),
    [
      JSON.stringify({ id: 1, name: "legacy-a" }),
      JSON.stringify({ id: 1, name: "legacy-b" }),
    ].join("\n") + "\n",
  );
}

interface HttpResult {
  status: number;
  body: any;
}

/** One request against a fresh app instance (no long-lived listener). */
function request(
  app: ReturnType<typeof createHttpServer>,
  method: string,
  reqPath: string,
  payload?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body =
      payload === undefined ? "" : JSON.stringify(payload as object);
    const headers: Record<string, string | number> = { Host: "localhost" };
    if (body.length > 0) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const req = http.request(
        { hostname: "127.0.0.1", port, path: reqPath, method, headers },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            server.close();
            resolve({
              status: res.statusCode ?? 0,
              body: text.length > 0 ? JSON.parse(text) : null,
            });
          });
        },
      );
      req.on("error", (error) => {
        server.close();
        reject(error);
      });
      if (body.length > 0) req.write(body);
      req.end();
    });
  });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pk-ambiguity-test-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, "duckbrain.config.json");
  writeFixture();
});

afterAll(async () => {
  await removeTempDirSafely(tmpRoot);
});

describe("REST-PK-UNIQUENESS-001 AC3: pk mutations touch exactly one row", () => {
  const solo = `/api/ns/${FIXTURE_NS}/tables/solo`;
  const dupe = `/api/ns/${FIXTURE_NS}/tables/dupe`;

  beforeEach(() => {
    invalidateTableRegistry(FIXTURE_NS);
  });

  it("PATCH ?pk=eq.<v> on a clean table updates EXACTLY ONE row", async () => {
    const app = createHttpServer({ authType: "none" });
    const res = await request(app, "PATCH", `${solo}?pk=eq.1`, {
      name: "one-patched",
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const rows = await request(app, "GET", `${solo}?pk=eq.1`);
    expect(rows.body).toHaveLength(1);
    expect(rows.body[0].name).toBe("one-patched");
    // The untouched neighbour proves the predicate was scoped to one row.
    const other = await request(app, "GET", `${solo}?pk=eq.2`);
    expect(other.body[0].name).toBe("two");
  });

  it("PATCH whose predicate matches >1 row refuses 409 PK_AMBIGUOUS — never {updated:2}", async () => {
    const app = createHttpServer({ authType: "none" });
    const res = await request(app, "PATCH", `${dupe}?pk=eq.1`, {
      name: "fan-out",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PK_AMBIGUOUS");
    expect(res.body.error).toContain("more than one row");

    // NEITHER legacy row was mutated: the refusal is pre-write, all-or-nothing.
    const rows = await request(app, "GET", `${dupe}?pk=eq.1`);
    expect(rows.body).toHaveLength(2);
    expect(rows.body.map((r: any) => r.name).sort()).toEqual([
      "legacy-a",
      "legacy-b",
    ]);
  });

  it("DELETE whose predicate matches >1 row refuses 409 PK_AMBIGUOUS", async () => {
    const app = createHttpServer({ authType: "none" });
    const res = await request(app, "DELETE", `${dupe}?pk=eq.1`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PK_AMBIGUOUS");

    // Both rows survive the refusal.
    const rows = await request(app, "GET", `${dupe}?pk=eq.1`);
    expect(rows.body).toHaveLength(2);

    // A unique pk on the same table still deletes exactly one row.
    await request(app, "POST", dupe, { id: 9, name: "fresh" });
    const del = await request(app, "DELETE", `${dupe}?pk=eq.9`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(1);
    const gone = await request(app, "GET", `${dupe}?pk=eq.9`);
    expect(gone.body).toHaveLength(0);
  });

  it("PUT /:table/:pk whose pk matches >1 row refuses 409 PK_AMBIGUOUS — never replaces both", async () => {
    const app = createHttpServer({ authType: "none" });
    const res = await request(app, "PUT", `${dupe}/1`, { name: "replaced" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PK_AMBIGUOUS");
    expect(res.body.error).toContain("more than one row");

    // NEITHER legacy row was replaced: the refusal is pre-write, all-or-nothing.
    const rows = await request(app, "GET", `${dupe}?pk=eq.1`);
    expect(rows.body).toHaveLength(2);
    expect(rows.body.map((r: any) => r.name).sort()).toEqual([
      "legacy-a",
      "legacy-b",
    ]);
  });

  it("PUT control: a unique pk still upserts exactly one row", async () => {
    const app = createHttpServer({ authType: "none" });
    // Replace branch: one existing row, one row after.
    const updated = await request(app, "PUT", `${solo}/1`, {
      name: "one-replaced",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.outcome).toBe("updated");
    const rows = await request(app, "GET", `${solo}?pk=eq.1`);
    expect(rows.body).toHaveLength(1);
    expect(rows.body[0].name).toBe("one-replaced");

    // Insert branch: fresh pk appends exactly one row.
    const inserted = await request(app, "PUT", `${solo}/3`, { name: "three" });
    expect(inserted.status).toBe(201);
    expect(inserted.body.outcome).toBe("inserted");
    const fresh = await request(app, "GET", `${solo}?pk=eq.3`);
    expect(fresh.body).toHaveLength(1);
    expect(fresh.body[0].name).toBe("three");
  });
});
