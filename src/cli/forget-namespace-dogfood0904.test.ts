/**
 * DOGFOOD-0904-01 regression tests: CLI `forget` honors `--namespace`.
 *
 * The CLI hardcoded `namespace: "default"` when calling forgetTool, so
 * `duckbrain forget --id <uuid> --namespace=<ns>` failed for every other
 * namespace with `Namespace 'default' not found` and the tombstone never
 * landed (the MCP tool was unaffected). It also never normalized the space
 * form, so `--namespace <ns>` put the namespace name in the positional id
 * slot. This suite drives the CLI with forgetTool mocked and asserts on the
 * CALL ARGS — the CLI's only write path is the tool, so a passing assertion
 * here means the tombstone request carried the right namespace; nothing in
 * this file fakes a JSONL side effect.
 *
 * The config default is mocked to a non-"default" value on purpose:
 * src/test-setup.ts points DUCKBRAIN_CONFIG_PATH at an empty temp file, so
 * the live default resolves to zod's "default" fallback and a hardcoded
 * namespace would pass unnoticed (see the harness premise test below).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock forgetTool before importing the CLI (invocation capture is the point).
vi.mock("../mcp/tools/forget", () => ({
  forgetTool: vi.fn(),
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

import { forgetTool } from "../mcp/tools/forget";
import { runHumanCLI } from "./human";
import { getConfig } from "../config/index";

const CONFIG_DEFAULT_NS = "config-default-ns";
const MEMORY_ID = "3f2a1c84-77b5-4d18-9a6e-0c4de9f1b7aa";

const mockedForgetTool = vi.mocked(forgetTool);

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
  mockedForgetTool.mockResolvedValue({ success: true, tombstoned: true });
}

describe("DOGFOOD-0904-01: CLI forget honors --namespace", () => {
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

  it("--namespace=<ns> (equals form) reaches the tool", async () => {
    await capture(() =>
      runHumanCLI("forget", [MEMORY_ID, "--namespace=custom-ns"]),
    );

    expect(mockedForgetTool).toHaveBeenCalledTimes(1);
    expect(mockedForgetTool).toHaveBeenCalledWith({
      id: MEMORY_ID,
      namespace: "custom-ns",
      reason: "User requested",
    });
    // The old hardcoded value must never reach the tool again.
    expect(mockedForgetTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "default" }),
    );
  });

  it("--namespace <ns> (space form) works and does not leak into the id", async () => {
    await capture(() =>
      runHumanCLI("forget", [MEMORY_ID, "--namespace", "custom-ns"]),
    );

    expect(mockedForgetTool).toHaveBeenCalledTimes(1);
    const [input] = mockedForgetTool.mock.calls[0];
    expect(input.id).toBe(MEMORY_ID);
    expect(input.namespace).toBe("custom-ns");
    // parseArgs only splits on "=", so an un-normalized space form would have
    // set namespace="true" and pushed "custom-ns" into the positional id.
    expect(input.namespace).not.toBe("true");
    expect(input.id).not.toContain("custom-ns");
    expect(mockedForgetTool).toHaveBeenCalledWith({
      id: MEMORY_ID,
      namespace: "custom-ns",
      reason: "User requested",
    });
  });

  it("space form works with the flag BEFORE the id too", async () => {
    await capture(() =>
      runHumanCLI("forget", ["--namespace", "custom-ns", MEMORY_ID]),
    );

    expect(mockedForgetTool).toHaveBeenCalledTimes(1);
    expect(mockedForgetTool).toHaveBeenCalledWith({
      id: MEMORY_ID,
      namespace: "custom-ns",
      reason: "User requested",
    });
  });

  it("no --namespace falls back to the config defaultNamespace", async () => {
    await capture(() => runHumanCLI("forget", [MEMORY_ID]));

    expect(mockedForgetTool).toHaveBeenCalledTimes(1);
    expect(mockedForgetTool).toHaveBeenCalledWith({
      id: MEMORY_ID,
      namespace: CONFIG_DEFAULT_NS,
      reason: "User requested",
    });
  });

  it("--reason is still honored alongside --namespace", async () => {
    await capture(() =>
      runHumanCLI("forget", [
        MEMORY_ID,
        "--namespace=custom-ns",
        "--reason=obsolete",
      ]),
    );

    expect(mockedForgetTool).toHaveBeenCalledTimes(1);
    expect(mockedForgetTool).toHaveBeenCalledWith({
      id: MEMORY_ID,
      namespace: "custom-ns",
      reason: "obsolete",
    });
  });

  it("reports success only after the tool actually succeeds", async () => {
    const { logs } = await capture(() => runHumanCLI("forget", [MEMORY_ID]));

    expect(mockedForgetTool).toHaveBeenCalledTimes(1);
    // The success line is emitted from the tool's own result — the CLI writes
    // no tombstone of its own.
    expect(logs.join("\n")).toContain(`✓ Forgotten ${MEMORY_ID}`);
  });

  it("does not print success when the tool fails (no faked tombstone)", async () => {
    mockedForgetTool.mockResolvedValue({
      success: false,
      error: "Namespace 'custom-ns' not found",
    });

    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("forget", [MEMORY_ID, "--namespace=custom-ns"]),
    );

    expect(rejected).toBe(true);
    expect(logs.join("\n")).not.toContain("Forgotten");
    expect(errors.join("\n")).toContain("Namespace 'custom-ns' not found");
  });

  it("usage text documents --namespace when the id is missing", async () => {
    const { errors, rejected } = await capture(() => runHumanCLI("forget", []));

    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("--namespace=<name>");
    expect(mockedForgetTool).not.toHaveBeenCalled();
  });
});
