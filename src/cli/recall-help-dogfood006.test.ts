/**
 * DOGFOOD-006 Regression Tests: `recall --help` and --namespace help wording.
 *
 * Two dogfood findings are guarded here:
 *
 *  (a) `duckbrain recall --help` used to IGNORE --help and run a live query
 *      (recallCommand never checked for it). It must now print usage and
 *      return without touching recallTool.
 *  (b) the top-level help claimed `--namespace (default: default)`, but the
 *      real default is the config's defaultNamespace. The help text must
 *      describe the real default instead of hardcoding 'default'.
 *
 * The tests capture console.log output; the "no query ran" assertion checks
 * that no recall output ("Found N memories" / "No memories found") was
 * printed, which is exactly what a live query would have emitted.
 */

import { describe, it, expect, afterEach } from "vitest";
import { runHumanCLI } from "./human";

/** Capture console.log lines for the duration of fn. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => {
    lines.push(a.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return lines;
}

afterEach(() => {
  // Safety net: captureLogs restores in finally, this guards future edits.
});

describe("DOGFOOD-006: recall --help", () => {
  it("(a) recall --help prints usage and does NOT run a query", async () => {
    const lines = await captureLogs(() => runHumanCLI("recall", ["--help"]));
    const out = lines.join("\n");
    expect(out).toMatch(/Usage: duckbrain recall/);
    // A live query would have printed one of these:
    expect(out).not.toMatch(/Found \d+ memories/);
    expect(out).not.toMatch(/No memories found/);
  });

  it("(a) recall -h prints usage and does NOT run a query", async () => {
    const lines = await captureLogs(() => runHumanCLI("recall", ["-h"]));
    const out = lines.join("\n");
    expect(out).toMatch(/Usage: duckbrain recall/);
    expect(out).not.toMatch(/Found \d+ memories/);
    expect(out).not.toMatch(/No memories found/);
  });

  it("(b) top-level help describes the real --namespace default (config defaultNamespace)", async () => {
    const lines = await captureLogs(() => runHumanCLI("help", []));
    const out = lines.join("\n");
    expect(out).toContain("--namespace=NAME");
    expect(out).not.toContain(
      "--namespace=NAME   Select namespace (default: default)",
    );
    expect(out).toMatch(/--namespace=NAME.*config defaultNamespace/);
  });
});
