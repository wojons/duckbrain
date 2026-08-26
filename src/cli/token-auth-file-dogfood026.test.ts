/**
 * DOGFOOD-026 regression tests: `duckbrain token` honors --auth-file /
 * DUCKBRAIN_AUTH_FILE and never silently writes the production auth store.
 *
 * Incident (2026-08-26): tokenCommand hardcoded ~/.duckbrain/auth.json, so a
 * scratch/judge/CI workflow that minted tokens with DUCKBRAIN_AUTH_FILE set
 * still wrote the PROD store ("Token saved to /home/kara/.duckbrain/auth.json"
 * — prod store polluted; restored from backup). DB-GAP-043 isolated the http
 * daemon only; the token subcommand still hardcoded the prod path.
 *
 * These tests pin the fix:
 *
 *  1. Mint with DUCKBRAIN_AUTH_FILE → token lands in the scratch file ONLY;
 *     prod ~/.duckbrain/auth.json mtime + sha256 unchanged.
 *  2. Mint with --auth-file=<path> (equals form) and --auth-file <path>
 *     (space form) → same isolation.
 *  3. A missing explicit --auth-file is FATAL (nonzero exit + clear error),
 *     prod untouched — never a silent fallback to the prod store.
 *  4. A missing DUCKBRAIN_AUTH_FILE path is CREATED on first mint (the env
 *     override is a write-target redirect for scratch workflows).
 *
 * Hermeticity: spawned CLI runs use DUCKBRAIN_DATA_DIR / DUCKBRAIN_NAMESPACES_PATH
 * in temp dirs (auth-file.test.ts pattern); nothing here ever writes to the
 * real ~/.duckbrain/auth.json — the prod file is only READ for the unchanged
 * assertion, and only its sha256 is compared so a failure can never print
 * prod secrets into test output.
 */

import { describe, it, expect } from "vitest";
import { spawn, ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const PROD_AUTH_PATH = path.join(os.homedir(), ".duckbrain", "auth.json");

/* ---------------------------------------------------------------- helpers */

function prepareDataDir(prefix: string): { dataDir: string; nsPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
  return { dataDir, nsPath };
}

/**
 * Snapshot of the prod auth store that is safe to compare (and safe to
 * print on failure): existence + sha256 + mtime — never the raw bytes.
 */
function snapshotProdAuth(): {
  exists: boolean;
  sha256: string | null;
  mtimeMs: number | null;
} {
  if (!fs.existsSync(PROD_AUTH_PATH)) {
    return { exists: false, sha256: null, mtimeMs: null };
  }
  const bytes = fs.readFileSync(PROD_AUTH_PATH);
  return {
    exists: true,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: fs.statSync(PROD_AUTH_PATH).mtimeMs,
  };
}

function runTokenCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { dataDir, nsPath } = prepareDataDir("duckbrain-dogfood026-");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DUCKBRAIN_DATA_DIR: dataDir,
      DUCKBRAIN_NAMESPACES_PATH: nsPath,
      NO_COLOR: "1",
      ...extraEnv,
    };
    // Flag-form tests must not inherit an env override leaked by another test.
    if (!("DUCKBRAIN_AUTH_FILE" in extraEnv)) {
      delete env.DUCKBRAIN_AUTH_FILE;
    }
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

/** Assert the scratch auth store contains exactly the minted token. */
function expectScratchHasToken(
  authFile: string,
  token: string,
  name: string,
): void {
  const parsed = JSON.parse(fs.readFileSync(authFile, "utf-8"));
  expect(Array.isArray(parsed.apiKeys)).toBe(true);
  const entry = parsed.apiKeys.find((k: { key: string }) => k.key === token);
  expect(entry).toBeDefined();
  expect(entry.name).toBe(name);
}

/* ------------------------------------------------------------------ tests */

describe("DOGFOOD-026 token command auth-store isolation", () => {
  it("mint with DUCKBRAIN_AUTH_FILE writes the scratch file only; prod untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood026-env-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));
    const prodBefore = snapshotProdAuth();

    const { code, stdout, stderr } = await runTokenCli(
      ["--name=dogfood026-env"],
      { DUCKBRAIN_AUTH_FILE: scratch },
    );

    expect(stderr).not.toContain("--auth-file not found");
    expect(stderr).not.toContain("Could not parse --auth-file");
    expect(code).toBe(0);
    expect(stdout).toContain(`Token saved to ${scratch}`);
    expect(stdout).not.toContain(PROD_AUTH_PATH);
    const token = mintedToken(stdout);
    expectScratchHasToken(scratch, token, "dogfood026-env");
    // Prod store must be byte-identical (content + mtime).
    expect(snapshotProdAuth()).toEqual(prodBefore);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mint with --auth-file=<path> (equals form) writes the scratch file only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood026-flag-eq-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));
    const prodBefore = snapshotProdAuth();

    const { code, stdout, stderr } = await runTokenCli([
      "--name=dogfood026-flag-eq",
      `--auth-file=${scratch}`,
    ]);

    expect(stderr).not.toContain("--auth-file not found");
    expect(stderr).not.toContain("Could not parse --auth-file");
    expect(code).toBe(0);
    expect(stdout).toContain(`Token saved to ${scratch}`);
    const token = mintedToken(stdout);
    expectScratchHasToken(scratch, token, "dogfood026-flag-eq");
    expect(snapshotProdAuth()).toEqual(prodBefore);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mint with --auth-file <path> (space form) writes the scratch file only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood026-flag-sp-"));
    const scratch = path.join(dir, "scratch-auth.json");
    fs.writeFileSync(scratch, JSON.stringify({ apiKeys: [] }));
    const prodBefore = snapshotProdAuth();

    const { code, stdout, stderr } = await runTokenCli([
      "--name=dogfood026-flag-sp",
      "--auth-file",
      scratch,
    ]);

    expect(stderr).not.toContain("--auth-file not found");
    expect(stderr).not.toContain("Could not parse --auth-file");
    expect(code).toBe(0);
    expect(stdout).toContain(`Token saved to ${scratch}`);
    const token = mintedToken(stdout);
    expectScratchHasToken(scratch, token, "dogfood026-flag-sp");
    expect(snapshotProdAuth()).toEqual(prodBefore);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("missing explicit --auth-file exits nonzero with a clear error; prod untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood026-missing-"));
    const missing = path.join(dir, "does-not-exist.json");
    const prodBefore = snapshotProdAuth();

    const { code, stdout, stderr } = await runTokenCli([
      "--name=dogfood026-missing",
      `--auth-file=${missing}`,
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toContain("--auth-file not found");
    expect(stderr).toContain(missing);
    // No token minted, nothing written anywhere.
    expect(stdout).not.toMatch(/^[0-9a-f]{64}$/m);
    expect(fs.existsSync(missing)).toBe(false);
    expect(snapshotProdAuth()).toEqual(prodBefore);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("missing DUCKBRAIN_AUTH_FILE path is created on first mint; prod untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood026-env-new-"));
    const scratch = path.join(dir, "fresh-scratch-auth.json");
    const prodBefore = snapshotProdAuth();

    const { code, stdout, stderr } = await runTokenCli(
      ["--name=dogfood026-env-new"],
      { DUCKBRAIN_AUTH_FILE: scratch },
    );

    expect(stderr).not.toContain("--auth-file not found");
    expect(stderr).not.toContain("Could not parse --auth-file");
    expect(code).toBe(0);
    expect(stdout).toContain(`Token saved to ${scratch}`);
    const token = mintedToken(stdout);
    expectScratchHasToken(scratch, token, "dogfood026-env-new");
    expect(snapshotProdAuth()).toEqual(prodBefore);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
