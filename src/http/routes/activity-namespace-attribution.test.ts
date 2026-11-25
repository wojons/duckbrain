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
import { flushReadLedgerForTests } from "../readLedger";
import { createServer, Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";

let server: Server;
let port: number;
let scratchDir: string;
let oldNamespacesPath: string | undefined;

/**
 * INT-CI-041 — the scratch root has a WRITER that outlives `server.close()`.
 *
 * `createHttpServer()` mounts the OBS-DUCKBRAIN-001 read ledger (src/cli/http.ts
 * → src/http/middleware/readLedger.ts) on the namespace root this suite points
 * at via DUCKBRAIN_NAMESPACES_PATH. The middleware queues its append on the
 * response's `finish` event, and the append itself is a chain of async fs calls
 * (mkdir, stat, appendFile) — so the client can have its JSON body, the test
 * can have finished asserting, and `server.close()` can have resolved while
 * `<scratch>/.duckbrain-audit/reads.jsonl` is still being created. An immediate
 * recursive rmdir then races that write and dies with
 *
 *   ENOTEMPTY: directory not empty, rmdir <scratch>/.duckbrain-audit
 *
 * (measured under full parallel load: gitreins tier-1 run 2222cfb5 plus five
 * leaked /mnt/ssd/tmp/duckbrain-activity-nsattr-* dirs, each containing exactly
 * `.duckbrain-audit/reads.jsonl` and nothing else). A teardown-only failure
 * reds the whole CI job while every assertion passed, and the leaked dir poisons
 * later tooling.
 *
 * Two layers, both cheap:
 *   1. `await flushReadLedgerForTests()` — the ledger exposes its serialized
 *      append tail as a test seam, so we drain every queued row instead of
 *      guessing when it landed.
 *   2. `rmScratchDir()` — retry-with-backoff on the transient codes, so even an
 *      append queued after the flush (a straggler) cannot fail the teardown.
 */
const TEARDOWN_RETRY_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);
const TEARDOWN_MAX_ATTEMPTS = 10;

/** Remove `dir` recursively, tolerating a writer that is still settling. */
async function rmScratchDir(dir: string): Promise<void> {
  let delayMs = 10;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= TEARDOWN_MAX_ATTEMPTS ||
        code === undefined ||
        !TEARDOWN_RETRY_CODES.has(code)
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 500);
    }
  }
}

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

    const app = createHttpServer({ authType: "none" });
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
    // INT-CI-041: `server.close()` only ends the sockets — it does not wait for
    // the read-ledger append queued by the /activity GET to finish writing, so
    // drain that writer before the scratch root is removed (see the block
    // comment above rmScratchDir for the measured failure).
    await flushReadLedgerForTests();
    if (oldNamespacesPath === undefined) {
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    } else {
      process.env.DUCKBRAIN_NAMESPACES_PATH = oldNamespacesPath;
    }
    if (scratchDir) {
      await rmScratchDir(scratchDir);
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
