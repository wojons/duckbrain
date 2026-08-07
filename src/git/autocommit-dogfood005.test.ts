/**
 * DOGFOOD-005 Regression Tests: implicitly-created namespaces get git.
 *
 * Regressions guarded:
 *  - First write to a namespace that has no .git (the implicit-creation case:
 *    CLI remember or REST POST with no prior create_namespace) MUST initialize
 *    the git repo AND produce an initial commit SYNCHRONOUSLY — not deferred
 *    to the 30s debounced timer that a short-lived CLI process never waits
 *    for.
 *  - Subsequent writes to the same namespace MUST still debounce (batching
 *    preserved — no per-write commit storm).
 *  - The fix works whether the entry point is the low-level commitNamespace
 *    helper or the full rememberTool write path (the actual repro path).
 *
 * Isolation: every namespace lives under DUCKBRAIN_NAMESPACES_PATH (the temp
 * root set by src/test-setup.ts). The config FILE is the real
 * duckbrain.config.json at the repo root (tools hardcode configDir "."), so
 * each test snapshots + restores it — same pattern as
 * namespace-delete-dogfood004.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  commitNamespaceWithParams,
  flushAllCommits,
  type BatchingParams,
} from "./autocommit";
import { rememberTool } from "../mcp/tools/remember";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const params30: BatchingParams = {
  maxLines: 100,
  maxSeconds: 30,
  enabled: true,
};

function gitLogCount(dir: string): number {
  try {
    return parseInt(
      execSync("git rev-list --count HEAD", { cwd: dir, stdio: "pipe" })
        .toString()
        .trim(),
      10,
    );
  } catch {
    return 0;
  }
}

describe("DOGFOOD-005: first write to a non-existent namespace inits git", () => {
  it("commitNamespaceWithParams creates .git + initial commit on first write", () => {
    const ns = path.join(NS_ROOT, "dogfood005-unit");
    fs.rmSync(ns, { recursive: true, force: true });
    try {
      expect(fs.existsSync(path.join(ns, ".git"))).toBe(false);

      // Create the namespace dir + write a file, then call the committer
      // (the exact implicit-creation path: dir exists, no .git).
      fs.mkdirSync(ns, { recursive: true });
      fs.writeFileSync(path.join(ns, "current.jsonl"), '{"k":"v"}\n', "utf8");
      commitNamespaceWithParams(ns, "chore: test first write", params30);

      // .git MUST exist now (not deferred to the debounce timer).
      expect(fs.existsSync(path.join(ns, ".git"))).toBe(true);
      // At least one commit MUST exist.
      expect(gitLogCount(ns)).toBeGreaterThanOrEqual(1);

      // The committed content must include the file we wrote.
      const files = execSync("git ls-tree -r --name-only HEAD", {
        cwd: ns,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(files).toContain("current.jsonl");
    } finally {
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });

  it("subsequent writes still debounce (batching preserved)", () => {
    const ns = path.join(NS_ROOT, "dogfood005-batching");
    fs.rmSync(ns, { recursive: true, force: true });
    fs.mkdirSync(ns, { recursive: true });
    try {
      // First write: immediate commit (no .git yet).
      fs.writeFileSync(path.join(ns, "a.txt"), "one", "utf8");
      commitNamespaceWithParams(ns, "chore: first", params30);
      const firstCount = gitLogCount(ns);
      expect(firstCount).toBeGreaterThanOrEqual(1);

      // Second write: should enter the debounce window (NOT commit yet).
      fs.writeFileSync(path.join(ns, "b.txt"), "two", "utf8");
      commitNamespaceWithParams(ns, "chore: second", params30);
      expect(gitLogCount(ns)).toBe(firstCount); // still same count

      // Third write: still in the window.
      fs.writeFileSync(path.join(ns, "c.txt"), "three", "utf8");
      commitNamespaceWithParams(ns, "chore: third", params30);
      expect(gitLogCount(ns)).toBe(firstCount); // still debouncing

      // Flush the window — now we get one additional commit for b + c.
      flushAllCommits();
      expect(gitLogCount(ns)).toBe(firstCount + 1);

      // All three files present in history.
      const files = execSync("git ls-tree -r --name-only HEAD", {
        cwd: ns,
        stdio: "pipe",
      })
        .toString()
        .trim()
        .split("\n")
        .sort();
      expect(files).toEqual(["a.txt", "b.txt", "c.txt"]);
    } finally {
      fs.rmSync(ns, { recursive: true, force: true });
    }
  });
});

/**
 * Full end-to-end test through the actual repro path: rememberTool writing to
 * a namespace that was never explicitly created. This exercises
 * resolveNamespacePath -> mkdir -> JSONL write -> commitNamespace with the real
 * config (snapshotted/restored).
 */
const CONFIG_PATH = path.join(process.cwd(), "duckbrain.config.json");
let configSnapshot: string;

beforeEach(() => {
  configSnapshot = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf-8")
    : "";
});

afterEach(() => {
  // Restore the real config file so the test never leaks mappings.
  if (configSnapshot) {
    fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
});

describe("DOGFOOD-005: rememberTool implicit-namespace write inits git", () => {
  it("writing via rememberTool to a new namespace creates .git + initial commit", async () => {
    const nsName = "dogfood005-remember";
    const ns = path.join(NS_ROOT, nsName);
    fs.rmSync(ns, { recursive: true, force: true });
    // Ensure the namespace is NOT registered in config (implicit creation).
    expect(fs.existsSync(ns)).toBe(false);

    const result = await rememberTool({
      key: "/test/dogfood005",
      domain: "raw_note",
      attributes: { source: "dogfood005-test" },
      embedding_text: "DOGFOOD-005 regression: implicit namespace git init",
      namespace: nsName,
    });

    expect(result.success).toBe(true);

    // The namespace dir now exists.
    expect(fs.existsSync(ns)).toBe(true);
    // .git was initialized synchronously.
    expect(fs.existsSync(path.join(ns, ".git"))).toBe(true);
    // At least one commit exists (git rev-list works).
    expect(gitLogCount(ns)).toBeGreaterThanOrEqual(1);

    // The JSONL memory file is tracked in git history.
    const trackedFiles = execSync("git ls-tree -r --name-only HEAD", {
      cwd: ns,
      stdio: "pipe",
    })
      .toString()
      .trim()
      .split("\n");
    const jsonlFiles = trackedFiles.filter((f) => f.endsWith(".jsonl"));
    expect(jsonlFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("git identity is configured on the implicitly-created repo", async () => {
    const nsName = "dogfood005-identity";
    const ns = path.join(NS_ROOT, nsName);
    fs.rmSync(ns, { recursive: true, force: true });

    await rememberTool({
      key: "/test/dogfood005-identity",
      domain: "raw_note",
      attributes: {},
      embedding_text: "identity check",
      namespace: nsName,
    });

    // The repo must have user.email + user.name set so future commits work.
    const email = execSync("git config user.email", {
      cwd: ns,
      stdio: "pipe",
    })
      .toString()
      .trim();
    const name = execSync("git config user.name", {
      cwd: ns,
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(email.length).toBeGreaterThan(0);
    expect(name.length).toBeGreaterThan(0);
  });
});
