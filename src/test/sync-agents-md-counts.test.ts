/**
 * DF-2026-13 — test-count manifest gate tests.
 *
 * The CI step "Assert test-counts.json matches live suite" runs
 * scripts/sync-agents-md-counts.sh --check against the tee'd vitest output.
 * Since DF-2026-13 the gate reads the generated, NON-protected
 * test-counts.json manifest at the repo root — AGENTS.md is a protected
 * agent-instruction file whose write is refused in unattended/api_server
 * sessions, so the script must never touch it.
 *
 * Arms proven here (hermetic: temp-dir fixtures, env seam
 * DUCKBRAIN_COUNTS_MANIFEST, no network, no ports; the real
 * test-counts.json and AGENTS.md are never mutated):
 *   green arm  — sync mode extracts totals from a vitest-output fixture and
 *                writes the manifest; --check against the same fixture
 *                exits 0;
 *   red arm    — a manifest with deliberately drifted counts makes --check
 *                exit non-zero and name the drift (GAP-012 class);
 *   parse arm  — an unparseable vitest-output fixture makes both modes exit
 *                non-zero with the GAP-032 error class.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileP = promisify(execFile);

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "sync-agents-md-counts.sh");

const VITEST_PASS_SUMMARY = [
  "  ✓ src/test/example.test.ts (3 tests) 5ms",
  "",
  " Test Files  7 passed (7)",
  "      Tests  42 passed (42)",
  "   Start at  12:00:00",
  "   Duration  1.23s",
  "",
].join("\n");

// Partial-failure summary shape: totals still parenthesized (the extraction
// must keep working when not everything passed — same as the pre-DF-2026-13
// script contract).
const VITEST_PARTIAL_SUMMARY = [
  " Test Files  1 failed | 6 passed (7)",
  "      Tests  2 failed | 40 passed (42)",
  "",
].join("\n");

const VITEST_UNPARSEABLE = "vitest exploded before printing a summary\n";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tmpDir: string;
let manifestPath: string;
let vitestOutPath: string;

function writeVitestOut(content: string): void {
  fs.writeFileSync(vitestOutPath, content);
}

function writeManifest(suites: number, tests: number): void {
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ suites, tests, provenance: "fixture" }, null, 2) + "\n",
  );
}

async function runScript(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP("bash", [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, DUCKBRAIN_COUNTS_MANIFEST: manifestPath },
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "df2026-13-counts-"));
  manifestPath = path.join(tmpDir, "test-counts.json");
  vitestOutPath = path.join(tmpDir, "vitest.out");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("sync-agents-md-counts.sh — manifest gate (DF-2026-13)", () => {
  it("sync mode writes the manifest with extracted totals; --check then passes", async () => {
    writeVitestOut(VITEST_PASS_SUMMARY);

    const sync = await runScript([vitestOutPath]);
    expect(sync.code).toBe(0);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      suites: number;
      tests: number;
      provenance: string;
    };
    expect(manifest.suites).toBe(7);
    expect(manifest.tests).toBe(42);
    expect(manifest.provenance).toContain("vitest");

    const check = await runScript(["--check", vitestOutPath]);
    expect(check.code).toBe(0);
    expect(check.stdout + check.stderr).toContain(
      "match live suite (7 suites, 42 tests)",
    );
  });

  it("sync mode is idempotent when the manifest already matches", async () => {
    writeVitestOut(VITEST_PASS_SUMMARY);
    writeManifest(7, 42);

    const sync = await runScript([vitestOutPath]);
    expect(sync.code).toBe(0);
    expect(sync.stdout + sync.stderr).toContain("idempotent");
  });

  it("parses partial-failure vitest summaries (parenthesized totals)", async () => {
    writeVitestOut(VITEST_PARTIAL_SUMMARY);
    writeManifest(7, 42);

    const check = await runScript(["--check", vitestOutPath]);
    expect(check.code).toBe(0);
  });

  it("--check exits non-zero and names the drift when the manifest count is stale", async () => {
    writeVitestOut(VITEST_PASS_SUMMARY);
    writeManifest(6, 41); // drifted: live fixture says 7 suites, 42 tests

    const check = await runScript(["--check", vitestOutPath]);
    expect(check.code).not.toBe(0);
    expect(check.stdout + check.stderr).toContain("GAP-012 drift");
    expect(check.stdout + check.stderr).toContain(
      "(6 suites, 41 tests) != live (7 suites, 42 tests)",
    );
  });

  it("--check exits non-zero when the manifest file is missing", async () => {
    writeVitestOut(VITEST_PASS_SUMMARY);

    const check = await runScript(["--check", vitestOutPath]);
    expect(check.code).not.toBe(0);
    expect(check.stdout + check.stderr).toContain("GAP-032");
  });

  it("sync mode exits non-zero with GAP-032 on unparseable vitest output", async () => {
    writeVitestOut(VITEST_UNPARSEABLE);

    const sync = await runScript([vitestOutPath]);
    expect(sync.code).not.toBe(0);
    expect(sync.stdout + sync.stderr).toContain(
      "GAP-032: vitest summary unparseable",
    );
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it("--check exits non-zero with GAP-032 on unparseable vitest output", async () => {
    writeVitestOut(VITEST_UNPARSEABLE);
    writeManifest(7, 42);

    const check = await runScript(["--check", vitestOutPath]);
    expect(check.code).not.toBe(0);
    expect(check.stdout + check.stderr).toContain(
      "GAP-032: vitest summary unparseable",
    );
  });

  it("exits non-zero with GAP-032 when the vitest output file does not exist", async () => {
    const missing = path.join(tmpDir, "no-such.out");
    const res = await runScript(["--check", missing]);
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toContain(
      "GAP-032: vitest output not found",
    );
  });

  it("never reads or writes AGENTS.md (protected instruction file)", () => {
    // Source invariant: the DF-2026-13 rework removed every AGENTS.md
    // reference from the script — the gate must be satisfiable from an
    // unattended tick where writing that file is refused.
    const src = fs.readFileSync(SCRIPT, "utf8");
    const codeLines = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(codeLines.join("\n")).not.toContain("AGENTS.md");
  });
});
