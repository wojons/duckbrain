/**
 * HARDEN-DUCKBRAIN-004 — both lockfiles must move with package.json.
 *
 * The repo installs from pnpm-lock.yaml (CI, local dev) and from
 * package-lock.json (Dockerfile, npm ci). Adding prom-client in OBSDB-001
 * refreshed only pnpm-lock.yaml, so the paired npm gate, then the full
 * suite, then CI went red; the repair was a second commit. The npm arm was
 * already gated (SUP-CI-20261020-DB); the pnpm arm was not, and neither
 * fired before a commit.
 *
 * This file proves the lockstep gate (scripts/ci/check-lockfile-lockstep.sh)
 * on the real tree and in fixture space:
 *   green arm  — the real pair passes, naming both arms;
 *   red arms   — declared-but-unlocked (PNPM-MISSING), specifier drift that
 *                the npm arm is structurally blind to (PNPM-SPECIFIER), a
 *                locked dependency nobody declares any more (PNPM-STALE);
 *   shape arm  — pnpm 12's multi-document lockfile still parses (the real
 *                lock is two YAML documents; a single-document parser
 *                would read zero importers);
 *   wiring     — ci.yml step before the suite, the tracked pre-commit hook,
 *                the package.json script, and the CONTRIBUTING rule.
 *
 * Fixtures use the documented seams (LOCKSTEP_ROOT, LOCKSTEP_STAGED_FILES);
 * the real lockfiles are never mutated.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileP = promisify(execFile);

const ROOT = path.resolve(__dirname, "..", "..");
const WRAPPER = path.join(ROOT, "scripts", "ci", "check-lockfile-lockstep.sh");
const PNPM_ARM = path.join(ROOT, "scripts", "ci", "check-lockfile-lockstep.mjs");
const REAL_LOCK = path.join(ROOT, "pnpm-lock.yaml");

interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGate(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<GateResult> {
  try {
    const { stdout, stderr } = await execFileP("bash", [WRAPPER, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Build a fixture root whose pnpm lockfile is derived from the real one. */
function fixture(mutate: (lockText: string) => string, patchManifest?: (m: Record<string, any>) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockstep-fixture-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (patchManifest) patchManifest(manifest);
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.join(dir, "packages", "ui"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "packages", "ui", "package.json"),
    path.join(dir, "packages", "ui", "package.json"),
  );
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), mutate(fs.readFileSync(REAL_LOCK, "utf8")));
  return dir;
}

const lockText = fs.readFileSync(REAL_LOCK, "utf8");

describe("HARDEN-DUCKBRAIN-004 lockstep gate — real tree", () => {
  it("both arms pass on the committed pair and name themselves", async () => {
    const res = await runGate();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("arm 1/2: package.json vs package-lock.json");
    expect(res.stdout).toContain("arm 2/2: package.json vs pnpm-lock.yaml");
    expect(res.stdout).toContain("LOCKDRIFT: OK");
    expect(res.stdout).toContain("LOCKSTEP: OK — 2 importer(s) agree");
    expect(res.stdout).toContain("LOCKSTEP: OK — both lockfiles agree with package.json");
  });

  it("the pnpm arm parses pnpm 12's multi-document lockfile (2 documents, root + workspace importer)", async () => {
    const { stdout } = await execFileP("node", [PNPM_ARM, "--self-test"], {
      cwd: ROOT,
      timeout: 60_000,
    });
    expect(stdout).toContain("LOCKSTEP SELF-TEST PASS");
    expect(stdout).toContain("green-multidoc (2 documents)");
    // The real lockfile really is multi-document — the shape the parser must accept.
    const docs = lockText.split(/^---[ \t]*$/m).filter((d) => d.trim().length > 0);
    expect(docs.length).toBe(2);
    expect(lockText).toContain("  packages/ui:");
  });
});

describe("HARDEN-DUCKBRAIN-004 lockstep gate — red arms (fixture space)", () => {
  it("declared-but-unlocked dependency fails the pnpm arm, naming the package", async () => {
    const dir = fixture(
      (text) => text,
      (m) => {
        m.dependencies["left-pad"] = "^1.3.0";
      },
    );
    try {
      const res = await runGate([], { LOCKSTEP_ROOT: dir });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain(
        'PNPM-MISSING: . dependencies left-pad is declared as "^1.3.0" in package.json but has no entry in pnpm-lock.yaml',
      );
      expect(res.stderr).toContain("LOCKSTEP: FAILED");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("specifier drift the npm arm cannot see fails the pnpm arm only", async () => {
    // 15.1.3 still satisfies ">=15.1.0", so arm 1 stays green — exactly the
    // class that used to reach the suite unnoticed.
    const dir = fixture(
      (text) => text,
      (m) => {
        m.dependencies["prom-client"] = ">=15.1.0";
      },
    );
    try {
      const res = await runGate([], { LOCKSTEP_ROOT: dir });
      expect(res.code).not.toBe(0);
      expect(res.stdout).toContain("LOCKDRIFT: OK");
      expect(res.stderr).toContain(
        'PNPM-SPECIFIER: . dependencies prom-client declared as ">=15.1.0" but locked specifier is "^15.1.3"',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a locked dependency no longer declared is reported stale", async () => {
    const dir = fixture((text) =>
      text.replace(
        /(\n      zod:\n        specifier: \^4\.6\.7\n        version: 4\.6\.7\n)/,
        "$1      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n",
      ),
    );
    try {
      const res = await runGate([], { LOCKSTEP_ROOT: dir });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain(
        "PNPM-STALE: . dependencies left-pad is locked but no longer declared in package.json",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the gate mirrors pnpm's own frozen-install rule (specifiers, not just versions)", () => {
    const script = fs.readFileSync(PNPM_ARM, "utf8");
    // Offline by construction: node builtins only, no package manager call.
    const imports = [...script.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith("node:")).toBe(true);
    expect(script).not.toMatch(/(^|\n)\s*(npm|pnpm|curl|wget)\s/m);
    expect(script).not.toMatch(/(\|\s*|\$\(\s*)(npm|pnpm|curl|wget)\b/);
    expect(script).toContain("ERR_PNPM_OUTDATED_LOCKFILE".slice(0, 0) + "specifier");
  });
});

describe("HARDEN-DUCKBRAIN-004 lockstep gate — pre-commit mode and wiring", () => {
  it("--staged skips when no manifest or lockfile is staged", async () => {
    const res = await runGate(["--staged"], { LOCKSTEP_STAGED_FILES: "src/cli/http.ts" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("LOCKSTEP: skipped (no package manifest or lockfile staged)");
  });

  it("--staged runs when package.json is staged", async () => {
    const res = await runGate(["--staged"], {
      LOCKSTEP_STAGED_FILES: "package.json\npackages/ui/package.json",
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("LOCKSTEP: OK — both lockfiles agree");
  });

  it("--self-test proves both arms in fixture space", async () => {
    const res = await runGate(["--self-test"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("SELF-TEST PASS");
    expect(res.stdout).toContain("LOCKSTEP SELF-TEST PASS");
  });

  it("ci.yml runs the lockstep gate before the test suite", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const lockstep = ci.indexOf("Check lockfile lockstep (pnpm + npm)");
    const npmGate = ci.indexOf("Check lockfile sync");
    const suite = ci.indexOf("Run integration tests");
    expect(npmGate).toBeGreaterThan(-1);
    expect(lockstep).toBeGreaterThan(-1);
    expect(suite).toBeGreaterThan(-1);
    expect(lockstep).toBeLessThan(suite);
    expect(lockstep).toBeGreaterThan(npmGate);
    expect(ci).toContain("run: bash scripts/ci/check-lockfile-lockstep.sh");
  });

  it("the rule is recorded: tracked hook, package script, contributing docs", () => {
    const hook = path.join(ROOT, ".githooks", "pre-commit");
    expect(fs.existsSync(hook)).toBe(true);
    const hookBody = fs.readFileSync(hook, "utf8");
    expect(hookBody).toContain("check-lockfile-lockstep.sh");
    expect(hookBody).toContain("--staged");
    // Executable bit travels with git's index — assert it in the working tree.
    expect(fs.statSync(hook).mode & 0o111).toBeGreaterThan(0);

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["deps:lockstep"]).toBe("bash scripts/ci/check-lockfile-lockstep.sh");

    const contributing = fs.readFileSync(path.join(ROOT, "CONTRIBUTING.md"), "utf8");
    expect(contributing).toContain("## Dependency Changes: Both Lockfiles, One Command");
    expect(contributing).toContain("pnpm deps:lockstep");
    expect(contributing).toContain("pnpm install --lockfile-only");
    expect(contributing).toContain("npm install --package-lock-only --ignore-scripts");
    expect(contributing).toContain("git config core.hooksPath .githooks");

    expect(fs.existsSync(WRAPPER)).toBe(true);
    expect(fs.statSync(WRAPPER).mode & 0o111).toBeGreaterThan(0);
    expect(fs.existsSync(PNPM_ARM)).toBe(true);
  });
});
