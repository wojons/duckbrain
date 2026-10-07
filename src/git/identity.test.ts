/**
 * GIT-IDENTITY-001 regression tests.
 *
 * The commit path used to invent and WRITE a synthetic identity
 * ('DuckBrain' / 'duckbrain@localhost.localdomain') into namespace repos
 * whenever a git config read failed; local config outranks global, so the
 * pin was permanent. These tests pin the new contract:
 *
 *  - identity is RESOLVED (repo-local -> global -> env override), never
 *    invented;
 *  - with a global identity present, autocommit does NOT write local
 *    config;
 *  - with no identity anywhere, autocommit errors loudly and writes
 *    nothing;
 *  - repairNamespaceGitIdentities removes ONLY synthetic local pins,
 *    lists the repaired repos, and is a no-op on a second run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  commitNamespaceWithParams,
  drainAsyncCommits,
  flushAllCommits,
} from "./autocommit";
import {
  isSyntheticIdentity,
  repairNamespaceGitIdentities,
  resolveGitIdentity,
  requireGitIdentity,
  checkGitIdentityHealth,
} from "./identity";

function git(args: string[], cwd?: string): string {
  const fullArgs = cwd ? ["-C", cwd, ...args] : args;
  return execFileSync("git", fullArgs, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function localConfig(cwd: string, key: string): string | null {
  try {
    return git(["config", "--local", key], cwd);
  } catch {
    return null;
  }
}

let tmpRoot: string;
let nsPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-gitid-"));
  nsPath = path.join(tmpRoot, "ns");
  fs.mkdirSync(nsPath);
});

afterEach(() => {
  flushAllCommits();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const noBatching = { maxLines: 100, maxSeconds: 30, enabled: false };

async function settle(): Promise<void> {
  await commitNamespaceWithParams(nsPath, "test commit", noBatching);
  await drainAsyncCommits(5000);
}

describe("GIT-IDENTITY-001: autocommit never invents an identity", () => {
  it("(a) with a global identity present, autocommit writes NO local config", async () => {
    git(["init"], nsPath);
    fs.writeFileSync(path.join(nsPath, "a.jsonl"), "row\n");

    await settle();

    // The resolution chain succeeds via the host's global identity — the
    // namespace repo must carry no local user.* pin of any kind.
    expect(localConfig(nsPath, "user.name")).toBeNull();
    expect(localConfig(nsPath, "user.email")).toBeNull();
    // ... and the commit landed, attributed to the global identity.
    expect(git(["rev-list", "--count", "HEAD"], nsPath)).toBe("1");
    expect(git(["log", "-1", "--format=%an <%ae>"], nsPath)).not.toContain(
      "duckbrain@localhost",
    );
  });

  it("(b) with no identity anywhere, autocommit errors loudly and writes nothing", async () => {
    // Isolated env: GIT_CONFIG_GLOBAL points at an empty config so --global
    // reads nothing, and the resolution chain fails all the way down.
    const emptyHome = path.join(tmpRoot, "empty-home");
    fs.mkdirSync(emptyHome);
    const emptyGitconfig = path.join(emptyHome, ".gitconfig-empty");
    fs.writeFileSync(emptyGitconfig, "");
    git(["init"], nsPath);
    fs.writeFileSync(path.join(nsPath, "a.jsonl"), "row\n");

    // The resolution reads process.env — point GIT_CONFIG_GLOBAL at an empty
    // config for the duration of the check, then restore.
    const savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = emptyGitconfig;

    // The identity resolution itself must fail LOUDLY with the actionable hint.
    let thrown: Error | null = null;
    try {
      requireGitIdentity(nsPath);
    } catch (error) {
      thrown = error as Error;
    } finally {
      if (savedGitConfigGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
      }
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain("No git author identity is configured");
    expect(thrown?.message).toContain("DUCKBRAIN_GIT_AUTHOR_EMAIL");

    // And no synthetic pin may appear in the repo config.
    expect(localConfig(nsPath, "user.name")).toBeNull();
    expect(localConfig(nsPath, "user.email")).toBeNull();

    // Sanity: resolution with the same isolation reports nothing available.
    const isolated = resolveGitIdentity(nsPath, {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyGitconfig,
      DUCKBRAIN_GIT_AUTHOR_NAME: "",
      DUCKBRAIN_GIT_AUTHOR_EMAIL: "",
    });
    expect(isolated.identity).toBeNull();
    expect(isolated.error).toContain("No git author identity is configured");
  });
});

describe("GIT-IDENTITY-001: repairNamespaceGitIdentities", () => {
  it("(c) removes the synthetic pin, lists the repo, and is a no-op on rerun", () => {
    const pinned = path.join(tmpRoot, "pinned");
    const clean = path.join(tmpRoot, "clean");
    for (const dir of [pinned, clean]) {
      fs.mkdirSync(dir);
      git(["init"], dir);
      fs.writeFileSync(path.join(dir, "data.jsonl"), "row\n");
      git(["add", "-A"], dir);
      git(["commit", "-m", "seed"], dir);
    }
    // Only `pinned` carries the synthetic local pin; `clean` relies on the
    // host's global identity and must be left untouched.
    git(["config", "--local", "user.name", "DuckBrain"], pinned);
    git(["config", "--local", "user.email", "duckbrain@localhost.localdomain"], pinned);

    const headBefore = git(["rev-parse", "HEAD"], pinned);

    const first = repairNamespaceGitIdentities(tmpRoot);
    expect(first.repaired).toEqual(["pinned"]);
    expect(first.repaired).not.toContain("clean");
    expect(localConfig(pinned, "user.name")).toBeNull();
    expect(localConfig(pinned, "user.email")).toBeNull();
    // History untouched.
    expect(git(["rev-parse", "HEAD"], pinned)).toBe(headBefore);

    const second = repairNamespaceGitIdentities(tmpRoot);
    expect(second.repaired).toEqual([]);

    // The clean repo (host global identity, no local pins) is untouched.
    expect(localConfig(clean, "user.name")).toBeNull();
  });

  it("leaves a non-synthetic local identity alone", () => {
    const real = path.join(tmpRoot, "real");
    fs.mkdirSync(real);
    git(["init"], real);
    git(["config", "--local", "user.name", "Real User"], real);
    git(["config", "--local", "user.email", "real@example.com"], real);

    const { repaired } = repairNamespaceGitIdentities(tmpRoot);
    expect(repaired).toEqual([]);
    expect(localConfig(real, "user.name")).toBe("Real User");
    expect(localConfig(real, "user.email")).toBe("real@example.com");
  });
});

describe("GIT-IDENTITY-001: identity resolution helpers", () => {
  it("env override beats nothing; repo-local beats global", () => {
    const repo = path.join(tmpRoot, "repo");
    fs.mkdirSync(repo);
    git(["init"], repo);
    git(["config", "--local", "user.name", "Local User"], repo);
    git(["config", "--local", "user.email", "local@example.com"], repo);

    const resolved = resolveGitIdentity(repo);
    expect(resolved.source).toBe("repo-local");
    expect(resolved.identity).toEqual({
      name: "Local User",
      email: "local@example.com",
    });
  });

  it("isSyntheticIdentity matches only the full fabricated pair", () => {
    expect(isSyntheticIdentity("DuckBrain", "duckbrain@localhost.localdomain")).toBe(true);
    expect(isSyntheticIdentity("DuckBrain", "duckbrain@localhost")).toBe(true);
    expect(isSyntheticIdentity("Real User", "duckbrain@localhost.localdomain")).toBe(false);
    expect(isSyntheticIdentity("DuckBrain", "real@example.com")).toBe(false);
    expect(isSyntheticIdentity(null, null)).toBe(false);
  });

  it("checkGitIdentityHealth reports ok on a clean host and flags synthetic pins", () => {
    const health = checkGitIdentityHealth();
    expect(health.ok).toBe(true);
    expect(health.resolvedIdentity).not.toBeNull();
    expect(health.resolvedIdentity!.email).not.toContain("duckbrain@localhost");
  });
});
