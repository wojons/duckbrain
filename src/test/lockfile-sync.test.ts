/**
 * SUP-CI-20261020-DB — lockfile drift gate tests.
 *
 * Mirrors the red-proof-gate / check-ops-inventory pairing: a small
 * checker script (scripts/ci/check-lockfile-sync.sh) plus THIS test file
 * proving both arms:
 *   green arm — the REAL repo pair (package.json + package-lock.json)
 *               passes with exit 0;
 *   red arm   — a FIXTURE copy with one version deliberately staled is
 *               reported as drift and exits non-zero, with the offending
 *               package named.
 *
 * The fixture arms run through the checker's documented env seams
 * (LOCKFILE_SYNC_MANIFEST / LOCKFILE_SYNC_LOCKFILE) against temp-dir
 * copies — the REAL package-lock.json is never mutated by this test.
 *
 * npm ci (Dockerfile:8 and the CI install step) dies with EUSAGE on
 * exactly this drift class; this gate fails CI in seconds, offline,
 * instead.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileP = promisify(execFile);

const ROOT = path.resolve(__dirname, "..", "..");
const GUARD = path.join(ROOT, "scripts", "ci", "check-lockfile-sync.sh");
const REAL_MANIFEST = path.join(ROOT, "package.json");
const REAL_LOCK = path.join(ROOT, "package-lock.json");

interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGuard(
  env: Record<string, string> = {},
): Promise<GuardResult> {
  try {
    const { stdout, stderr } = await execFileP("bash", [GUARD], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/** First production dependency declared in the real package.json. */
function firstDeclaredDep(): string {
  const manifest = JSON.parse(fs.readFileSync(REAL_MANIFEST, "utf8")) as {
    dependencies: Record<string, string>;
  };
  const names = Object.keys(manifest.dependencies ?? {});
  expect(names.length).toBeGreaterThan(0);
  return names[0];
}

describe("SUP-CI-20261020-DB lockfile-sync gate — green arm", () => {
  it("real repo pair passes: exit 0, LOCKDRIFT: OK", async () => {
    const res = await runGuard();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("LOCKDRIFT: OK");
  });
});

describe("SUP-CI-20261020-DB lockfile-sync gate — red arm", () => {
  it("one staled fixture version is reported as drift and exits non-zero", async () => {
    const dep = firstDeclaredDep();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "locksync-red-"));
    try {
      const manifest = fs.readFileSync(REAL_MANIFEST, "utf8");
      const lock = JSON.parse(fs.readFileSync(REAL_LOCK, "utf8")) as {
        packages: Record<string, { version?: string }>;
      };
      const entry = lock.packages?.[`node_modules/${dep}`];
      expect(entry).toBeDefined();
      // Deliberately stale ONE recorded version: 0.0.1 satisfies no real
      // declared range, so the checker must flag exactly this package.
      entry!.version = "0.0.1";
      fs.writeFileSync(path.join(tmp, "package.json"), manifest);
      fs.writeFileSync(
        path.join(tmp, "package-lock.json"),
        `${JSON.stringify(lock, null, 2)}\n`,
      );

      const res = await runGuard({
        LOCKFILE_SYNC_MANIFEST: path.join(tmp, "package.json"),
        LOCKFILE_SYNC_LOCKFILE: path.join(tmp, "package-lock.json"),
      });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain(`LOCKDRIFT: DRIFT: ${dep}:`);
      expect(res.stderr).toContain("0.0.1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // The fixture seam means the REAL lock was never touched — prove it
    // still records the original version for the dep we staled.
    const realLock = JSON.parse(fs.readFileSync(REAL_LOCK, "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    expect(realLock.packages[`node_modules/${dep}`]?.version).not.toBe("0.0.1");
  });

  it("a declared dep missing from the lock is reported MISSING and exits non-zero", async () => {
    const dep = firstDeclaredDep();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "locksync-missing-"));
    try {
      const lock = JSON.parse(fs.readFileSync(REAL_LOCK, "utf8")) as {
        packages: Record<string, unknown>;
      };
      delete lock.packages[`node_modules/${dep}`];
      fs.writeFileSync(path.join(tmp, "package.json"), fs.readFileSync(REAL_MANIFEST, "utf8"));
      fs.writeFileSync(
        path.join(tmp, "package-lock.json"),
        `${JSON.stringify(lock, null, 2)}\n`,
      );

      const res = await runGuard({
        LOCKFILE_SYNC_MANIFEST: path.join(tmp, "package.json"),
        LOCKFILE_SYNC_LOCKFILE: path.join(tmp, "package-lock.json"),
      });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain(`LOCKDRIFT: MISSING: ${dep}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("SUP-CI-20261020-DB lockfile-sync gate — self-test and wiring", () => {
  it("checker --self-test proves both arms in fixture space (exit 0)", async () => {
    const { stdout } = await execFileP(
      "bash",
      [GUARD, "--self-test"],
      { cwd: ROOT, env: process.env, timeout: 30_000 },
    );
    expect(stdout).toContain("SELF-TEST PASS");
  });

  it("ci.yml runs the gate before the integration-tests step with CI: true", () => {
    const ci = fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const gateStep = ci.indexOf("Check lockfile sync");
    const integrationStep = ci.indexOf("name: Run integration tests");
    expect(gateStep).toBeGreaterThan(-1);
    expect(integrationStep).toBeGreaterThan(-1);
    expect(gateStep).toBeLessThan(integrationStep);
    // The step's env block carries CI: true (the next env: after the gate).
    const afterGate = ci.slice(gateStep, integrationStep);
    expect(afterGate).toMatch(/env:\s*\n\s*CI:\s*true/);
    // The step invokes the checker script that exists in the repo.
    expect(ci).toContain("bash scripts/ci/check-lockfile-sync.sh");
    expect(fs.existsSync(GUARD)).toBe(true);
  });

  it("checker is a real offline json-vs-json comparison, not a string grep", () => {
    const script = fs.readFileSync(GUARD, "utf8");
    // No npm/curl/wget invocation, no JS fetch: node is the only child
    // process. Match INVOCATIONS (line-leading, piped, subshelled) —
    // prose mentions in comments/messages are fine.
    expect(script).not.toMatch(/(^|\n)\s*(npm|curl|wget)\s/m);
    expect(script).not.toMatch(/(\|\s*|\$\(\s*)(npm|curl|wget)\b/);
    expect(script).not.toMatch(/\bfetch\s*\(/);
    // It parses both files as JSON and compares declared specs to locked
    // versions (the satisfies comparison core).
    expect(script).toContain("JSON.parse");
    expect(script).toContain("function satisfies");
    expect(script).toContain("cmp(");
    // And it exits non-zero on drift.
    expect(script).toContain("process.exit(1)");
  });
});
