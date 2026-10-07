/**
 * DF-1003-03 Regression Tests: POST /api/memories echoes the EFFECTIVE
 * namespace in the 201 response body.
 *
 * Root cause: the write target namespace is resolved SERVER-SIDE (explicit
 * param > DUCKBRAIN_NAMESPACE > config defaultNamespace > "default" —
 * resolveNamespaceName) and a fresh box auto-creates a missing namespace
 * under the RESOLVED name (NAMESPACE-AUTOCREATE-001 default mode). Before
 * this fix the 201 body carried no namespace at all, so a caller that
 * omitted ?namespace= (or typo'd it, seeing only the log-only
 * [namespace-autocreate] WARN) had to trust its own request about where the
 * memory landed — on a fresh box it silently went to 'default' while the
 * client believed it wrote to another namespace.
 *
 * Fix: the 201 body carries `namespace` — the same value rememberTool
 * already resolves and echoes (DOGFOOD-017). Additive: no existing
 * assertion in the suite reads the exact POST response shape, so existing
 * consumers see one extra field and nothing else changes.
 *
 * Hermeticity (DB-GAP-045 / DB-GAP-058 pattern): in-process
 * createHttpServer({ authType: "none" }) with DUCKBRAIN_NAMESPACES_PATH /
 * DUCKBRAIN_CONFIG_PATH redirected to a per-file scratch root; the scratch
 * config file is rewritten per leg (config reads are lazy per request —
 * getConfig calls readFileConfig + applyEnvOverrides at call time, no
 * cache), and the previous config text + env are restored in afterAll.
 * The scratch root is outside the repo; no production namespace, no
 * network beyond 127.0.0.1. The repo-root instance config is never touched.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, Server } from "http";
import { createHttpServer } from "../../cli/http";

const SCRATCH_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-ns-echo-df100303-"),
);
const SCRATCH_NS_ROOT = path.join(SCRATCH_ROOT, "namespaces");
const SCRATCH_CONFIG_PATH = path.join(SCRATCH_ROOT, "duckbrain.config.json");

/** Pre-created so the explicit-namespace leg exercises the already-exists path. */
const PREEXISTING_NS = "df100303-preexisting";
/** Never pre-created — the autocreate leg proves the echo on the fresh-box path. */
const AUTOCREATED_NS = "df100303-autocreated";
/** The scratch config's defaultNamespace (the sticky ACTIVE namespace). */
const CFG_DEFAULT = "df100303-cfg-active";
/** Env-selected namespace (DUCKBRAIN_NAMESPACE precedence arm). */
const ENV_NS = "df100303-env";

const PREV_NS_PATH = process.env.DUCKBRAIN_NAMESPACES_PATH;
const PREV_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;
const PREV_CONFIG_TEXT = fs.existsSync(SCRATCH_CONFIG_PATH)
  ? fs.readFileSync(SCRATCH_CONFIG_PATH, "utf-8")
  : null;
const PREV_ENV_NS = process.env.DUCKBRAIN_NAMESPACE;

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(
  method: string,
  reqPath: string,
  body?: Record<string, unknown>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: reqPath,
      method,
      headers: {
        Host: "localhost",
        "Content-Type": "application/json",
        ...(payload !== undefined
          ? { "Content-Length": Buffer.byteLength(payload) }
          : {}),
      },
    };
    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function scratchNsDir(ns: string): string {
  return path.join(SCRATCH_NS_ROOT, ns);
}

function postMemory(reqPath: string, body: Record<string, unknown>) {
  return httpRequest("POST", reqPath, {
    key: "/df100303/probe",
    domain: "raw_note",
    content: "DF-1003-03 namespace-echo probe write",
    ...body,
  });
}

/**
 * Install a scratch config with (or without) a defaultNamespace, deleting the
 * sticky env override first so the file's value decides. Restored by the
 * caller (try/finally) — config reads are lazy per request, so this takes
 * effect on the next write.
 */
function useConfig(defaultNamespace: string | null): void {
  delete process.env.DUCKBRAIN_NAMESPACE;
  const raw =
    defaultNamespace === null
      ? {}
      : { defaultNamespace };
  fs.writeFileSync(SCRATCH_CONFIG_PATH, JSON.stringify(raw, null, 2));
}

beforeAll(async () => {
  fs.mkdirSync(scratchNsDir(PREEXISTING_NS), { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = SCRATCH_NS_ROOT;
  process.env.DUCKBRAIN_CONFIG_PATH = SCRATCH_CONFIG_PATH;
  delete process.env.DUCKBRAIN_NAMESPACE;
  // Start from a config WITHOUT defaultNamespace so the bare fallthrough
  // resolves to 'default' (the fresh-box shape the defect describes).
  useConfig(null);

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

afterAll(() => {
  server.close();
  if (PREV_NS_PATH === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = PREV_NS_PATH;
  if (PREV_CONFIG_PATH === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = PREV_CONFIG_PATH;
  if (PREV_ENV_NS === undefined) delete process.env.DUCKBRAIN_NAMESPACE;
  else process.env.DUCKBRAIN_NAMESPACE = PREV_ENV_NS;
  if (PREV_CONFIG_TEXT === null) {
    fs.rmSync(SCRATCH_CONFIG_PATH, { force: true });
  } else {
    fs.writeFileSync(SCRATCH_CONFIG_PATH, PREV_CONFIG_TEXT);
  }
  // Teardown of a scratch dir must never red a test: a batching git child
  // can still be writing inside the namespace dir — retry, then leave it
  // (an orphaned temp dir is harmless; a false red is not).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        100 * (attempt + 1),
      );
    }
  }
});

describe("DF-1003-03: POST /api/memories echoes the effective namespace", () => {
  it("(a) no namespace given → 201 body carries the resolved 'default' (fresh-box fallthrough)", async () => {
    const { status, body } = await postMemory("/api/memories", {});

    expect(status).toBe(201);
    // THE fix: the caller omitted the namespace; the body says where it went.
    expect(body.namespace).toBe("default");
    // True fresh-box shape: the scratch root has no 'default' dir, so THIS
    // write auto-created it — the echo and the autocreate marker agree.
    expect(body.namespace_autocreated).toBe(true);
    expect(fs.existsSync(scratchNsDir("default"))).toBe(true);
  });

  it("(b) explicitly named namespace → 201 body echoes the SAME namespace (no behavior change)", async () => {
    const { status, body } = await postMemory(
      `/api/memories?namespace=${PREEXISTING_NS}`,
      {},
    );

    expect(status).toBe(201);
    expect(body.namespace).toBe(PREEXISTING_NS);
    expect(body.namespace_autocreated).toBeUndefined();
  });

  it("(c) config defaultNamespace (sticky active) wins when the arg is omitted — the echo shows it", async () => {
    try {
      useConfig(CFG_DEFAULT);

      const { status, body } = await postMemory("/api/memories", {});

      expect(status).toBe(201);
      // Not 'default': the config's active namespace is where it landed.
      expect(body.namespace).toBe(CFG_DEFAULT);
    } finally {
      useConfig(null);
    }
  });

  it("(d) DUCKBRAIN_NAMESPACE env wins when the arg is omitted — the echo shows it", async () => {
    try {
      useConfig(CFG_DEFAULT);
      process.env.DUCKBRAIN_NAMESPACE = ENV_NS;

      const { status, body } = await postMemory("/api/memories", {});

      expect(status).toBe(201);
      // Precedence: explicit param > DUCKBRAIN_NAMESPACE > config > default.
      expect(body.namespace).toBe(ENV_NS);
    } finally {
      delete process.env.DUCKBRAIN_NAMESPACE;
      useConfig(null);
    }
  });

  it("(e) fresh-box autocreate path: the echo names the namespace this write CREATED", async () => {
    expect(fs.existsSync(scratchNsDir(AUTOCREATED_NS))).toBe(false);

    const { status, body } = await postMemory(
      `/api/memories?namespace=${AUTOCREATED_NS}`,
      {},
    );

    expect(status).toBe(201);
    expect(body.namespace).toBe(AUTOCREATED_NS);
    // Both markers agree: the write created the namespace named in the echo.
    expect(body.namespace_autocreated).toBe(true);
    expect(fs.existsSync(scratchNsDir(AUTOCREATED_NS))).toBe(true);
  });
});
