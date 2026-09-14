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
 * Hermeticity: spawned CLI runs use --auth-file pointing at a scratch store
 * plus DUCKBRAIN_DATA_DIR / DUCKBRAIN_NAMESPACES_PATH in temp dirs
 * (token-auth-file-dogfood026.test.ts pattern); nothing here ever touches
 * the real ~/.duckbrain/auth.json.
 */

import { describe, it, expect } from "vitest";
import { spawn, ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");

/* ---------------------------------------------------------------- helpers */

function prepareDataDir(prefix: string): { dataDir: string; nsPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
  return { dataDir, nsPath };
}

function runTokenCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { dataDir, nsPath } = prepareDataDir("duckbrain-token-roles-");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DUCKBRAIN_DATA_DIR: dataDir,
      DUCKBRAIN_NAMESPACES_PATH: nsPath,
      NO_COLOR: "1",
      ...extraEnv,
    };
    delete env.DUCKBRAIN_AUTH_FILE;
    const child: ChildProcess = spawn(
      process.execPath,
      [BIN_PATH, "token", ...args],
      { env, stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-roles-eq-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));

    const { code, stdout, stderr } = await runTokenCli([
      "--name=token-roles-eq",
      `--auth-file=${scratch}`,
      "--role=writer",
      "--role=analyst",
    ]);

    // The bootstrap emits a benign "[duckbrain] Cleared stale DuckDB
    // connections" line on stderr; assert absence of the error signatures.
    expect(stderr).not.toContain("unknown role");
    expect(code).toBe(0);
    const token = mintedToken(stdout);
    // Granted roles are echoed in the output alongside the token.
    expect(stdout).toContain("Roles: writer, analyst");
    expectScratchRoles(scratch, token, "token-roles-eq", ["writer", "analyst"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("space form --role analyst stores [analyst]", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-roles-sp-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));

    const { code, stdout, stderr } = await runTokenCli([
      "--name=token-roles-sp",
      "--auth-file",
      scratch,
      "--role",
      "analyst",
    ]);

    expect(stderr).not.toContain("unknown role");
    expect(code).toBe(0);
    const token = mintedToken(stdout);
    expect(stdout).toContain("Roles: analyst");
    expectScratchRoles(scratch, token, "token-roles-sp", ["analyst"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("unknown role --role=superadmin exits nonzero and writes no store entry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-roles-bad-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));

    const { code, stdout, stderr } = await runTokenCli([
      "--name=token-roles-bad",
      `--auth-file=${scratch}`,
      "--role=superadmin",
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toContain("superadmin");
    expect(stderr).toContain("Unknown role");
    expect(stderr).toContain("Valid roles: admin, writer, analyst, uploader");
    // No token minted, store entry untouched.
    expect(stdout).not.toMatch(/^[0-9a-f]{64}$/m);
    expect(stdout).not.toContain("Roles:");
    const parsed = JSON.parse(fs.readFileSync(scratch, "utf-8"));
    expect(parsed.apiKeys).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no --role keeps the back-compat default [admin]", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-roles-dflt-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));

    const { code, stdout, stderr } = await runTokenCli([
      "--name=token-roles-dflt",
      `--auth-file=${scratch}`,
    ]);

    expect(stderr).not.toContain("unknown role");
    expect(code).toBe(0);
    const token = mintedToken(stdout);
    expect(stdout).toContain("Roles: admin");
    expectScratchRoles(scratch, token, "token-roles-dflt", ["admin"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repeated identical roles are deduped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-roles-dup-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));

    const { code, stdout, stderr } = await runTokenCli([
      "--name=token-roles-dup",
      `--auth-file=${scratch}`,
      "--role=writer",
      "--role",
      "writer",
    ]);

    expect(stderr).not.toContain("unknown role");
    expect(code).toBe(0);
    const token = mintedToken(stdout);
    expect(stdout).toContain("Roles: writer");
    expectScratchRoles(scratch, token, "token-roles-dup", ["writer"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
