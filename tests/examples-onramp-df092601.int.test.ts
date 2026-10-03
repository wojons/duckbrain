/**
 * DF-0926-01: examples on-ramp must actually run.
 *
 * Proves the documented example surfaces work against a real scratch daemon:
 *   1. examples/http-api/client.js executes as committed (CommonJS, no
 *      import.meta) and its payloads pass the server's own validation —
 *      every step of its main() succeeds (store → recall → search →
 *      namespaces) against the live daemon.
 *   2. The DuckBrainClient class is importable (module.exports) and
 *      behaves as documented: sends X-API-Key when given a token, and
 *      default-recall maps an exact key path onto the documented
 *      GET /api/memories/key/:key endpoint.
 *
 * The daemon is hermetic: unique port, unique temp data dir + namespaces
 * path, degraded (offline) embedding provider. Killed by explicit PID only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  startDuckbrainHttp,
  stopProcess,
  waitForUrl,
  getRandomPort,
  DAEMON_READY_TIMEOUT_MS,
} from "./helpers";

const port = getRandomPort();
let server: ChildProcess;
let scratchDir: string;
let savedDataDir: string | undefined;

describe("DF-0926-01: examples on-ramp runs against a live scratch daemon", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-examples-df-"),
    );
    fs.mkdirSync(path.join(scratchDir, "namespaces", "default"), {
      recursive: true,
    });
    savedDataDir = process.env.DUCKBRAIN_DATA_DIR;
    server = await startDuckbrainHttp({
      port,
      // REVIEW-DUCKBRAIN-006: explicit opt-out — examples/http-api/client.js
      // drives the unauthenticated local surface and sends no credentials.
      authType: "none",
      env: {
        DUCKBRAIN_DATA_DIR: scratchDir,
        DUCKBRAIN_NAMESPACES_PATH: path.join(scratchDir, "namespaces"),
      },
    });
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      DAEMON_READY_TIMEOUT_MS,
      server,
    );
  }, 120000);

  afterAll(async () => {
    await stopProcess(server);
    if (savedDataDir === undefined) {
      delete process.env.DUCKBRAIN_DATA_DIR;
    } else {
      process.env.DUCKBRAIN_DATA_DIR = savedDataDir;
    }
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("client.js runs as committed and every step of its main() succeeds", async () => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const run = promisify(execFile);

    const result = await run(
      process.execPath,
      [path.join(process.cwd(), "examples", "http-api", "client.js")],
      {
        cwd: process.cwd(),
        timeout: 60000,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          DUCKBRAIN_URL: `http://127.0.0.1:${port}`,
          DUCKBRAIN_DATA_DIR: scratchDir,
        },
      },
    );

    // main() only prints its full step list when every request returned 2xx;
    // any step failing exits 1 via the catch path.
    expect(result.stdout).toContain("DuckBrain HTTP API Example");
    expect(result.stdout).toContain("1. Storing memory...");
    expect(result.stdout).toContain("2. Recalling memory...");
    expect(result.stdout).toContain("3. Searching memories...");
    expect(result.stdout).toContain("4. Listing namespaces...");
    expect(result.stderr).not.toContain("Error:");
  }, 90000);

  it("DuckBrainClient is importable and honors the documented wire contract", async () => {
    // Import the committed CommonJS module from the test. Vitest runs tests
    // as ESM, so interop with the CJS example goes through createRequire —
    // the same mechanism any CommonJS consumer of the repo would use.
    // (createRequire anchored at <cwd>/package.json, NOT import.meta.url:
    // this file compiles under module: NodeNext into CommonJS output, where
    // the import.meta meta-property is illegal — TS1470. The repo's
    // http-e2e suite uses the same CJS-safe form.)
    const { createRequire } = await import("module");
    const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
    const { DuckBrainClient } = nodeRequire("./examples/http-api/client.js");

    expect(typeof DuckBrainClient).toBe("function");

    // Auth header contract: a token rides X-API-Key (the apikey backend's
    // documented header), not Authorization.
    const client = new DuckBrainClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token-123",
    });
    const headers = client.getHeaders();
    expect(headers["X-API-Key"]).toBe("test-token-123");
    expect(headers["Authorization"]).toBeUndefined();

    // Payload contract: remember() sends key/domain/content — the exact
    // fields POST /api/memories validates — and the write lands.
    const stored = await client.remember({
      key: "/df092601/client-contract",
      content: "wire-contract probe",
      domain: "raw_note",
    });
    expect(stored.key).toBe("/df092601/client-contract");
    expect(stored.content).toBe("wire-contract probe");

    // recall() default hits GET /api/memories/key/:key.
    const recalled = await client.recall({ key: "/df092601/client-contract" });
    expect(recalled.key).toBe("/df092601/client-contract");
    expect(recalled.content).toBe("wire-contract probe");

    // search() maps query -> the documented ?contains= parameter.
    const found = await client.search({ query: "wire-contract", limit: 10 });
    expect(Array.isArray(found.items)).toBe(true);
    expect(
      found.items.some(
        (m: { key?: string }) => m.key === "/df092601/client-contract",
      ),
    ).toBe(true);
  }, 60000);
});
