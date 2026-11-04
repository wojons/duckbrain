/**
 * DB-SUPA-9: GET primary-key alias filter regression tests.
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

const FIXTURE_NS = "supa9-pkfilter";

let tmpRoot = "";

function writeFixture(): void {
  const tablesDir = path.join(tmpRoot, FIXTURE_NS, "tables");
  fs.mkdirSync(tablesDir, { recursive: true });

  fs.writeFileSync(
    path.join(tablesDir, "widgets.table.json"),
    JSON.stringify({
      name: "widgets",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "varchar" },
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    }),
  );
  fs.writeFileSync(
    path.join(tablesDir, "widgets.jsonl"),
    [
      JSON.stringify({ id: 1, name: "alpha" }),
      JSON.stringify({ id: 2, name: "beta" }),
      JSON.stringify({ id: 3, name: "gamma" }),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(tablesDir, "unkeyed.table.json"),
    JSON.stringify({
      name: "unkeyed",
      format: "jsonl-objects",
      columns: [{ name: "id", type: "varchar" }],
      primary: null,
      glob: "tables/unkeyed.jsonl",
    }),
  );
  fs.writeFileSync(path.join(tablesDir, "unkeyed.jsonl"), '{"id":"x"}\n');
}

interface HttpResult {
  status: number;
  body: any;
}

function httpRequest(
  app: ReturnType<typeof createHttpServer>,
  reqPath: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const req = http.request(
        { hostname: "127.0.0.1", port, path: reqPath, method: "GET", headers: { Host: "localhost" } },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            server.close();
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
            });
          });
        },
      );
      req.on("error", (error) => {
        server.close();
        reject(error);
      });
      req.end();
    });
  });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supa9-pkfilter-test-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, "duckbrain.config.json");
  writeFixture();
});

afterAll(async () => {
  await removeTempDirSafely(tmpRoot);
});

describe("DB-SUPA-9: GET pk filter", () => {
  const base = `/api/ns/${FIXTURE_NS}/tables`;

  beforeEach(() => {
    invalidateTableRegistry(FIXTURE_NS);
  });

  it("filters GET to the matching primary-key row", async () => {
    const res = await httpRequest(createHttpServer({ authType: "none" }), `${base}/widgets?pk=eq.2`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 2, name: "beta" }]);
  });

  it("returns no rows when the primary-key value does not match", async () => {
    const res = await httpRequest(createHttpServer({ authType: "none" }), `${base}/widgets?pk=eq.9`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects non-equality pk operators", async () => {
    const res = await httpRequest(createHttpServer({ authType: "none" }), `${base}/widgets?pk=gte.1`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("keeps ordinary primary-column filters working", async () => {
    const res = await httpRequest(createHttpServer({ authType: "none" }), `${base}/widgets?id=eq.2`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 2, name: "beta" }]);
  });

  it("rejects unknown filter columns with an operator", async () => {
    const res = await httpRequest(createHttpServer({ authType: "none" }), `${base}/widgets?bogus=eq.9`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects pk filters for a table without a declared primary key", async () => {
    const res = await httpRequest(createHttpServer({ authType: "none" }), `${base}/unkeyed?pk=eq.x`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.error).toContain("declares no primary key");
  });
});
