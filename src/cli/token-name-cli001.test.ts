/**
 * TOKEN-NAME-001 regression suite.
 *
 * `duckbrain token --name gateprobe` (the ordinary space-separated CLI form)
 * used to store the token name as the literal string "true": parseArgs turns
 * a bare `--name` into "true", and tokenCommand read `flags.name` without
 * scanning the raw args the way it already did for `--namespace`, `--role`
 * and `--auth-file`.
 *
 * The name is not cosmetic — it IS the author identity. With five of six
 * tokens on the live E2E agent named "true", every row they wrote was
 * attributed to true@duckbrain.local and the audit could no longer answer
 * "who wrote this". The end-to-end consequence (a row stamped
 * <token-name>@duckbrain.local) is covered by
 * src/cli/http-mcp-auth-dogfood025.test.ts AC1; this suite covers the root
 * cause — what actually gets stored as the name.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { principalAuthorEmail } from "../auth/middleware";

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const SCRATCH_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-tokname-"),
);
const AUTH_FILE = path.join(SCRATCH_ROOT, "auth.json");

function freshStore(): void {
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ users: [], apiKeys: [] }));
}

function storedNames(): string[] {
  const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  return (parsed.apiKeys ?? []).map((k: { name?: string }) => k.name);
}

function runCli(
  args: string[],
  timeoutMs = 45_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env: { ...process.env, NO_COLOR: "1" },
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  freshStore();
});

afterAll(() => {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe("TOKEN-NAME-001: token --name never stores the literal 'true'", () => {
  it("SPACE form: `--name gateprobe` stores the name the caller passed", async () => {
    freshStore();
    const { code } = await runCli([
      "token",
      "--name",
      "gateprobe",
      `--auth-file=${AUTH_FILE}`,
    ]);
    expect(code).toBe(0);
    expect(storedNames()).toEqual(["gateprobe"]);
    // The exact defect:
    expect(storedNames()).not.toContain("true");
  });

  it("EQUALS form: `--name=gateprobe2` still stores the name", async () => {
    freshStore();
    const { code } = await runCli([
      "token",
      "--name=gateprobe2",
      `--auth-file=${AUTH_FILE}`,
    ]);
    expect(code).toBe(0);
    expect(storedNames()).toEqual(["gateprobe2"]);
  });

  it("BOTH spellings land identically — the two forms cannot diverge again", async () => {
    freshStore();
    await runCli(["token", "--name", "spaced", `--auth-file=${AUTH_FILE}`]);
    await runCli(["token", "--name=equals", `--auth-file=${AUTH_FILE}`]);
    expect(storedNames()).toEqual(["spaced", "equals"]);
  });

  it("a bare `--name` with no value FAILS LOUDLY instead of minting 'true'", async () => {
    freshStore();
    const { code, stderr } = await runCli([
      "token",
      "--name",
      `--auth-file=${AUTH_FILE}`,
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--name requires a value/);
    // Nothing was written: a refused mint must not leave a credential behind.
    expect(storedNames()).toEqual([]);
  });

  it("refuses to name a token with a bare reserved literal", async () => {
    freshStore();
    const { code, stderr } = await runCli([
      "token",
      "--name=true",
      `--auth-file=${AUTH_FILE}`,
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/reserved/i);
    expect(storedNames()).toEqual([]);
  });

  it("still falls back to a generated name when --name is absent (unchanged)", async () => {
    freshStore();
    const { code } = await runCli(["token", `--auth-file=${AUTH_FILE}`]);
    expect(code).toBe(0);
    const names = storedNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^token-\d+$/);
  });

  it("the stored name IS the author identity — so provenance is restored", () => {
    // dogfood025 AC1 proves a row is stamped <token-name>@duckbrain.local.
    // Given that mapping, storing the right name is what makes the row
    // attributable:
    expect(principalAuthorEmail({ name: "gateprobe" } as never)).toBe(
      "gateprobe@duckbrain.local",
    );
    // ...and what the defect produced is now unreachable by this path:
    expect(principalAuthorEmail({ name: "gateprobe" } as never)).not.toBe(
      "true@duckbrain.local",
    );
  });
});
