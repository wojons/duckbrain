/**
 * DF-2026-9 regression tests: `status --namespace <name>` (space form).
 *
 * parseArgs only splits a flag on "=", so the space form parsed as
 * `flags.namespace === "true"` and the namespace NAME leaked into the
 * positionals — `status --namespace dogfood1027` printed "Namespace: true"
 * with the config-default path, while `--namespace=dogfood1027` printed the
 * intended namespace and path. statusCommand called parseArgs bare, while
 * recall/search/forget/remember already compensate for the same parser
 * behavior (DOGFOOD-027 / CLI-FIX-001 / CLI-FIX-002).
 *
 * The config is mocked with a NON-default defaultNamespace and a distinct
 * mapping for the flag value, so every assertion proves WHICH namespace the
 * parser resolved — a hardcoded value or a silent default fallback cannot
 * satisfy them. The default case (no flag) asserts the default mapping, which
 * is what makes AC-1/AC-2 non-vacuous.
 *
 * RED-before-fix evidence: AC-1 and AC-2 fail against the pre-fix human.ts
 * (namespace resolved to the literal "true", path fell back to the default);
 * AC-3/AC-4/AC-5 fail too (a dangling flag was accepted silently), and
 * AC-6 is the no-regression guard that passes before and after.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Force a deterministic, NON-"default" config default + a distinct mapping for
// the flag value, unless a test overrides.
vi.mock("../config/index", async () => {
  const actual =
    await vi.importActual<typeof import("../config/index")>("../config/index");
  return {
    ...actual,
    getConfig: vi.fn(() => ({
      ...actual.getConfig(),
      defaultNamespace: "config-default-ns",
      namespaceMappings: {
        "config-default-ns": "/tmp/df2026-9/config-default-ns",
        dogfood1027: "/tmp/df2026-9/dogfood1027",
      },
    })),
  };
});

import { runHumanCLI } from "./human";
import { getConfig } from "../config/index";

const CONFIG_DEFAULT_NS = "config-default-ns";
const FLAG_NS = "dogfood1027";
const FLAG_NS_PATH = "/tmp/df2026-9/dogfood1027";

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

describe("DF-2026-9: status resolves the space-form --namespace value", () => {
  it("harness premise: the config default is not 'default' and the flag namespace is mapped elsewhere", () => {
    const config = getConfig();
    expect(config.defaultNamespace).toBe(CONFIG_DEFAULT_NS);
    expect(config.defaultNamespace).not.toBe(FLAG_NS);
    expect(config.namespaceMappings?.[FLAG_NS]).toBe(FLAG_NS_PATH);
    expect(config.namespaceMappings?.[CONFIG_DEFAULT_NS]).not.toBe(
      FLAG_NS_PATH,
    );
  });

  it("AC-1: --namespace <ns> (space form) selects that namespace and its path", async () => {
    // RED before the fix: printed "Namespace: true" + the default path.
    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("status", ["--namespace", FLAG_NS]),
    );

    expect(rejected).toBe(false);
    expect(errors).toEqual([]);
    expect(logs).toContain(`Namespace: ${FLAG_NS}`);
    expect(logs).toContain(`Path: ${FLAG_NS_PATH}`);
    // Negative controls: no "true" sentinel, no default fallback.
    expect(logs.join("\n")).not.toContain("Namespace: true");
    expect(logs.join("\n")).not.toContain(`Namespace: ${CONFIG_DEFAULT_NS}`);
  });

  it("AC-2: --namespace=<ns> (equals form) is unchanged", async () => {
    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("status", [`--namespace=${FLAG_NS}`]),
    );

    expect(rejected).toBe(false);
    expect(errors).toEqual([]);
    expect(logs).toContain(`Namespace: ${FLAG_NS}`);
    expect(logs).toContain(`Path: ${FLAG_NS_PATH}`);
    expect(logs.join("\n")).not.toContain("Namespace: true");
  });

  it("AC-3: a dangling --namespace (no value) is rejected, never namespace 'true'", async () => {
    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("status", ["--namespace"]),
    );

    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("--namespace");
    expect(errors.join("\n")).toContain("requires a value");
    expect(logs).toEqual([]);
    expect(logs.join("\n")).not.toContain("Namespace: true");
  });

  it("AC-4: an empty --namespace= value is rejected the same way", async () => {
    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("status", ["--namespace="]),
    );

    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("requires a value");
    expect(logs.join("\n")).not.toContain("Namespace: true");
  });

  it("AC-5: a following flag token is not consumed as the value", async () => {
    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("status", ["--namespace", "--help"]),
    );

    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("requires a value");
    expect(logs.join("\n")).not.toContain("Namespace: --help");
    expect(logs.join("\n")).not.toContain("Namespace: true");
  });

  it("AC-6: no flag still falls back to the configured default namespace", async () => {
    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("status", []),
    );

    expect(rejected).toBe(false);
    expect(errors).toEqual([]);
    expect(logs).toContain(`Namespace: ${CONFIG_DEFAULT_NS}`);
    expect(logs).toContain("Path: /tmp/df2026-9/config-default-ns");
  });

  it("AC-7: both forms in one argv resolve the same namespace (last one wins is not 'true')", async () => {
    const { logs, errors, rejected } = await capture(() =>
      runHumanCLI("status", ["--namespace=other", "--namespace", FLAG_NS]),
    );

    expect(rejected).toBe(false);
    expect(errors).toEqual([]);
    expect(logs).toContain(`Namespace: ${FLAG_NS}`);
    expect(logs.join("\n")).not.toContain("Namespace: true");
  });
});

/**
 * DF-2026-9 follow-up: an explicitly named namespace that is NEITHER a key of
 * config.namespaceMappings NOR a directory under the resolved namespaces root
 * used to silently resolve to the hardcoded "./memory/default" fallback and
 * exit 0. It must fail loudly instead (stderr names the namespace, non-zero
 * exit, no "Status: OK", no default path).
 *
 * The namespaces root is isolated to a fresh empty temp dir via
 * DUCKBRAIN_NAMESPACES_PATH (BUG-037 knob, consolidate.test.ts house style),
 * so "absent from the root" is deterministic regardless of what the host tree
 * happens to have on disk.
 */
describe("DF-2026-9: status fails loudly on an unknown explicit --namespace", () => {
  const UNKNOWN_NS = "definitely-not-a-namespace-xyz";
  const DIR_ONLY_NS = "df2026-9-dirconly";

  /** Point the namespaces root at a fresh empty temp dir; returns its path. */
  function isolateNamespacesRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-df2026-9-"));
    process.env.DUCKBRAIN_NAMESPACES_PATH = root;
    return root;
  }

  function restoreNamespacesRoot(saved: string | undefined, root: string) {
    if (saved === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    else process.env.DUCKBRAIN_NAMESPACES_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }

  it("AC-8: space form — unknown namespace exits non-zero, names it, never prints the default path", async () => {
    const saved = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const root = isolateNamespacesRoot();
    try {
      const { logs, errors, rejected } = await capture(() =>
        runHumanCLI("status", ["--namespace", UNKNOWN_NS]),
      );

      expect(rejected).toBe(true);
      expect(errors.join("\n")).toContain(UNKNOWN_NS);
      const out = logs.join("\n");
      expect(out).not.toContain("./memory/default");
      expect(out).not.toContain("Status: OK");
    } finally {
      restoreNamespacesRoot(saved, root);
    }
  });

  it("AC-9: equals form — unknown namespace fails identically to the space form", async () => {
    const saved = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const root = isolateNamespacesRoot();
    try {
      const { logs, errors, rejected } = await capture(() =>
        runHumanCLI("status", [`--namespace=${UNKNOWN_NS}`]),
      );

      expect(rejected).toBe(true);
      expect(errors.join("\n")).toContain(UNKNOWN_NS);
      const out = logs.join("\n");
      expect(out).not.toContain("./memory/default");
      expect(out).not.toContain("Status: OK");
    } finally {
      restoreNamespacesRoot(saved, root);
    }
  });

  it("AC-10: a namespace known only as a directory under the root resolves to its real path", async () => {
    const saved = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const root = isolateNamespacesRoot();
    fs.mkdirSync(path.join(root, DIR_ONLY_NS));
    try {
      const { logs, errors, rejected } = await capture(() =>
        runHumanCLI("status", ["--namespace", DIR_ONLY_NS]),
      );

      expect(rejected).toBe(false);
      expect(errors).toEqual([]);
      expect(logs).toContain(`Namespace: ${DIR_ONLY_NS}`);
      expect(logs).toContain(`Path: ${path.join(root, DIR_ONLY_NS)}`);
      expect(logs).toContain("Status: OK");
      expect(logs.join("\n")).not.toContain("./memory/default");
    } finally {
      restoreNamespacesRoot(saved, root);
    }
  });
});
