import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess } from "child_process";
import {
  getRandomPort,
  startDuckbrainHttp,
  killProcess,
  waitForUrl,
  curl,
  DAEMON_READY_TIMEOUT_MS,
} from "./helpers";
import fs from "fs";
import path from "path";
import os from "os";
import bcrypt from "bcryptjs";

const port = getRandomPort();
let server: ChildProcess;
let scratchDir: string;
let authFile: string;

describe("HTTP Auth Integration", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-http-auth-int-"),
    );
    const authDir = path.join(scratchDir, "home", ".duckbrain");
    const namespacesPath = path.join(scratchDir, "namespaces");
    authFile = path.join(authDir, "auth.json");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(path.join(namespacesPath, "default"), { recursive: true });
    const hash = await bcrypt.hash("testpass123", 4);
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        users: [{ username: "admin", passwordHash: hash, roles: ["admin"] }],
        apiKeys: [],
      }),
    );

    server = await startDuckbrainHttp({
      port,
      authType: "basic",
      authFile,
      env: {
        HOME: path.join(scratchDir, "home"),
        DUCKBRAIN_DATA_DIR: scratchDir,
        DUCKBRAIN_NAMESPACES_PATH: namespacesPath,
      },
    });
    // INT-CI-002: 15s was occasionally insufficient for tsx compile +
    // node-duckdb native load under CI Node-22 parallel load. 30s + the
    // child's stderr tail (surfaced by waitForUrl on timeout) turns the
    // flake into a real diagnostic. INT-CI-003: 60s (shared constant) +
    // globalSetup pre-warm — the 3rd flake landed the daemon's "started"
    // line AT the 30s instant on a loaded runner.
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      DAEMON_READY_TIMEOUT_MS,
      server,
    );
    // INT-CI-003: hook timeout must exceed the 60s daemon wait or vitest
    // fails the hook BEFORE waitForUrl's cap (masking the stderr tail).
  }, 120000);

  afterAll(() => {
    killProcess(server);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("should allow /health without auth", async () => {
    const res = await curl(`http://127.0.0.1:${port}/health`);
    // GAP-030: /health answers 503 when degraded — the scratch daemon may be
    // degraded on this host, so accept both codes (body carries the signal).
    expect([200, 503]).toContain(res.status);
    const body = JSON.parse(res.body);
    // DOGFOOD-020: status may be "degraded" (embedding providers broken) —
    // the scratch daemon probes the host's real providers.
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(body.embedding).toBeDefined();
  });

  it("should reject /namespaces without auth", async () => {
    const res = await curl(`http://127.0.0.1:${port}/namespaces`);
    expect(res.status).toBe(401);
  });

  it("should reject /stats with wrong credentials", async () => {
    const res = await curl(`-u wrong:creds http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(401);
  });

  it("should reject /namespaces with wrong auth header format", async () => {
    const res = await curl(
      `-H "Authorization: Bearer sometoken" http://127.0.0.1:${port}/namespaces`,
    );
    expect(res.status).toBe(401);
  });

  it("should allow /namespaces with correct basic auth", async () => {
    const res = await curl(
      `-u admin:testpass123 http://127.0.0.1:${port}/namespaces`,
    );
    expect(res.status).toBe(200);
  });

  it("should allow /stats with correct basic auth", async () => {
    const res = await curl(
      `-u admin:testpass123 http://127.0.0.1:${port}/stats`,
    );
    expect(res.status).toBe(200);
  });
});
