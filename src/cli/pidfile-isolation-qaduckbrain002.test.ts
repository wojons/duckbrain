/**
 * QA-DUCKBRAIN-002 regression: pidfile owner-isolation + hermetic helper daemons.
 *
 * The daemon's pidfile used to live at a FIXED, uid-shared temp path
 * (`os.tmpdir()/duckbrain-http-<port|socket>.pid`), so on a multi-uid host a
 * foreign-owned leftover blocked pidfile bookkeeping, and every test-spawned
 * daemon shared both that path and the cwd-relative production namespace
 * root. These tests pin the fix:
 *
 *   1. `httpPidFilePath` precedence: explicit `dir` arg > DUCKBRAIN_DATA_DIR >
 *      per-uid temp dir `os.tmpdir()/duckbrain-<uid>` — never the bare shared
 *      tmp path when no override is set.
 *   2. A spawned daemon whose DUCKBRAIN_DATA_DIR is a REGULAR FILE (ENOTDIR
 *      for every uid, root included) still binds, answers /health, logs the
 *      best-effort pidfile warning, and exits 0 on SIGTERM.
 *   3. Two daemons started through tests/helpers.ts startDuckbrainHttp get
 *      DISTINCT temp data dirs / namespace roots / pidfiles (hermetic; no
 *      :3000, no prod namespaces).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn } from "child_process";
import { httpPidFilePath } from "../utils/pidfile";
import {
  startDuckbrainHttp,
  stopProcess,
  cleanupDaemonDirs,
  waitForUrl,
  getRandomPort,
  DAEMON_READY_TIMEOUT_MS,
} from "../../tests/helpers";
import {
  findFreePort,
  waitForHealth,
  waitForClose,
  assertDaemonIsOurs,
  createSentinelNamespace,
  removeTempDirSafely,
} from "../testing/race-safe-daemon";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");

const uid =
  typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
const perUidDir = path.join(os.tmpdir(), `duckbrain-${uid}`);

describe("httpPidFilePath owner isolation (QA-DUCKBRAIN-002)", () => {
  let savedDataDir: string | undefined;

  beforeEach(() => {
    savedDataDir = process.env.DUCKBRAIN_DATA_DIR;
    delete process.env.DUCKBRAIN_DATA_DIR;
  });

  afterEach(() => {
    if (savedDataDir === undefined) {
      delete process.env.DUCKBRAIN_DATA_DIR;
    } else {
      process.env.DUCKBRAIN_DATA_DIR = savedDataDir;
    }
  });

  it("with DUCKBRAIN_DATA_DIR unset, returns a per-uid path — never the legacy shared tmp path", () => {
    const result = httpPidFilePath(4321);
    // Inside the per-uid directory that names the runtime uid...
    expect(path.dirname(result)).toBe(perUidDir);
    expect(path.dirname(result)).toContain(`duckbrain-${uid}`);
    // ...and NOT the legacy fixed path in the bare shared temp dir, which a
    // different uid can own.
    expect(result).not.toBe(path.join(os.tmpdir(), "duckbrain-http-4321.pid"));
    expect(result).toBe(path.join(perUidDir, "duckbrain-http-4321.pid"));
  });

  it("DUCKBRAIN_DATA_DIR beats the per-uid fallback", () => {
    process.env.DUCKBRAIN_DATA_DIR = path.join(os.tmpdir(), "qa002-env-dir");
    expect(httpPidFilePath(4321)).toBe(
      path.join(os.tmpdir(), "qa002-env-dir", "duckbrain-http-4321.pid"),
    );
  });

  it("explicit dir arg wins when no env is set", () => {
    const explicit = path.join(os.tmpdir(), "qa002-explicit");
    expect(httpPidFilePath(4321, undefined, explicit)).toBe(
      path.join(explicit, "duckbrain-http-4321.pid"),
    );
  });

  it("explicit dir arg beats DUCKBRAIN_DATA_DIR", () => {
    process.env.DUCKBRAIN_DATA_DIR = path.join(os.tmpdir(), "qa002-env-dir");
    const explicit = path.join(os.tmpdir(), "qa002-explicit");
    expect(httpPidFilePath(4321, undefined, explicit)).toBe(
      path.join(explicit, "duckbrain-http-4321.pid"),
    );
  });

  it("filename scheme is unchanged for sockets under the per-uid fallback", () => {
    expect(httpPidFilePath(3000, "/tmp/duckbrain.sock")).toBe(
      path.join(perUidDir, "duckbrain-http-duckbrain.sock.pid"),
    );
  });
});

describe("spawned daemon with an ENOTDIR pidfile dir (QA-DUCKBRAIN-002 AC1)", () => {
  it("still binds, answers /health, warns about the pidfile, exits 0 on SIGTERM", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-qa002-"));
    // Point DUCKBRAIN_DATA_DIR at a REGULAR FILE: the pidfile path is
    // `<file>/duckbrain-http-<port>.pid` and the write fails with ENOTDIR
    // for every uid (a chmod refusal would be silently bypassed by root).
    const blockedDataDir = path.join(scratch, "not-a-directory");
    fs.writeFileSync(blockedDataDir, "");
    const nsPath = path.join(scratch, "namespaces");
    fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
    const sentinel = createSentinelNamespace(nsPath);

    const port = await findFreePort();
    const child = spawn(
      process.execPath,
      [BIN_PATH, "http", `--port=${port}`],
      {
        env: {
          ...process.env,
          DUCKBRAIN_DATA_DIR: blockedDataDir,
          DUCKBRAIN_NAMESPACES_PATH: nsPath,
          DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
          DUCKBRAIN_EMBEDDING_API_KEY: "",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    try {
      await waitForHealth(port, 60000, child);
      await assertDaemonIsOurs({
        port,
        child,
        nsPath,
        dataDir: blockedDataDir,
        sentinel,
      });
      expect(stderr).toContain("Could not write pidfile");
    } finally {
      child.kill("SIGTERM");
    }
    const code = await waitForClose(child);
    expect(code).toBe(0);

    await removeTempDirSafely(scratch);
  }, 120_000);
});

describe("integration helper daemon isolation (QA-DUCKBRAIN-002 AC3)", () => {
  let savedDataDir: string | undefined;
  let savedNsPath: string | undefined;

  beforeEach(() => {
    // Force the helper's default path regardless of the ambient env.
    savedDataDir = process.env.DUCKBRAIN_DATA_DIR;
    savedNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    delete process.env.DUCKBRAIN_DATA_DIR;
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DUCKBRAIN_DATA_DIR;
    else process.env.DUCKBRAIN_DATA_DIR = savedDataDir;
    if (savedNsPath === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    else process.env.DUCKBRAIN_NAMESPACES_PATH = savedNsPath;
  });

  it("two helper daemons get distinct data dirs, namespace roots and pidfiles", async () => {
    const port1 = getRandomPort();
    const port2 = getRandomPort();
    const child1 = await startDuckbrainHttp({ port: port1 });
    const child2 = await startDuckbrainHttp({ port: port2 });
    try {
      await waitForUrl(
        `http://127.0.0.1:${port1}/health`,
        DAEMON_READY_TIMEOUT_MS,
        child1,
      );
      await waitForUrl(
        `http://127.0.0.1:${port2}/health`,
        DAEMON_READY_TIMEOUT_MS,
        child2,
      );

      // Each daemon got its OWN temp dirs (hermetic-by-default).
      expect(child1.dataDir).toBeDefined();
      expect(child2.dataDir).toBeDefined();
      expect(child1.dataDir).not.toBe(child2.dataDir);
      expect(child1.namespacesPath).toBeDefined();
      expect(child1.namespacesPath).not.toBe(child2.namespacesPath);

      // And each wrote its pidfile under its own dir — no shared path.
      const pid1 = path.join(child1.dataDir!, `duckbrain-http-${port1}.pid`);
      const pid2 = path.join(child2.dataDir!, `duckbrain-http-${port2}.pid`);
      expect(fs.existsSync(pid1)).toBe(true);
      expect(fs.existsSync(pid2)).toBe(true);
      expect(pid1).not.toBe(pid2);
    } finally {
      await stopProcess(child1);
      await stopProcess(child2);
      cleanupDaemonDirs(child1);
      cleanupDaemonDirs(child2);
    }

    // cleanupDaemonDirs removed exactly the helper-created roots.
    expect(fs.existsSync(child1.dataDir!)).toBe(false);
    expect(fs.existsSync(child2.dataDir!)).toBe(false);
  }, 180_000);
});
