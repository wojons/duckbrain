/**
 * RETR-006 Regression Tests: CLI `recall --attr=<name>=<value>`.
 *
 * Guards src/cli/human.ts recallCommand --attr parsing:
 *   - `--attr=<name>=<value>` (repeatable) is forwarded as attr filters
 *   - bare `--attr <name>=<value>` works too
 *   - malformed pairs exit cleanly with a usage message (no stack)
 *   - `recall --help` lists the new flag
 *   - no --attr given → no attr key in the tool input
 *
 * recallTool is mocked so the tests exercise the CLI wiring only (the tool
 * itself is covered by recall-attr-retr006.test.ts in src/mcp/tools).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { runHumanCLI } from "./human";
import { recallTool } from "../mcp/tools/recall";

vi.mock("../mcp/tools/recall", async () => {
  const actual = await vi.importActual<typeof import("../mcp/tools/recall")>(
    "../mcp/tools/recall",
  );
  return {
    ...actual,
    recallTool: vi.fn(),
  };
});

afterEach(() => {
  vi.mocked(recallTool).mockReset();
  vi.mocked(recallTool).mockResolvedValue({
    memories: [],
    count: 0,
    total: 0,
  });
});

/** Capture console.log/console.error lines for the duration of fn.
 * process.exit(1) surfaces as a throw under vitest (same pattern as
 * recall-asof-retr004.test.ts) — swallowed here so callers can assert the
 * usage message; `rejected` records that the exit happened. */
async function capture(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[]; rejected: boolean }> {
  const logs: string[] = [];
  const errors: string[] = [];
  let rejected = false;
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: any[]) => logs.push(a.map(String).join(" ")));
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: any[]) => errors.push(a.map(String).join(" ")));
  try {
    await fn();
  } catch {
    rejected = true;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { logs, errors, rejected };
}

describe("RETR-006: CLI recall --attr", () => {
  it('--attr=domain=config is forwarded as attr: {domain: "config"}', async () => {
    await capture(() =>
      runHumanCLI("recall", ["--attr=domain=config", "--namespace=default"]),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ attr: { domain: "config" } }),
    );
  });

  it("repeatable --attr flags forward every pair", async () => {
    await capture(() =>
      runHumanCLI("recall", [
        "--attr=domain=config",
        "--attr=tick=403",
        "--namespace=default",
      ]),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ attr: { domain: "config", tick: "403" } }),
    );
  });

  it("bare `--attr <name>=<value>` works too", async () => {
    await capture(() =>
      runHumanCLI("recall", ["--attr", "domain=config", "--namespace=default"]),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ attr: { domain: "config" } }),
    );
  });

  it("--attr combines with --prefix and --domain", async () => {
    await capture(() =>
      runHumanCLI("recall", [
        "--prefix=/cfg/",
        "--attr=tick=403",
        "--namespace=default",
      ]),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "prefix",
        prefix: "/cfg/",
        attr: { tick: "403" },
      }),
    );
  });

  it("no --attr given → no attr key in the tool input", async () => {
    await capture(() =>
      runHumanCLI("recall", ["--prefix=/", "--namespace=default"]),
    );
    const args = vi.mocked(recallTool).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("attr");
  });

  it("a missing value exits cleanly with a usage message", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("recall", ["--attr=domain=", "--namespace=default"]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toMatch(/--attr must be <name>=<value>/);
  });

  it("a missing name exits cleanly with a usage message", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("recall", ["--attr==x", "--namespace=default"]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toMatch(/--attr must be <name>=<value>/);
  });

  it("a bare --attr with no pair exits cleanly with a usage message", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("recall", ["--attr", "--limit=5", "--namespace=default"]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toMatch(/--attr requires <name>=<value>/);
  });

  it("--help lists the --attr flag", async () => {
    const { logs } = await capture(() => runHumanCLI("recall", ["--help"]));
    expect(logs.join("\n")).toContain("--attr=<name>=<value>");
  });
});
