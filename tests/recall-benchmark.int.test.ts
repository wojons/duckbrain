/**
 * DF-2026-17: recall quality benchmark — end-to-end runner proof.
 *
 * The benchmark (scripts/recall-benchmark/cases.json + run.mjs) is the
 * artifact the nightly workflow executes; these tests prove its MECHANICS
 * end-to-end: the runner boots a hermetic scratch instance, seeds the
 * fixture corpus through the real write API, executes all 20 cases, prints
 * every rate with its denominator, and maps misses to a non-zero exit
 * code. The integration suite deliberately does NOT gate on the quality
 * verdict itself — a retrieval-quality regression must turn the SCHEDULED
 * benchmark red, not this suite (the runner's exit-code contract is
 * asserted instead: verdict PASS <=> 0, FAIL <=> 1, never 2 here).
 *
 * The negative control corrupts one expected key in a COPY of the fixture
 * and requires the runner to name that case as a miss and exit 1 — a
 * benchmark that cannot fail is not a gate.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const REPO = process.cwd();
const RUNNER = path.join(REPO, "scripts", "recall-benchmark", "run.mjs");
const FIXTURE = path.join(REPO, "scripts", "recall-benchmark", "cases.json");

// Daemon cold start (tsx transpile + node-duckdb native load) + seeding 24
// memories + the first-read FTS sidecar auto-build + 20 queries. The repo's
// DAEMON_READY_TIMEOUT_MS is 60s; the whole run is well under 7 minutes.
const RUN_TIMEOUT_MS = 420_000;

function runBenchmark(args: string[]) {
  return spawnSync("node", [RUNNER, ...args], {
    cwd: REPO,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: RUN_TIMEOUT_MS - 30_000,
    killSignal: "SIGKILL",
    env: { ...process.env },
  });
}

function readReport(jsonPath: string): any {
  expect(fs.existsSync(jsonPath)).toBe(true);
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
}

describe("DF-2026-17 recall benchmark fixture", () => {
  it("is structurally sound and self-consistent", () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
    expect(fixture.namespace).toBe("coding-hermes");
    expect(fixture.cases).toHaveLength(20);
    const ids = fixture.cases.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(20);
    const seedKeys = new Set(fixture.seed.map((m: any) => m.key));
    expect(fixture.seed.length).toBeGreaterThan(0);
    for (const c of fixture.cases) {
      expect(typeof c.query).toBe("string");
      expect(c.query.trim().length).toBeGreaterThan(0);
      // Exactly one expectation form per case.
      expect(Boolean(c.expectKeys) !== Boolean(c.expectRefusal)).toBe(true);
      if (c.expectKeys) {
        // The fixture may never expect a key it did not plant — otherwise
        // the case is a typo, not a measurement.
        for (const k of c.expectKeys) expect(seedKeys.has(k)).toBe(true);
      }
    }
    // Cases 1-2 are the live-verified 2026-10-27 observations, verbatim.
    expect(fixture.cases[0].query).toBe("cooldown");
    expect(fixture.cases[0].observed).toBe("2026-10-27");
    expect(fixture.cases[1].query).toBe("zzzznothinglikethis");
    expect(fixture.cases[1].expectRefusal).toBe(true);
    expect(fixture.cases[1].observed).toBe("2026-10-27");
  });
});

describe("DF-2026-17 recall benchmark runner (end-to-end, scratch instance)", () => {
  it(
    "executes all 20 cases against a scratch instance and reports every rate with its denominator",
    { timeout: RUN_TIMEOUT_MS },
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df202617-bench-"));
      const jsonPath = path.join(tmp, "report.json");
      try {
        const r = runBenchmark(["--scratch", "--json", jsonPath]);
        expect(r.error).toBeUndefined(); // spawn-level failure / timeout
        // Exit-code contract: 0 (all pass) or 1 (quality misses) — a 2 is
        // an infrastructure failure and this test must say so loudly.
        expect([0, 1]).toContain(r.status);

        const report = readReport(jsonPath);
        expect(report.cases.total).toBe(20);
        expect(report.cases.executed).toBe(20);
        expect(report.seeded).toBe(24);
        expect(report.keyCaseCount).toBe(15);
        expect(report.refusalCaseCount).toBe(5);

        // Every rate carries its numerator AND denominator.
        for (const [name, rate] of Object.entries(report.rates) as [
          string,
          any,
        ][]) {
          expect(typeof rate.numerator, `rates.${name}.numerator`).toBe(
            "number",
          );
          expect(rate.denominator, `rates.${name}.denominator`).toBeGreaterThan(
            0,
          );
        }
        expect(report.rates.casePassRate.denominator).toBe(20);
        expect(report.rates.keyRecallMacro.denominator).toBe(15);
        expect(report.rates.correctRefusalRate.denominator).toBe(5);
        expect(report.rates.unansweredRate.denominator).toBe(20);

        // Unanswered is never correct: every unanswered case is a miss.
        for (const result of report.results) {
          if (result.unanswered) expect(result.verdict).toBe("MISS");
        }

        // Exit code reflects the verdict.
        const expectedExit = report.cases.missed > 0 ? 1 : 0;
        expect(report.exitCode).toBe(expectedExit);
        expect(r.status).toBe(expectedExit);

        // The human report prints the denominators, not just percentages.
        expect(r.stdout).toContain("cases: 20/20 executed");
        expect(r.stdout).toMatch(/case pass rate\s+\d+\/20/);
        expect(r.stdout).toMatch(/correct refusal rate\s+\d+\/5/);
        expect(r.stdout).toContain("verdict:");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it(
    "negative control: a corrupted expected key is reported as a miss and exits 1",
    { timeout: RUN_TIMEOUT_MS },
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df202617-negctl-"));
      const corruptedPath = path.join(tmp, "cases.json");
      const jsonPath = path.join(tmp, "report.json");
      try {
        const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
        // Corrupt case 1: expect a key the corpus never planted.
        fixture.cases[0].expectKeys = ["/sync/coding-hermes/does-not-exist"];
        fs.writeFileSync(
          corruptedPath,
          JSON.stringify(fixture, null, 2),
          "utf-8",
        );

        const r = runBenchmark([
          "--scratch",
          "--cases",
          corruptedPath,
          "--json",
          jsonPath,
        ]);
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(1);

        const report = readReport(jsonPath);
        expect(report.cases.executed).toBe(20);
        expect(report.cases.missed).toBeGreaterThanOrEqual(1);
        const case1 = report.results.find((x: any) => x.id === 1);
        expect(case1.verdict).toBe("MISS");
        expect(case1.missing).toContain("/sync/coding-hermes/does-not-exist");
        // The runner attributes the miss: the corrupted key is flagged as
        // absent from the seeded corpus.
        expect(case1.expectedKeysNotInSeed).toContain(
          "/sync/coding-hermes/does-not-exist",
        );
        expect(r.stdout).toContain("/sync/coding-hermes/does-not-exist");
        expect(r.stdout).toContain("verdict: FAIL");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
