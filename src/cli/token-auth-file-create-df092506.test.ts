/**
 * DOGFOOD-026 regression tests, case 3 updated by DF-0925-06: a missing
 * explicit --auth-file is no longer FATAL for token minting — the store is
 * CREATED (empty {"apiKeys":[]}) so a fresh agent can bootstrap a scratch
 * store on first run (mkdir + token mint recipe in skills/duckbrain-usage).
 * The HTTP serve path keeps its fatal refusal (auth-file.test.ts, DB-GAP-043).
 *
 * Hermeticity: spawned CLI runs use temp dirs; prod auth.json is only
 * snapshot-hashed, never written.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const PROD_AUTH_PATH = path.join(os.homedir(), ".duckbrain", "auth.json");

function runTokenCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [BIN_PATH, "token", ...args], {
      env: {
        ...process.env,
        ...env,
        DUCKBRAIN_DATA_DIR: fs.mkdtempSync(
          path.join(os.tmpdir(), "df092506-data-"),
        ),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function snapshotProdAuth(): { exists: boolean; sha256: string | null } {
  if (!fs.existsSync(PROD_AUTH_PATH)) return { exists: false, sha256: null };
  return {
    exists: true,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(PROD_AUTH_PATH)).digest("hex"),
  };
}

describe("DF-0925-06: missing --auth-file is created for token minting", () => {
  it(
    "mints a token into a fresh --auth-file path including a missing parent dir",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df092506-create-"));
      const fresh = path.join(dir, "sub", "nested", "auth.json");
      const prodBefore = snapshotProdAuth();

      const { code, stdout, stderr } = await runTokenCli([
        "--name=df092506-create",
        `--auth-file=${fresh}`,
      ]);

      expect(stderr).not.toContain("--auth-file not found");
      expect(code).toBe(0);
      expect(stdout).toContain(`Token saved to ${fresh}`);
      expect(fs.existsSync(fresh)).toBe(true);
      const store = JSON.parse(fs.readFileSync(fresh, "utf-8"));
      expect(Array.isArray(store.apiKeys)).toBe(true);
      expect(store.apiKeys).toHaveLength(1);
      expect(store.apiKeys[0].name).toBe("df092506-create");
      expect(store.apiKeys[0].keyHash).toMatch(/^\$sha256\$[0-9a-f]{64}$/);
      expect(snapshotProdAuth()).toEqual(prodBefore);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  it("still fails loudly for an existing but unparseable --auth-file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df092506-badjson-"));
    const bad = path.join(dir, "auth.json");
    fs.writeFileSync(bad, "{ not json");
    const prodBefore = snapshotProdAuth();

    const { code, stderr } = await runTokenCli([
      "--name=df092506-bad",
      `--auth-file=${bad}`,
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toContain("Could not parse --auth-file");
    expect(snapshotProdAuth()).toEqual(prodBefore);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
