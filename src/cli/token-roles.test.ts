/**
 * TOKEN-ROLES-001 regression tests: `duckbrain token --role=<r>` mints
 * SCOPED tokens instead of always hardcoding roles ["admin"].
 *
 * SUPA-4 role enforcement already works server-side (src/auth/roles.ts +
 * src/auth/middleware.ts: admin / writer / analyst / uploader, with a
 * missing roles field defaulting to admin for pre-SUPA-4 back-compat), but
 * tokenCommand hardcoded `roles: ["admin"]` on every minted entry — the only
 * way to get a scoped token was to hand-edit the auth store.
 *
 * These tests pin the CLI fix:
 *
 *  1. --role=<r> (equals form) is repeatable: --role=writer --role=analyst
 *     stores roles ["writer","analyst"] with no admin.
 *  2. --role <r> (space form) is accepted: --role analyst stores
 *     ["analyst"].
 *  3. An unknown role (--role=superadmin) is a FATAL error: nonzero exit,
 *     clear message, and nothing written to the auth store.
 *  4. No --role keeps the historical default ["admin"] (back-compat).
 *  5. Repeated identical roles are deduped.
 *
 * GAP-033 load hygiene: every contract above is flag-parsing + auth-store
 * semantics that never depend on the process boundary, but the original
 * tests each spawned the real CLI (node bin/duckbrain.js → tsx, ~2s boot
 * per spawn) — 5 tsx-weighted subprocess spawns per suite run for behavior
 * that is fully observable in-process. The four contract tests now drive
 * `runHumanCLI("token", …)` directly with console capture (same pattern as
 * src/cli/recall-asof-retr004.test.ts), and ONE real-exec parity smoke
 * keeps the bin→tsx→runHumanCLI wiring pinned end-to-end: 5 spawns → 1.
 *
 * Hermeticity: in-process runs and the parity smoke both pass
 * --auth-file pointing at a scratch store per test; the test process's
 * namespaces/config roots are already redirected by src/test-setup.ts, and
 * the parity child gets explicit DUCKBRAIN_DATA_DIR /
 * DUCKBRAIN_NAMESPACES_PATH scratch env (token-auth-file-dogfood026
 * pattern). Nothing here ever touches the real ~/.duckbrain/auth.json.
 */

import { describe, it, expect, vi } from "vitest";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { runHumanCLI } from "./human";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");

/* ---------------------------------------------------------------- helpers */

/** Scratch auth store in a fresh temp dir; returns its path. */
function scratchAuthStore(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const scratch = path.join(dir, "scratch-auth.json");
  fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));
  return scratch;
}

/**
 * Console capture — runHumanCLI reports through console.log/error (the
 * recall-asof-retr004.test.ts pattern).
 */
function capture(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: any[]) => logs.push(a.map(String).join(" ")));
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: any[]) => errors.push(a.map(String).join(" ")));
  return {
    logs,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

/**
 * Mint in-process and observe the exit contract. tokenCommand reports
 * failure via `process.exitCode = 1` (the real process then exits with that
 * code at the end of main), so the exit code is read off process.exitCode
 * around the call and restored before returning.
 */
async function runTokenInProcess(
  args: string[],
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  const { logs, errors, restore } = capture();
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runHumanCLI("token", args);
    return {
      exitCode: process.exitCode,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  } finally {
    restore();
    process.exitCode = prevExitCode;
  }
}

/** Extract the minted 64-hex token from CLI stdout. */
function mintedToken(stdout: string): string {
  const match = stdout.match(/^[0-9a-f]{64}$/m);
  if (!match) throw new Error(`no minted token found in stdout: ${stdout}`);
  return match[0];
}

/** Assert the scratch auth store holds the token with exactly `roles`. */
function expectScratchRoles(
  authFile: string,
  token: string,
  name: string,
  roles: string[],
): void {
  const parsed = JSON.parse(fs.readFileSync(authFile, "utf-8"));
  expect(Array.isArray(parsed.apiKeys)).toBe(true);
  const digest =
    "$sha256$" + crypto.createHash("sha256").update(token).digest("hex");
  const entry = parsed.apiKeys.find(
    (candidate: { keyHash?: string }) => candidate.keyHash === digest,
  );
  expect(entry).toBeDefined();
  expect(entry.name).toBe(name);
  expect(entry.roles).toEqual(roles);
  expect(entry).not.toHaveProperty("key");
  expect(fs.readFileSync(authFile, "utf-8")).not.toContain(token);
}

/* ------------------------------------------------------------------ tests */

describe("TOKEN-ROLES-001 token command --role scoping", () => {
  it("repeatable equals form --role=writer --role=analyst stores scoped roles without admin", async () => {
    const scratch = scratchAuthStore("token-roles-eq-");

    const { exitCode, stdout, stderr } = await runTokenInProcess([
      "--name=token-roles-eq",
      `--auth-file=${scratch}`,
      "--role=writer",
      "--role=analyst",
    ]);

    // Real-exec runs also emit a benign "[duckbrain] Cleared stale DuckDB
    // connections" line on stderr; assert absence of the error signatures.
    expect(stderr).not.toContain("unknown role");
    expect(exitCode ?? 0).toBe(0);
    const token = mintedToken(stdout);
    // Granted roles are echoed in the output alongside the token.
    expect(stdout).toContain("Roles: writer, analyst");
    expectScratchRoles(scratch, token, "token-roles-eq", ["writer", "analyst"]);
  });

  it("space form --role analyst stores [analyst]", async () => {
    const scratch = scratchAuthStore("token-roles-sp-");

    const { exitCode, stdout, stderr } = await runTokenInProcess([
      "--name=token-roles-sp",
      "--auth-file",
      scratch,
      "--role",
      "analyst",
    ]);

    expect(stderr).not.toContain("unknown role");
    expect(exitCode ?? 0).toBe(0);
    const token = mintedToken(stdout);
    expect(stdout).toContain("Roles: analyst");
    expectScratchRoles(scratch, token, "token-roles-sp", ["analyst"]);
  });

  it("unknown role --role=superadmin exits nonzero and writes no store entry", async () => {
    const scratch = scratchAuthStore("token-roles-bad-");

    const { exitCode, stdout, stderr } = await runTokenInProcess([
      "--name=token-roles-bad",
      `--auth-file=${scratch}`,
      "--role=superadmin",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("superadmin");
    expect(stderr).toContain("Unknown role");
    expect(stderr).toContain("Valid roles: admin, writer, analyst, uploader");
    // No token minted, store entry untouched.
    expect(stdout).not.toMatch(/^[0-9a-f]{64}$/m);
    expect(stdout).not.toContain("Roles:");
    const parsed = JSON.parse(fs.readFileSync(scratch, "utf-8"));
    expect(parsed.apiKeys).toEqual([]);
  });

  it("no --role keeps the back-compat default [admin]", async () => {
    const scratch = scratchAuthStore("token-roles-dflt-");

    const { exitCode, stdout, stderr } = await runTokenInProcess([
      "--name=token-roles-dflt",
      `--auth-file=${scratch}`,
    ]);

    expect(stderr).not.toContain("unknown role");
    expect(exitCode ?? 0).toBe(0);
    const token = mintedToken(stdout);
    expect(stdout).toContain("Roles: admin");
    expectScratchRoles(scratch, token, "token-roles-dflt", ["admin"]);
  });

  it("repeated identical roles are deduped", async () => {
    const scratch = scratchAuthStore("token-roles-dup-");

    const { exitCode, stdout, stderr } = await runTokenInProcess([
      "--name=token-roles-dup",
      `--auth-file=${scratch}`,
      "--role=writer",
      "--role",
      "writer",
    ]);

    expect(stderr).not.toContain("unknown role");
    expect(exitCode ?? 0).toBe(0);
    const token = mintedToken(stdout);
    expect(stdout).toContain("Roles: writer");
    expectScratchRoles(scratch, token, "token-roles-dup", ["writer"]);
  });
});

describe("TOKEN-ROLES-001 real-exec parity smoke (GAP-033)", () => {
  /**
   * The single remaining subprocess spawn: proves the bin → tsx →
   * runHumanCLI entry still mints the scoped token for real — the wiring
   * the in-process tests above no longer exercise.
   */
  it("real bin exec (node → tsx) mints the scoped token end-to-end", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-roles-exec-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));
    const dataDir = path.join(dir, "data");
    const nsPath = path.join(dataDir, "namespaces");
    fs.mkdirSync(nsPath, { recursive: true });

    // Explicit scratch env for the child; never inherit an ambient
    // DUCKBRAIN_AUTH_FILE override (original runTokenCli behavior).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DUCKBRAIN_DATA_DIR: dataDir,
      DUCKBRAIN_NAMESPACES_PATH: nsPath,
      NO_COLOR: "1",
    };
    delete env.DUCKBRAIN_AUTH_FILE;

    const child = spawn(
      process.execPath,
      [
        BIN_PATH,
        "token",
        "--name=token-roles-exec",
        `--auth-file=${scratch}`,
        "--role=analyst",
      ],
      { env, stdio: "pipe" },
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    const code: number | null = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (closeCode) => resolve(closeCode));
    });

    try {
      expect(code).toBe(0);
      const token = mintedToken(stdout);
      expect(stdout).toContain("Roles: analyst");
      expectScratchRoles(scratch, token, "token-roles-exec", ["analyst"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
