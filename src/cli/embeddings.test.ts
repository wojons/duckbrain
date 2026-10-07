/**
 * Tests for `duckbrain embeddings` CLI arg parsing.
 *
 * Regressions guarded:
 *  - both `--namespace=X` and `--namespace X` forms parse (git hooks use the
 *    space form — a missed form silently fell back to the default namespace)
 *  - --detached / --force / --concurrency / --log parse correctly
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "./embeddings";

describe("parseArgs", () => {
  it("parses the namespace with = form", () => {
    const a = parseArgs(["rebuild", "--namespace=my-ns"]);
    expect(a.action).toBe("rebuild");
    expect(a.namespace).toBe("my-ns");
  });

  it("parses the namespace with space form (git-hook style)", () => {
    const a = parseArgs(["rebuild", "--namespace", "my-ns"]);
    expect(a.namespace).toBe("my-ns");
  });

  it("space form does NOT swallow the next flag", () => {
    const a = parseArgs(["rebuild", "--namespace", "my-ns", "--detached"]);
    expect(a.namespace).toBe("my-ns");
    expect(a.detached).toBe(true);
  });

  it("parses force + concurrency + log", () => {
    const a = parseArgs([
      "rebuild",
      "--force",
      "--concurrency=8",
      "--log=/tmp/rebuild.log",
    ]);
    expect(a.force).toBe(true);
    expect(a.concurrency).toBe(8);
    expect(a.log).toBe("/tmp/rebuild.log");
  });

  it("parses concurrency and log with space forms", () => {
    const a = parseArgs([
      "rebuild",
      "--concurrency",
      "2",
      "--log",
      "/tmp/l.log",
    ]);
    expect(a.concurrency).toBe(2);
    expect(a.log).toBe("/tmp/l.log");
  });

  it("defaults action to status when missing", () => {
    const a = parseArgs([]);
    expect(a.action).toBe("status");
  });

  it("exact hook invocation round-trips", () => {
    const a = parseArgs([
      "embeddings",
      "rebuild",
      "--namespace",
      "test-ns",
      "--detached",
      "--log",
      ".embeddings/rebuild.log",
    ]);
    expect(a.action).toBe("embeddings");
    expect(a.namespace).toBe("test-ns");
    expect(a.detached).toBe(true);
    expect(a.log).toBe(".embeddings/rebuild.log");
  });

  it("parses migrate with = form (DB-GAP-054)", () => {
    const a = parseArgs(["migrate", "--namespace=my-ns"]);
    expect(a.action).toBe("migrate");
    expect(a.namespace).toBe("my-ns");
  });
});

// GAP-063b — resolveNamespacePath must resolve namespaceMappings values
// relative to the DUCKBRAIN ROOT (they are written as "namespaces/<ns>"),
// not relative to the namespaces dir (which doubled the path to
// <root>/namespaces/namespaces/<ns> and failed for every mapped namespace).
describe("resolveNamespacePath (GAP-063b)", () => {
  it("resolves a mapped namespace against the duckbrain root", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gap063b-"));
    try {
      const nsDir = path.join(tmp, "namespaces", "mapped-ns");
      fs.mkdirSync(nsDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "duckbrain.config.json"),
        JSON.stringify({
          defaultNamespace: "mapped-ns",
          namespacesPath: "./namespaces",
          namespaceMappings: { "mapped-ns": "namespaces/mapped-ns" },
        }),
      );
      const { resolveNamespacePath } = await import("./embeddings.js");
      // Point config discovery at the temp root: DUCKBRAIN_CONFIG_PATH makes
      // resolveDuckbrainRoot() return `tmp`, so getConfig reads our temp config.
      const prev = process.env.DUCKBRAIN_CONFIG_PATH;
      process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmp, "duckbrain.config.json");
      try {
        const { name, nsPath } = resolveNamespacePath("mapped-ns");
        expect(name).toBe("mapped-ns");
        expect(nsPath).toBe(nsDir);
      } finally {
        if (prev === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
        else process.env.DUCKBRAIN_CONFIG_PATH = prev;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
