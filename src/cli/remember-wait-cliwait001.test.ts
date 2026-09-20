/**
 * CLI-WAIT-001: `duckbrain remember --wait` must deliver the guarantee its
 * docs advertise — the git commit has landed by the time the process exits.
 *
 * Pre-fix the flag was parsed (whitelisted in REMEMBER_FLAGS) and silently
 * ignored: every remember printed "will be committed in batch" and the commit
 * landed only via the process-'exit' flush (flushAllCommits), which runs
 * AFTER any await point and is invisible to the caller — scripts that
 * git-verify immediately after `remember --wait` saw nothing.
 *
 * The fix: with --wait, rememberCommand flushes the namespace's debounce
 * window (flushNamespaceCommit) and awaits the namespace's async commit chain
 * (waitForNamespaceCommit), then prints the committed line. Without the flag
 * the legacy buffered message is byte-identical and the end state is the
 * same (the exit flush still commits).
 *
 * These tests drive the REAL CLI (node bin/duckbrain.js remember …) in a
 * subprocess and assert on GIT STATE after exit — not on the exit line alone.
 *
 * Hermeticity: the child's write path is redirected with
 * DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_CONFIG_PATH pointed at a scratch dir
 * (saved/restored around the suite), so nothing here touches the repo's
 * `namespaces/` or `duckbrain.config.json`, and no daemon is required.
 * The final case asserts that no write leaked into the repo namespace root.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { spawn, execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Process-spawning suite: file-scoped budgets (same convention as
// src/cli/remember-eq-value-clitrunc001.test.ts).
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const REPO_NAMESPACES_DIR = path.join(process.cwd(), "namespaces");

const SCRATCH_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-cliwait001-"),
);
const SCRATCH_NS_ROOT = path.join(SCRATCH_ROOT, "namespaces");
const SCRATCH_CONFIG_PATH = path.join(SCRATCH_ROOT, "duckbrain.config.json");

/** Scratch namespaces for this suite — never registered in any config file. */
const NS_WAIT = "cliwait001-wait-ns";
const NS_NOWAIT = "cliwait001-nowait-ns";

/** Env vars that gate the write path — saved and restored around this suite. */
const PREV_NS_PATH = process.env.DUCKBRAIN_NAMESPACES_PATH;
const PREV_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;

beforeAll(() => {
  fs.mkdirSync(SCRATCH_NS_ROOT, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = SCRATCH_NS_ROOT;
  process.env.DUCKBRAIN_CONFIG_PATH = SCRATCH_CONFIG_PATH;
});

afterAll(() => {
  if (PREV_NS_PATH === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = PREV_NS_PATH;
  if (PREV_CONFIG_PATH === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = PREV_CONFIG_PATH;
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

/** Spawn the real CLI and capture stdout/stderr until exit or timeout. */
function runCli(
  args: string[],
  timeoutMs = 45_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env: {
        ...process.env,
        DUCKBRAIN_NAMESPACES_PATH: SCRATCH_NS_ROOT,
        DUCKBRAIN_CONFIG_PATH: SCRATCH_CONFIG_PATH,
      },
      cwd: process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Git facts about a namespace repo, read from OUTSIDE the child process. */
function gitFacts(nsDir: string): {
  hasGit: boolean;
  commitCount: number;
  porcelain: string;
} {
  const hasGit = fs.existsSync(path.join(nsDir, ".git"));
  if (!hasGit) return { hasGit, commitCount: 0, porcelain: "" };
  let commitCount = 0;
  try {
    commitCount = parseInt(
      execSync(`git -C ${nsDir} rev-list --count HEAD`, {
        encoding: "utf8",
      }).trim(),
      10,
    );
  } catch {
    commitCount = 0;
  }
  let porcelain = "";
  try {
    porcelain = execSync(`git -C ${nsDir} status --porcelain`, {
      encoding: "utf8",
    });
  } catch {
    porcelain = "";
  }
  return { hasGit, commitCount, porcelain };
}

/** Poll until a namespace repo has at least one commit (bounded). */
async function waitForCommit(
  nsDir: string,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const facts = gitFacts(nsDir);
    if (facts.hasGit && facts.commitCount >= 1) return facts.commitCount;
    if (Date.now() > deadline) return facts.commitCount;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** True when the remembered key is present in any JSONL under the namespace. */
function keyInJsonl(nsDir: string, key: string): boolean {
  let found = false;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) {
        if (fs.readFileSync(p, "utf8").includes(key)) found = true;
      }
    }
  };
  walk(nsDir);
  return found;
}

describe("CLI-WAIT-001: remember --wait commits before exit", () => {
  it("with --wait: reports the commit, exits 0, and the namespace repo is committed + clean immediately after exit", async () => {
    const key = "/cliwait001/wait-key";
    const res = await runCli([
      "remember",
      key,
      "--domain=raw_note",
      "--content=cliwait001 wait probe body",
      `--namespace=${NS_WAIT}`,
      "--wait",
    ]);

    expect(res.code).toBe(0);
    // The committed line replaces the buffered phrasing entirely.
    expect(res.stdout).toContain("committed to git");
    expect(res.stdout).not.toContain("will be committed in batch");

    // Immediately after exit — no polling grace: the flag promises this.
    const nsDir = path.join(SCRATCH_NS_ROOT, NS_WAIT);
    expect(fs.existsSync(nsDir)).toBe(true);
    expect(fs.existsSync(path.join(nsDir, ".git"))).toBe(true);
    const facts = gitFacts(nsDir);
    expect(facts.commitCount).toBeGreaterThanOrEqual(1);
    expect(facts.porcelain).toBe("");
    expect(keyInJsonl(nsDir, key)).toBe(true);
  }, 60_000);

  it("without --wait: legacy buffered message is preserved and the end state still converges (exit flush)", async () => {
    const key = "/cliwait001/nowait-key";
    const res = await runCli([
      "remember",
      key,
      "--domain=raw_note",
      "--content=cliwait001 no-wait probe body",
      `--namespace=${NS_NOWAIT}`,
    ]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("will be committed in batch");

    // The process 'exit' handler flushes the debounce window, so the
    // commit lands before the process is gone — bounded poll for CI.
    const nsDir = path.join(SCRATCH_NS_ROOT, NS_NOWAIT);
    const commits = await waitForCommit(nsDir);
    expect(commits).toBeGreaterThanOrEqual(1);
    expect(gitFacts(nsDir).porcelain).toBe("");
  }, 60_000);

  it("writes nothing into the repo's real namespaces/ root", async () => {
    // Fresh clones / CI runners have no namespaces/ dir at all (gitignored,
    // created lazily by the daemon) — nothing to leak into, so the check is
    // vacuously satisfied there. This box HAS the dir (live daemon).
    if (!fs.existsSync(REPO_NAMESPACES_DIR)) return;
    const leaked = fs
      .readdirSync(REPO_NAMESPACES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("cliwait001"))
      .map((e) => e.name);
    expect(leaked).toEqual([]);
  });
});
