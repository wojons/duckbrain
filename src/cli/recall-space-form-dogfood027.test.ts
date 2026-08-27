/**
 * DOGFOOD-027 + CLI-FIX-001 Regression Tests: recall space-form flags.
 *
 * Guards src/cli/human.ts recallCommand space-form flag normalization:
 *   - `recall --namespace <ns>` (space form) selects the RIGHT namespace
 *     instead of silently running with namespace="true" (DOGFOOD-027)
 *   - `recall --namespace=<ns>` (equals form) is unchanged
 *   - `recall --as-of <ref>` (space form) resolves the ref instead of
 *     failing with "Invalid --as-of value 'true'" (CLI-FIX-001)
 *   - `recall --as-of=<ref>` (equals form) is unchanged
 *
 * recallTool and resolveAsOfRef are mocked so the tests exercise the CLI
 * parsing/wiring only (the tool + git resolution are covered by their own
 * suites). resolveAsOfRef returns a fixed SHA so the assertion proves the
 * flag VALUE reached the resolver — never the literal "true".
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { runHumanCLI } from "./human";
import { recallTool } from "../mcp/tools/recall";
import { resolveAsOfRef } from "../git/asof";

vi.mock("../mcp/tools/recall", async () => {
  const actual = await vi.importActual<typeof import("../mcp/tools/recall")>(
    "../mcp/tools/recall",
  );
  return {
    ...actual,
    recallTool: vi.fn(),
  };
});

vi.mock("../git/asof", async () => {
  const actual =
    await vi.importActual<typeof import("../git/asof")>("../git/asof");
  return {
    ...actual,
    resolveAsOfRef: vi.fn(),
  };
});

const RESOLVED_SHA = "9f8e7d6c5b4a39281706050403020100abcdef12";

afterEach(() => {
  vi.mocked(recallTool).mockReset();
  vi.mocked(recallTool).mockResolvedValue({
    memories: [],
    count: 0,
    total: 0,
  });
  vi.mocked(resolveAsOfRef).mockReset();
  vi.mocked(resolveAsOfRef).mockReturnValue(RESOLVED_SHA);
});

/** Capture console.log/console.error lines for the duration of fn. */
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

describe("DOGFOOD-027 + CLI-FIX-001: recall space-form flags", () => {
  it("--namespace <ns> (space form) selects the right namespace, no 'true' anywhere", async () => {
    await capture(() =>
      runHumanCLI("recall", ["--prefix=/", "--namespace", "dogfood-scratch"]),
    );
    // Exact input equality — the namespace name must not leak into
    // positional/key/prefix, and namespace must be the real value.
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith({
      namespace: "dogfood-scratch",
      limit: 10,
      mode: "prefix",
      prefix: "/",
    });
    expect(vi.mocked(recallTool)).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "true" }),
    );
  });

  it("--namespace=<ns> (equals form) is unchanged", async () => {
    await capture(() =>
      runHumanCLI("recall", ["--prefix=/", "--namespace=dogfood-scratch"]),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith({
      namespace: "dogfood-scratch",
      limit: 10,
      mode: "prefix",
      prefix: "/",
    });
  });

  it("--as-of <ref> (space form) resolves the ref, not 'true'", async () => {
    const { logs, errors } = await capture(() =>
      runHumanCLI("recall", [
        "--prefix=/",
        "--namespace=default",
        "--as-of",
        "2026-08-10",
      ]),
    );
    // The ref value reaches the resolver — never the literal "true".
    expect(vi.mocked(resolveAsOfRef)).toHaveBeenCalledWith(
      "2026-08-10",
      expect.any(String),
    );
    expect(vi.mocked(resolveAsOfRef)).not.toHaveBeenCalledWith(
      "true",
      expect.any(String),
    );
    // The RESOLVED commit flows through to the tool.
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: RESOLVED_SHA }),
    );
    // No "Invalid --as-of value 'true'" failure.
    expect(errors.join("\n")).not.toContain("Invalid --as-of value 'true'");
    expect(logs.join("\n")).toContain("No memories found");
  });

  it("--as-of=<ref> (equals form) is unchanged", async () => {
    await capture(() =>
      runHumanCLI("recall", [
        "--prefix=/",
        "--namespace=default",
        "--as-of=2026-08-10",
      ]),
    );
    expect(vi.mocked(resolveAsOfRef)).toHaveBeenCalledWith(
      "2026-08-10",
      expect.any(String),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: RESOLVED_SHA }),
    );
  });

  it("both space forms together are normalized in one invocation", async () => {
    await capture(() =>
      runHumanCLI("recall", [
        "--prefix=/",
        "--namespace",
        "dogfood-scratch",
        "--as-of",
        "2026-08-10",
      ]),
    );
    expect(vi.mocked(recallTool)).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "dogfood-scratch",
        asOf: RESOLVED_SHA,
      }),
    );
    expect(vi.mocked(recallTool)).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "true" }),
    );
  });
});
