/**
 * CLI-FIX-002 regression tests: CLI `remember` normalizes space-form flags.
 *
 * parseArgs only splits flags on "=", so a space-form flag (`--domain concept`)
 * parsed as `flags.domain === "true"` and the VALUE leaked into the positionals.
 * recall/search/forget already compensate via normalizeSpaceFormFlags;
 * rememberCommand called parseArgs bare. Two failure modes:
 *
 *  - `remember /k --domain concept --content "x"` failed loudly (domain was the
 *    string "true" — the tool's own validation rejected it at runtime, but the
 *    CLI built the request wrong).
 *  - `remember /k --domain=concept --namespace myns --content "x"` SILENTLY
 *    wrote into a namespace literally named "true" (`flags.namespace === "true"`
 *    is truthy) while the namespace name "myns" leaked into the positional list.
 *    That is a data-integrity bug, hence the negative control below.
 *
 * The suite drives the CLI with rememberTool mocked and asserts on the CALL
 * ARGS — the CLI's only write path is the tool, so a passing assertion here
 * means the write request carried the right namespace/domain/body; nothing in
 * this file fakes a JSONL side effect.
 *
 * The config default is mocked to a non-"default" value on purpose:
 * src/test-setup.ts points DUCKBRAIN_CONFIG_PATH at an empty temp file, so the
 * live default resolves to zod's "default" fallback and a hardcoded namespace
 * would pass unnoticed (see the harness premise test below).
 *
 * RED-before-fix evidence: AC-1 and AC-2 fail against the pre-fix human.ts
 * (the brief's AC-6); AC-3/AC-4/AC-5 and the fallback/ordering cases are
 * no-regression guards that pass before and after.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock rememberTool before importing the CLI (invocation capture is the point).
vi.mock("../mcp/tools/remember", () => ({
  rememberTool: vi.fn(),
}));

// Force a deterministic, NON-"default" config default unless a test overrides.
vi.mock("../config/index", async () => {
  const actual =
    await vi.importActual<typeof import("../config/index")>("../config/index");
  return {
    ...actual,
    getConfig: vi.fn(() => ({
      ...actual.getConfig(),
      defaultNamespace: "config-default-ns",
    })),
  };
});

import { rememberTool } from "../mcp/tools/remember";
import { runHumanCLI } from "./human";
import { getConfig } from "../config/index";

const CONFIG_DEFAULT_NS = "config-default-ns";

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

function succeed() {
  mockedRememberTool.mockResolvedValue({ success: true, id: "mem-clifix002" });
}

describe("CLI-FIX-002: remember normalizes space-form flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    succeed();
  });

  afterEach(() => {
    vi.mocked(getConfig).mockClear();
  });

  it("harness premise: the config default is not the literal 'default'", () => {
    // Without this, a hardcoded namespace would satisfy the default case.
    expect(CONFIG_DEFAULT_NS).not.toBe("default");
    expect(getConfig().defaultNamespace).toBe(CONFIG_DEFAULT_NS);
  });

  it("AC-1: all-space-form flags parse as values, not 'true' sentinels", async () => {
    // RED before the fix: domain became "true" and both values leaked into
    // the positional list.
    await capture(() =>
      runHumanCLI("remember", [
        "/k",
        "--domain",
        "concept",
        "--content",
        "body",
      ]),
    );

    expect(mockedRememberTool).toHaveBeenCalledTimes(1);
    const [input] = mockedRememberTool.mock.calls[0];
    expect(input.domain).toBe("concept");
    expect(input.domain).not.toBe("true");
    expect(input.embedding_text).toBe("body");
    expect(input.embedding_text).not.toBe("true");
    expect(input.key).toBe("/k");
  });

  it("AC-2: space-form --namespace reaches the tool and never writes namespace 'true'", async () => {
    // RED before the fix: this is the exact silent data-integrity bug —
    // namespace "true" + "myns" leaked into the positionals.
    await capture(() =>
      runHumanCLI("remember", [
        "/k",
        "--domain=concept",
        "--namespace",
        "myns",
        "--content",
        "body",
      ]),
    );

    expect(mockedRememberTool).toHaveBeenCalledTimes(1);
    const [input] = mockedRememberTool.mock.calls[0];
    expect(input.namespace).toBe("myns");
    expect(input.key).toBe("/k");
    expect(input.embedding_text).toBe("body");
    // Negative control — no call anywhere carries the literal "true" as a
    // namespace (or as a domain/body smuggled through a leaked flag).
    expect(mockedRememberTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "true" }),
    );
    expect(mockedRememberTool).toHaveBeenCalledWith({
      key: "/k",
      domain: "concept",
      attributes: {},
      embedding_text: "body",
      namespace: "myns",
    });
  });

  it("AC-3: equals forms are unchanged", async () => {
    await capture(() =>
      runHumanCLI("remember", [
        "/k",
        "--domain=concept",
        "--namespace=myns",
        "--content=body",
      ]),
    );

    expect(mockedRememberTool).toHaveBeenCalledTimes(1);
    expect(mockedRememberTool).toHaveBeenCalledWith({
      key: "/k",
      domain: "concept",
      attributes: {},
      embedding_text: "body",
      namespace: "myns",
    });
  });

  it("AC-4: --wait stays boolean and never consumes the following token", async () => {
    await capture(() =>
      runHumanCLI("remember", [
        "/k",
        "--domain=concept",
        "--wait",
        "--content",
        "body",
        "--namespace=final-ns",
      ]),
    );

    expect(mockedRememberTool).toHaveBeenCalledTimes(1);
    const [input] = mockedRememberTool.mock.calls[0];
    // If --wait had swallowed "--namespace=final-ns", the namespace would
    // have fallen back to the config default instead.
    expect(input.namespace).toBe("final-ns");
    expect(input.embedding_text).toBe("body");
    expect(input.key).toBe("/k");
    expect(mockedRememberTool).toHaveBeenCalledWith({
      key: "/k",
      domain: "concept",
      attributes: {},
      embedding_text: "body",
      namespace: "final-ns",
    });
  });

  it("AC-5: unknown flag (--conent) still exits loudly and never reaches the tool", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("remember", [
        "/k",
        "--conent",
        "x",
        "--domain=concept",
        "--content=body",
      ]),
    );

    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("unknown flag '--conent'");
    expect(mockedRememberTool).not.toHaveBeenCalled();
  });

  it("no --namespace falls back to the config defaultNamespace after normalization", async () => {
    await capture(() =>
      runHumanCLI("remember", [
        "/k",
        "--domain",
        "concept",
        "--content",
        "body",
      ]),
    );

    expect(mockedRememberTool).toHaveBeenCalledTimes(1);
    expect(mockedRememberTool).toHaveBeenCalledWith({
      key: "/k",
      domain: "concept",
      attributes: {},
      embedding_text: "body",
      namespace: CONFIG_DEFAULT_NS,
    });
  });

  it("space-form flag BEFORE the key works too", async () => {
    await capture(() =>
      runHumanCLI("remember", [
        "--namespace",
        "myns",
        "/k",
        "--domain",
        "concept",
        "--content",
        "body",
      ]),
    );

    expect(mockedRememberTool).toHaveBeenCalledTimes(1);
    expect(mockedRememberTool).toHaveBeenCalledWith({
      key: "/k",
      domain: "concept",
      attributes: {},
      embedding_text: "body",
      namespace: "myns",
    });
  });
});
