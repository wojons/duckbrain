/**
 * DF-2026-1 regression tests: `remember` error discoverability + `--help`.
 *
 * Two user-facing defects are pinned here:
 *
 *  (1) `duckbrain remember <key> --content=… --namespace=…` (no --domain)
 *      failed with zod's bare `Invalid option: expected one of "person"|…`.
 *      The message listed the allowed values but never named the flag that
 *      carries the choice, so the flag contract was undiscoverable at the
 *      exact moment it mattered. The printed error must now name
 *      `--domain=<d>` while still failing — the validation itself is NOT
 *      changed (same failure, same exit, original message text preserved).
 *
 *  (2) `duckbrain remember --help` was rejected as an unknown flag while
 *      sibling verbs (recall/search/forget/namespaces/token) printed usage.
 *      `--help` / `-h` must print usage and return without touching the
 *      write path.
 *
 * The real `rememberTool` is wrapped in a spy (not replaced) so the domain
 * failure exercised below is the ACTUAL upstream message rather than a
 * hand-written fixture. With an omitted/invalid domain the tool returns
 * before any id is minted, so the failing cases cannot write anything.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../mcp/tools/remember", async () => {
  const actual =
    await vi.importActual<typeof import("../mcp/tools/remember")>(
      "../mcp/tools/remember",
    );
  return { ...actual, rememberTool: vi.fn(actual.rememberTool) };
});

import { rememberTool } from "../mcp/tools/remember";
import { runHumanCLI, withDomainFlagHint } from "./human";

const mockedRememberTool = vi.mocked(rememberTool);

/** Capture console output and whether the command bailed via process.exit. */
async function capture(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[]; rejected: boolean }> {
  const logs: string[] = [];
  const errors: string[] = [];
  let rejected = false;
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
  try {
    await fn();
  } catch {
    // Vitest turns an unexpected process.exit() into a throw.
    rejected = true;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { logs, errors, rejected };
}

describe("DF-2026-1 (1): the domain failure names --domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(rememberTool).mockReset();
  });

  it("AC-1: omitting --domain errors with a message containing '--domain='", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("remember", [
        "testkey",
        "--content=test",
        "--namespace=scratch",
      ]),
    );

    const stderr = errors.join("\n");
    expect(rejected).toBe(true);
    expect(stderr).toContain("--domain=");
    // The original validation text survives — only the flag contract is added.
    expect(stderr).toMatch(/Invalid option/i);
    expect(stderr).toContain("raw_note");
    // The hint names the flag exactly once (no accidental double append).
    expect(stderr.split("--domain=").length - 1).toBe(1);
  });

  it("AC-1: the failing call still reaches the tool exactly once (validation unchanged)", async () => {
    await capture(() =>
      runHumanCLI("remember", [
        "testkey",
        "--content=test",
        "--namespace=scratch",
      ]),
    );

    expect(mockedRememberTool).toHaveBeenCalledTimes(1);
    const [input] = mockedRememberTool.mock.calls[0];
    // The CLI still defaults the domain — this fix is message-level only.
    expect(input.domain).toBe("general");
    expect(input.key).toBe("testkey");
  });

  it("an explicitly bogus --domain also names the flag", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("remember", [
        "testkey",
        "--domain=nope",
        "--content=test",
        "--namespace=scratch",
      ]),
    );

    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("--domain=");
  });

  it("negative control: an unrelated failure message is left untouched", async () => {
    mockedRememberTool.mockResolvedValueOnce({
      success: false,
      error: "Namespace 'nope' does not exist",
    });

    const { errors, rejected } = await capture(() =>
      runHumanCLI("remember", [
        "testkey",
        "--domain=concept",
        "--content=test",
        "--namespace=nope",
      ]),
    );

    const stderr = errors.join("\n");
    expect(rejected).toBe(true);
    expect(stderr).toContain("Namespace 'nope' does not exist");
    expect(stderr).not.toContain("--domain=");
  });

  it("a valid --domain still writes through the tool (no regression)", async () => {
    mockedRememberTool.mockResolvedValueOnce({
      success: true,
      id: "mem-df2026-1",
    });

    const { logs } = await capture(() =>
      runHumanCLI("remember", [
        "testkey",
        "--domain=concept",
        "--content=test",
        "--namespace=scratch",
      ]),
    );

    expect(mockedRememberTool).toHaveBeenCalledTimes(1);
    expect(mockedRememberTool).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "testkey",
        domain: "concept",
        embedding_text: "test",
        namespace: "scratch",
        attributes: {},
      }),
    );
    expect(logs.join("\n")).toContain("✓ Remembered testkey");
  });

  it("withDomainFlagHint is idempotent and only touches the domain enum failure", () => {
    const domainMessage =
      'Invalid input: Invalid option: expected one of "person"|"event"|"concept"|"message"|"config"|"raw_note"';
    const hinted = withDomainFlagHint(domainMessage);

    expect(hinted).toContain("--domain=<d>");
    expect(hinted).toContain("person|event|concept|message|config|raw_note");
    expect(withDomainFlagHint(hinted)).toBe(hinted);

    const other = "Error: --attr must be valid JSON";
    expect(withDomainFlagHint(other)).toBe(other);
  });
});

describe("DF-2026-1 (2): remember --help", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(rememberTool).mockReset();
  });

  it("AC-2: `remember --help` prints usage and exits 0 (no process.exit)", async () => {
    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("remember", ["--help"]),
    );

    const stdout = logs.join("\n");
    expect(rejected).toBe(false);
    expect(errors.join("\n")).not.toContain("unknown flag");
    expect(stdout).toContain("Usage: duckbrain remember <key> [options]");
    expect(stdout).toContain("--domain=<d>");
    expect(stdout).toContain("--help, -h");
    // Help must not touch the write path.
    expect(mockedRememberTool).not.toHaveBeenCalled();
  });

  it("AC-2: `remember -h` behaves the same", async () => {
    const { logs, rejected } = await capture(() =>
      runHumanCLI("remember", ["-h"]),
    );

    expect(rejected).toBe(false);
    expect(logs.join("\n")).toContain("Usage: duckbrain remember");
    expect(mockedRememberTool).not.toHaveBeenCalled();
  });

  it("help wins even when other arguments are present", async () => {
    const { logs, rejected } = await capture(() =>
      runHumanCLI("remember", ["testkey", "--content=test", "--help"]),
    );

    expect(rejected).toBe(false);
    expect(logs.join("\n")).toContain("Usage: duckbrain remember");
    expect(mockedRememberTool).not.toHaveBeenCalled();
  });

  it("unknown flags other than help are still rejected", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("remember", [
        "testkey",
        "--conent=x",
        "--domain=concept",
        "--content=test",
      ]),
    );

    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("unknown flag '--conent'");
    expect(mockedRememberTool).not.toHaveBeenCalled();
  });
});
