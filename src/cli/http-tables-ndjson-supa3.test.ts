/**
 * DB-SUPA-3 REWORK: NDJSON insert against the REAL production app.
 *
 * The module battery (src/http/routes/tables-supa3.test.ts) mounts its own
 * hand-built express app — it used to install
 * express.text({ type: "application/x-ndjson" }) itself, so the battery was
 * green while the production app built by createHttpServer() (src/cli/http.ts)
 * only had express.json(), which never matches application/x-ndjson. Live
 * NDJSON inserts 400'd with "NDJSON body required" and the battery could not
 * see it — the exact test-only-plumbing phantom-coverage class.
 *
 * This test builds the app through createHttpServer() (the production wiring,
 * auth disabled) and drives it over a REAL socket (http.request against a
 * listening server), so the body-parser chain this file exercises is the one
 * production uses. Reverting the express.text mount in src/cli/http.ts makes
 * this file RED.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createServer, type Server } from "http";
import { createHttpServer } from "./http";
import { invalidateTableRegistry } from "../schema/table-registry";

const FIXTURE_NS = "supa3-prod-wiring";

let tmpRoot = "";
let nsDir = "";

function writeFixture(): void {
  nsDir = path.join(tmpRoot, FIXTURE_NS);
  fs.mkdirSync(path.join(nsDir, "tables"), { recursive: true });

  fs.writeFileSync(
    path.join(nsDir, "tables", "widgets.table.json"),
    JSON.stringify({
      name: "widgets",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "varchar" },
        { name: "qty", type: "double" },
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    }),
  );

  fs.writeFileSync(
    path.join(nsDir, "tables", "widgets.jsonl"),
    [JSON.stringify({ id: 1, name: "alpha", qty: 1.5 })].join("\n") + "\n",
  );
}

interface HttpResult {
  status: number;
  body: any;
  text: string;
}

/** One request against `app` over a real 127.0.0.1 socket. */
function httpRequest(
  app: ReturnType<typeof createHttpServer>,
  method: string,
  reqPath: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: reqPath,
          method,
          headers: {
            Host: "localhost",
            ...(opts.headers || {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            server.close();
            let parsed: any = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              // non-JSON body — keep the raw text
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, text: data });
          });
        },
      );
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supa3-prod-wiring-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  writeFixture();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("DB-SUPA-3: NDJSON insert over the production wiring", () => {
  it("POST application/x-ndjson through createHttpServer() inserts and reads back", async () => {
    invalidateTableRegistry(FIXTURE_NS);
    const BASE = `/api/ns/${FIXTURE_NS}/tables`;

    const post = await httpRequest(createHttpServer({ authType: "none" }), "POST", `${BASE}/widgets`, {
      headers: { "Content-Type": "application/x-ndjson" },
      body:
        JSON.stringify({ id: 5, name: "eps", qty: 2.0 }) +
        "\n" +
        JSON.stringify({ id: 6, name: "zeta", qty: 3.0 }) +
        "\n",
    });
    expect(post.status).toBe(201);
    expect(post.body).toEqual({ inserted: 2 });

    // Both new rows must be readable through the same production app.
    const read = await httpRequest(createHttpServer({ authType: "none" }), "GET", `${BASE}/widgets?id=gte.5&order=id.asc`);
    expect(read.status).toBe(200);
    expect(read.body.map((r: any) => r.id)).toEqual([5, 6]);
    expect(read.body.map((r: any) => r.name)).toEqual(["eps", "zeta"]);
  });
});
