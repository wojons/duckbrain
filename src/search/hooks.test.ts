/**
 * Tests for the search-index git hook installer (RETR-010) and the Q-7
 * cache doctrine it enforces.
 *
 * Regressions guarded (mirror of src/embedding/hooks.test.ts):
 *  - hooks are installed into .git/hooks with executable bits
 *  - hook scripts invoke `duckbrain search-index rebuild --detached`
 *  - hooks refuse to install when the path is not a git repo
 *  - install is idempotent (overwrite, never duplicate content)
 *  - rebuild is idempotent (two runs, identical result, no error)
 *  - after a rebuild, `git status` stays clean — the `.search/` sidecar
 *    is a gitignored rebuildable cache, not tracked state
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  installSearchHooks,
  searchHooksInstalled,
  SEARCH_SKIP_ENV,
} from "./hooks";
import { rebuildNamespaceIndex } from "./index";

let tmpDir: string;
let repoPath: string;

function writeNamespaceJsonl(
  nsPath: string,
  records: Array<Record<string, unknown>>,
): string {
  const part = path.join(nsPath, "concept", "2026-08");
  fs.mkdirSync(part, { recursive: true });
  const jsonl = path.join(part, "current.jsonl");
  fs.writeFileSync(
    jsonl,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  return jsonl;
}

function memory(
  id: string,
  key: string,
  text: string,
): Record<string, unknown> {
  return {
    id,
    key,
    domain: "concept",
    timestamp: `2026-08-0${id.slice(1)}T00:00:00.000Z`,
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-hooks-"));
  repoPath = path.join(tmpDir, "ns-repo");
  fs.mkdirSync(repoPath, { recursive: true });
  // Init a real git repo so hooks dir exists
  execSync("git init -q", { cwd: repoPath });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("installSearchHooks", () => {
  it("writes all three hooks with executable bits", () => {
    const written = installSearchHooks(repoPath, "test-ns");
    expect(written.length).toBe(3);
    for (const p of written) {
      expect(fs.existsSync(p)).toBe(true);
      const mode = fs.statSync(p).mode;
      expect(mode & 0o111).not.toBe(0); // executable
    }
  });

  it("hook script fires a detached search-index rebuild for the namespace", () => {
    installSearchHooks(repoPath, "test-ns");
    const hook = fs.readFileSync(
      path.join(repoPath, ".git", "hooks", "post-merge"),
      "utf8",
    );
    expect(hook).toContain("search-index rebuild");
    expect(hook).toContain('--namespace "test-ns"');
    expect(hook).toContain("--detached");
    expect(hook).toContain("--log");
    expect(hook).toContain(SEARCH_SKIP_ENV);
    expect(hook).toContain(".search/rebuild.log");
    // cwd normalization: git fires hooks with cwd = the namespace repo root,
    // so the hook steps up to the duckbrain root when the bin is absolute
    // (RETR-010 live regression — hook rebuilds failed with
    // "Namespace not found at namespaces/<ns>" from hook cwd).
    expect(hook).toContain("DUCKBRAIN_ROOT");
    expect(hook).toContain('cd "${DUCKBRAIN_ROOT}"');
  });

  it("searchHooksInstalled reflects installation (content detection)", () => {
    expect(searchHooksInstalled(repoPath)).toBe(false);
    installSearchHooks(repoPath, "test-ns");
    expect(searchHooksInstalled(repoPath)).toBe(true);
  });

  it("install is idempotent — reinstall overwrites, never duplicates", () => {
    installSearchHooks(repoPath, "test-ns");
    const first = fs.readFileSync(
      path.join(repoPath, ".git", "hooks", "post-checkout"),
      "utf8",
    );
    installSearchHooks(repoPath, "test-ns");
    const second = fs.readFileSync(
      path.join(repoPath, ".git", "hooks", "post-checkout"),
      "utf8",
    );
    expect(second).toBe(first);
    expect(second.match(/search-index rebuild/g)).toHaveLength(1);
    expect(searchHooksInstalled(repoPath)).toBe(true);
  });

  it("throws when path is not a git repo", () => {
    const notRepo = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(notRepo, { recursive: true });
    expect(() => installSearchHooks(notRepo, "x")).toThrow(/Not a git repo/);
  });
});

describe("search-index cache doctrine (Q-7)", () => {
  it("rebuild is idempotent — two runs both succeed with identical row counts", async () => {
    writeNamespaceJsonl(repoPath, [
      memory("m1", "/proj/alpha", "alpha memory content"),
      memory("m2", "/proj/beta", "beta memory content"),
    ]);
    const first = await rebuildNamespaceIndex(repoPath);
    const second = await rebuildNamespaceIndex(repoPath);
    expect(first.rowCount).toBe(2);
    expect(second.rowCount).toBe(2);
    expect(second.rowCount).toBe(first.rowCount);
    expect(second.sourceFiles).toBe(first.sourceFiles);
    expect(second.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("git status stays clean after rebuild (sidecar is gitignored)", async () => {
    writeNamespaceJsonl(repoPath, [
      memory("m1", "/proj/alpha", "alpha memory content"),
    ]);
    // The namespace .gitignore already carries the sidecar rule (committed
    // by a prior rebuild — fresh clones inherit it), so the rebuild must
    // not touch it and must not leave untracked files behind.
    fs.writeFileSync(path.join(repoPath, ".gitignore"), "/.search/\n", "utf8");
    execSync("git add -A", { cwd: repoPath });
    execSync(
      "git -c user.name=Test -c user.email=test@example.com commit -qm init",
      { cwd: repoPath },
    );

    await rebuildNamespaceIndex(repoPath);

    const status = execSync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf8",
    });
    expect(status.trim()).toBe("");
    expect(fs.existsSync(path.join(repoPath, ".search", "fts.duckdb"))).toBe(
      true,
    );
  });
});
