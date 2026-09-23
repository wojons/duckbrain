/**
 * Regression test: /activity must attribute EVERY row to its own namespace.
 *
 * The previous implementation labelled every row with the namespace of the
 * FIRST collected file:
 *
 *   namespace: extractNamespaceFromPath(allFiles[0]) || "default"
 *
 * and then re-labelled them all again in enrichWithNamespace() via
 * `fileNsMap.values().next().value`. On the live store that meant all 50 rows
 * of the feed claimed to be in whichever namespace sorted first (measured:
 * "9router"), while 10/10 of the newest rows actually belonged to other
 * namespaces.
 *
 * This test builds two namespaces with interleaved timestamps and asserts each
 * row carries its REAL namespace, and that the feed interleaves both.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";

let server: Server;
let port: number;
let scratchDir: string;
let oldNamespacesPath: string | undefined;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(method: string, p: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: { Host: "localhost", "Content-Type": "application/json" },
      },
      (res: any) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          let body: any = data;
          try {
            body = JSON.parse(data);
          } catch {
            /* leave as text */
          }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Build a namespace whose rows carry an explicit, unique timestamp. */
function buildNamespace(
  root: string,
  ns: string,
  rows: Array<{ key: string; ts: string }>,
): void {
  const dir = path.join(root, ns, "concept", "2026-06");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(root, ns, "manifest.json"),
    JSON.stringify({
      version: "1.0",
      createdAt: "2026-06-01T00:00:00.000Z",
      partitions: ["concept/2026-06/"],
      lastUpdated: "2026-06-01T00:00:00.000Z",
    }),
    "utf-8",
  );
  const body = rows
    .map((r, i) =>
      JSON.stringify({
        id: `${ns}-${i}`,
        key: r.key,
        domain: "concept",
        timestamp: r.ts,
        author: "nsattr@test.local",
        action: "add",
        embedding_text: `${ns} row ${i}`,
        attributes: { ns },
      }),
    )
    .join("\n");
  fs.writeFileSync(path.join(dir, "current.jsonl"), body + "\n", "utf-8");
}

describe("ACTIVITY-NS-ATTR: /activity attributes each row to its own namespace", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-activity-nsattr-"),
    );
    oldNamespacesPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = scratchDir;

    // Interleaved timestamps: the newest row overall belongs to `zeta`, the
    // oldest to `alpha`. Alphabetically `alpha` sorts first — which is exactly
    // the namespace the old implementation stamped onto every row.
    buildNamespace(scratchDir, "alpha", [
      { key: "/alpha/one", ts: "2026-06-01T10:00:00.000Z" },
      { key: "/alpha/two", ts: "2026-06-01T10:00:02.000Z" },
    ]);
    buildNamespace(scratchDir, "zeta", [
      { key: "/zeta/one", ts: "2026-06-01T10:00:01.000Z" },
      { key: "/zeta/two", ts: "2026-06-01T10:00:03.000Z" },
    ]);

    const app = createHttpServer();
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") port = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (oldNamespacesPath === undefined) {
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    } else {
      process.env.DUCKBRAIN_NAMESPACES_PATH = oldNamespacesPath;
    }
    if (scratchDir) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("returns every row with its real namespace (not one namespace for all)", async () => {
    const { status, body } = await httpRequest("GET", "/activity?limit=200");

    expect(status).toBe(200);
    expect(Array.isArray(body.activities)).toBe(true);
    expect(body.activities.length).toBe(4);

    // Each row's key encodes its true namespace: /alpha/... or /zeta/...
    for (const a of body.activities) {
      const expected = String(a.key).split("/")[1];
      expect(a.namespace).toBe(expected);
    }

    // The old implementation collapsed all rows onto a single namespace.
    const distinct = new Set(body.activities.map((a: any) => a.namespace));
    expect(distinct.size).toBe(2);
    expect([...distinct].sort()).toEqual(["alpha", "zeta"]);
  });

  it("orders the merged feed newest-first across namespaces", async () => {
    const { body } = await httpRequest("GET", "/activity?limit=200");
    const ts = body.activities.map((a: any) => a.timestamp);

    expect(ts).toEqual([...ts].sort().reverse());
    // Newest row overall is zeta's; proves the merge is not namespace-batched.
    expect(body.activities[0].namespace).toBe("zeta");
    expect(body.activities[body.activities.length - 1].namespace).toBe("alpha");
  });
});
