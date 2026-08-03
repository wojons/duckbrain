/**
 * Tests for the git hook installer.
 *
 * Regressions guarded:
 *  - hooks are installed into .git/hooks with executable bits
 *  - hook scripts invoke `duckbrain embeddings rebuild --detached`
 *  - hooks refuse to install when the path is not a git repo
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  installEmbeddingHooks,
  embeddingHooksInstalled,
  resolveDuckbrainBin,
} from "./hooks";
import { execSync } from "child_process";

let tmpDir: string;
let repoPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-hooks-"));
  repoPath = path.join(tmpDir, "ns-repo");
  fs.mkdirSync(repoPath, { recursive: true });
  // Init a real git repo so hooks dir exists
  execSync("git init -q", { cwd: repoPath });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("installEmbeddingHooks", () => {
  it("writes all three hooks with executable bits", () => {
    const written = installEmbeddingHooks(repoPath, "test-ns");
    expect(written.length).toBe(3);
    for (const p of written) {
      expect(fs.existsSync(p)).toBe(true);
      const mode = fs.statSync(p).mode;
      expect(mode & 0o111).not.toBe(0); // executable
    }
  });

  it("hook script fires a detached rebuild for the namespace", () => {
    installEmbeddingHooks(repoPath, "test-ns");
    const hook = fs.readFileSync(
      path.join(repoPath, ".git", "hooks", "post-merge"),
      "utf8",
    );
    expect(hook).toContain("embeddings rebuild");
    expect(hook).toContain('--namespace "test-ns"');
    expect(hook).toContain("--detached");
    expect(hook).toContain("DUCKBRAIN_SKIP_EMBED_REBUILD");
  });

  it("embeddingHooksInstalled reflects installation", () => {
    expect(embeddingHooksInstalled(repoPath)).toBe(false);
    installEmbeddingHooks(repoPath, "test-ns");
    expect(embeddingHooksInstalled(repoPath)).toBe(true);
  });

  it("throws when path is not a git repo", () => {
    const notRepo = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(notRepo, { recursive: true });
    expect(() => installEmbeddingHooks(notRepo, "x")).toThrow(/Not a git repo/);
  });
});

describe("resolveDuckbrainBin", () => {
  it("falls back to bare 'duckbrain' when no bin found", () => {
    expect(resolveDuckbrainBin(repoPath)).toBe("duckbrain");
  });

  it("resolves a sibling bin/duckbrain.js when present", () => {
    // layout: tmp/duckbrain-repo/bin/duckbrain.js + tmp/duckbrain-repo/namespaces/ns
    const duckRoot = path.join(tmpDir, "duckbrain-repo");
    fs.mkdirSync(path.join(duckRoot, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(duckRoot, "bin", "duckbrain.js"),
      "#!/usr/bin/env node\n",
    );
    const ns = path.join(duckRoot, "namespaces", "myns");
    fs.mkdirSync(ns, { recursive: true });
    const bin = resolveDuckbrainBin(ns);
    expect(bin).toContain("duckbrain.js");
    expect(fs.existsSync(bin)).toBe(true);
  });
});
