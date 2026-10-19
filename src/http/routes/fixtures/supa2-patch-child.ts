/**
 * Child-process worker for the DB-SUPA-2 cross-process PATCH test.
 *
 * Spawned by `tables-supa2.test.ts` as:
 *
 *   node --import tsx <this file> <root> <ns> <table> <column> <value> \
 *        <gateFile> <readyFile>
 *
 * It boots a REAL DuckBrain HTTP server on an ephemeral loopback port in its
 * own OS process, announces readiness by writing `readyFile`, waits for the
 * parent to create `gateFile`, and then issues ONE `PATCH /api/ns/:ns/tables/
 * :table?pk=eq.1` against itself. The gate is what makes the two children
 * genuinely concurrent instead of merely sequential: both fire in the same
 * instant and must be serialized by the namespace write lock (a cross-process
 * file lock), not by the order a single test process happened to call them.
 *
 * stdout carries one machine-readable line:
 *   RESULT {"pid":…,"column":…,"value":…,"status":200,"body":"{\"updated\":1}"}
 *
 * Exit codes: 0 = one PATCH attempt completed (status decides the outcome),
 * 1 = unexpected error, 2 = bad usage, 3 = gate never opened.
 */

import fs from "fs";
import http from "http";
import { createHttpServer } from "../../../cli/http";

const [root, ns, table, column, rawValue, gateFile, readyFile] =
  process.argv.slice(2);

const GATE_TIMEOUT_MS = 30_000;

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  if (
    !root ||
    !ns ||
    !table ||
    !column ||
    !rawValue ||
    !gateFile ||
    !readyFile
  ) {
    fail(
      2,
      "usage: supa2-patch-child <root> <ns> <table> <column> <value> <gate> <ready>",
    );
  }

  // The route resolves namespace storage from config, and config applies this
  // override at call time — set it before the first route call.
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
  process.env.DUCKBRAIN_CONFIG_PATH ??= root + "/duckbrain.config.json";

  const server = http.createServer(createHttpServer({ authType: "none" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (port === 0) fail(1, "child server did not bind a port");

  fs.writeFileSync(readyFile, String(process.pid), "utf-8");

  const deadline = Date.now() + GATE_TIMEOUT_MS;
  while (!fs.existsSync(gateFile)) {
    if (Date.now() > deadline) fail(3, "gate-timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const body = JSON.stringify({ [column]: Number(rawValue) });
  const result = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/ns/${ns}/tables/${table}?pk=eq.1`,
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf-8");
          response.on("data", (chunk: string) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body: text }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    },
  );

  console.log(
    `RESULT ${JSON.stringify({
      pid: process.pid,
      column,
      value: Number(rawValue),
      ...result,
    })}`,
  );

  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // The mutation's 2xx means data + accepted change record are already on
  // disk (recordTableMutationAudit awaits the writer flush), so the process
  // may exit without waiting for the debounced git commit.
  process.exit(0);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
