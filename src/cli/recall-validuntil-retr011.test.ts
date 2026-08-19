/**
 * RETR-011 Regression Tests: CLI `recall --historical` and
 * `remember --valid-from/--valid-until`.
 *
 * Guards src/cli/human.ts wiring:
 *   - `recall --historical` is forwarded as historical: true
 *   - no --historical given → no historical key in the tool input
 *   - `recall --help` lists the new flag
 *   - `remember --valid-until=<iso>` / `--valid-from=<iso>` are forwarded
 *     to rememberTool
 *   - no validity flags → no valid_* keys in the tool input
 *   - unknown remember flags are still rejected loudly (typo guard)
 *
 * Both tools are mocked so the tests exercise the CLI wiring only (the
 * tools themselves are covered by recall-validuntil-retr011.test.ts in
 * src/mcp/tools).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { runHumanCLI } from "./human";
import { recallTool } from "../mcp/tools/recall";
import { rememberTool } from "../mcp/tools/remember";

vi.mock("../mcp/tools/recall", async () => {
  const actual = await vi.importActual<typeof import("../mcp/tools/recall")>(
    "../mcp/tools/recall",
  );
  return {
    ...actual,
    recallTool: vi.fn(),
  };
});

vi.mock("../mcp/tools/remember", async () => {
  const actual = await vi.importActual<typeof import("../mcp/tools/remember")>(
    "../mcp/tools/remember",
  );
  return {
    ...actual,
    rememberTool: vi.fn(),
  };
});

afterEach(() => {
  vi.mocked(recallTool).mockReset();
  vi.mocked(recallTool).mockResolvedValue({
    memories: [],
    count: 0,
    total: 0,
  });
  vi.mocked(rememberTool).mockReset();
  vi.mocked(rememberTool).mockResolvedValue({
    success: true,
    id: "test-id",
    key: "/validity/cli",
    partition: "concept/2026-08",
    author: "test@example.com",
    namespace: "default",
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

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describe("RETR-011: CLI recall --historical", () => {
  it("--historical is forwarded as historical: true", async () => {
    await capture(() =>
      runHumanCLI("recall", ["--historical", "--namespace=default"]),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ historical: true }),
    );
  });

  it("--historical combines with --prefix and --domain", async () => {
    await capture(() =>
      runHumanCLI("recall", [
        "--prefix=/validity/",
        "--historical",
        "--namespace=default",
      ]),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "prefix",
        prefix: "/validity/",
        historical: true,
      }),
    );
  });

  it("no --historical given → no historical key in the tool input", async () => {
    await capture(() =>
      runHumanCLI("recall", ["--prefix=/", "--namespace=default"]),
    );
    const args = vi.mocked(recallTool).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("historical");
  });

  it("--help lists the --historical flag", async () => {
    const { logs } = await capture(() => runHumanCLI("recall", ["--help"]));
    expect(logs.join("\n")).toContain("--historical");
  });
});

describe("RETR-011: CLI remember --valid-from/--valid-until", () => {
  it("--valid-until and --valid-from are forwarded to rememberTool", async () => {
    await capture(() =>
      runHumanCLI("remember", [
        "/validity/cli",
        "--domain=concept",
        "--content=CLI write with a window",
        `--valid-until=${PAST}`,
        `--valid-from=${FUTURE}`,
        "--namespace=default",
      ]),
    );
    expect(vi.mocked(rememberTool)).toHaveBeenCalledWith(
      expect.objectContaining({
        valid_from: FUTURE,
        valid_until: PAST,
      }),
    );
  });

  it("--valid-until alone is forwarded (valid_from absent)", async () => {
    await capture(() =>
      runHumanCLI("remember", [
        "/validity/cli",
        "--domain=concept",
        "--content=CLI write expiring",
        `--valid-until=${PAST}`,
        "--namespace=default",
      ]),
    );
    const args = vi.mocked(rememberTool).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(args.valid_until).toBe(PAST);
    expect(args).not.toHaveProperty("valid_from");
  });

  it("no validity flags → no valid_* keys in the tool input", async () => {
    await capture(() =>
      runHumanCLI("remember", [
        "/validity/cli",
        "--domain=concept",
        "--content=CLI write",
        "--namespace=default",
      ]),
    );
    const args = vi.mocked(rememberTool).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("valid_from");
    expect(args).not.toHaveProperty("valid_until");
  });

  it("a typo'd validity flag is still rejected loudly (typo guard intact)", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("remember", [
        "/validity/cli",
        "--domain=concept",
        "--content=CLI write",
        `--validuntil=${PAST}`, // typo: --validuntil, not --valid-until
        "--namespace=default",
      ]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toMatch(/unknown flag '--validuntil'/);
  });
});
