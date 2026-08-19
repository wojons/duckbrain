/**
 * Tests for the git hook installer.
 *
 * Regressions guarded:
 *  - hooks are installed into .git/hooks with executable bits
 *  - hook scripts invoke `duckbrain embeddings rebuild --detached`
 *  - hooks refuse to install when the path is not a git repo
 *  - post-checkout fired from a namespace repo cwd rebuilds from the
 *    duckbrain root (EMB-001 cwd parity — git fires hooks with cwd = the
 *    namespace repo top level, so the hook must cd to DUCKBRAIN_ROOT)
 *  - install and rebuild are idempotent; git status stays clean
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
    // cwd normalization: git fires hooks with cwd = the namespace repo root,
    // so the hook steps up to the duckbrain root when the bin is absolute
    // (EMB-001 regression — hook rebuilds died with "Namespace not found at
    // namespaces/<ns>" from the hook cwd; mirror of the RETR-010 search fix).
    expect(hook).toContain("DUCKBRAIN_ROOT");
    expect(hook).toContain('cd "${DUCKBRAIN_ROOT}"');
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

/**
 * Stub duckbrain CLI: records the cwd it was invoked from (proves the hook
 * cd'd to the duckbrain root before invoking the CLI) and simulates the
 * rebuild log write (creates the log dir, appends a JSON line).
 */
const STUB_BIN = `#!/bin/sh
echo "$PWD" > "$STUB_CWD_FILE"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--log" ]; then
    LOG="$arg"
    mkdir -p "$(dirname "$LOG")"
    echo '{"namespace":"ns-repo","ok":true}' >> "$LOG"
  fi
  case "$arg" in
    --log=*)
      LOG="\${arg#--log=}"
      mkdir -p "$(dirname "$LOG")"
      echo '{"namespace":"ns-repo","ok":true}' >> "$LOG"
      ;;
  esac
  prev="$arg"
done
`;

/** Poll a condition synchronously — the hook backgrounds the rebuild. */
function waitFor(fn: () => boolean, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error("timed out waiting for backgrounded hook rebuild");
}

/**
 * Canonical DuckBrain layout: <duckRoot>/bin/duckbrain.js (stub) +
 * <duckRoot>/namespaces/ns-repo (real git repo, .embeddings/ gitignored).
 */
function setupCanonicalLayout(): {
  duckRoot: string;
  nsPath: string;
  hookPath: string;
  marker: string;
  logPath: string;
} {
  const duckRoot = path.join(tmpDir, "duckbrain-root");
  fs.mkdirSync(path.join(duckRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(duckRoot, "bin", "duckbrain.js"), STUB_BIN, {
    mode: 0o755,
  });
  const nsPath = path.join(duckRoot, "namespaces", "ns-repo");
  fs.mkdirSync(nsPath, { recursive: true });
  execSync("git init -q", { cwd: nsPath });
  // Sidecar rule committed up front — fresh clones inherit it, so the
  // rebuild must not dirty the tree (same contract as the search hooks test).
  fs.writeFileSync(path.join(nsPath, ".gitignore"), "/.embeddings/\n", "utf8");
  execSync("git add -A", { cwd: nsPath });
  execSync(
    "git -c user.name=Test -c user.email=test@example.com commit -qm init",
    { cwd: nsPath },
  );
  return {
    duckRoot: fs.realpathSync(duckRoot),
    nsPath,
    hookPath: path.join(nsPath, ".git", "hooks", "post-checkout"),
    marker: path.join(tmpDir, "stub-cwd.txt"),
    logPath: path.join(nsPath, ".embeddings", "rebuild.log"),
  };
}

function fireHook(hookPath: string, cwd: string, marker: string): void {
  execSync(hookPath, {
    cwd,
    env: { ...process.env, STUB_CWD_FILE: marker },
  });
}

describe("embedding hook cwd parity (EMB-001)", () => {
  it("post-checkout fired from a namespace repo cwd rebuilds from the duckbrain root", () => {
    const { duckRoot, nsPath, hookPath, marker, logPath } =
      setupCanonicalLayout();
    const written = installEmbeddingHooks(nsPath, "ns-repo");
    expect(written.length).toBe(3);

    // Git fires hooks with cwd = the namespace repo top level — exactly the
    // RETR-010 failure mode ("Namespace not found at namespaces/<ns>"). The
    // hook must cd to the duckbrain root (absolute bin) before invoking the
    // CLI, so the stub must record DUCKBRAIN_ROOT, not the ns repo.
    fireHook(hookPath, nsPath, marker);
    waitFor(() => fs.existsSync(marker) && fs.existsSync(logPath));

    expect(fs.readFileSync(marker, "utf8").trim()).toBe(duckRoot);
    expect(fs.readFileSync(logPath, "utf8")).toContain('"ok":true');
    expect(
      execSync("git status --porcelain", { cwd: nsPath, encoding: "utf8" }),
    ).toBe("");
  });

  it("re-firing the hook is idempotent — same root, appended log, clean status", () => {
    const { duckRoot, nsPath, hookPath, marker, logPath } =
      setupCanonicalLayout();
    installEmbeddingHooks(nsPath, "ns-repo");

    fireHook(hookPath, nsPath, marker);
    waitFor(() => fs.existsSync(marker));
    const first = fs.readFileSync(marker, "utf8").trim();
    expect(first).toBe(duckRoot);

    fireHook(hookPath, nsPath, marker);
    waitFor(() => {
      const lines = fs.existsSync(logPath)
        ? fs.readFileSync(logPath, "utf8").trim().split("\n")
        : [];
      return lines.length >= 2;
    });

    expect(fs.readFileSync(marker, "utf8").trim()).toBe(first);
    expect(fs.readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(2);
    expect(
      execSync("git status --porcelain", { cwd: nsPath, encoding: "utf8" }),
    ).toBe("");
  });
});
