/**
 * GIT-IDENTITY-001 — `duckbrain git repair-identity` CLI regression test.
 *
 * The command must scan the namespaces root (DUCKBRAIN_NAMESPACES_PATH),
 * remove ONLY synthetic local identity pins, print the repaired repos, and
 * be a no-op on a second run. Never touches history or non-synthetic config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { runGitIdentityCLI } from "./git-identity";

// CI runners have no global git identity (CI-GITID-028): give fixture
// commits an explicit identity instead of relying on host config.
const CI_IDENT = ["-c", "user.name=DuckBrain Test", "-c", "user.email=duckbrain-test@example.com"];
function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-C", cwd, ...CI_IDENT, ...args], {
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
let savedNsPath: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-gitid-cli-"));
  savedNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
});

afterEach(() => {
  if (savedNsPath === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = savedNsPath;
});

/** Capture console output around an invocation. */
async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
  return lines;
}

describe("duckbrain git repair-identity", () => {
  it("repairs exactly the pinned repo, lists it, and is a no-op on rerun", async () => {
    const pinned = path.join(tmpRoot, "pinned");
    const clean = path.join(tmpRoot, "clean");
    for (const dir of [pinned, clean]) {
      fs.mkdirSync(dir);
      git(["init"], dir);
      fs.writeFileSync(path.join(dir, "data.jsonl"), "row\n");
      git(["add", "-A"], dir);
      git(["commit", "-m", "seed"], dir);
    }
    git(["config", "--local", "user.name", "DuckBrain"], pinned);
    git(["config", "--local", "user.email", "duckbrain@localhost.localdomain"], pinned);
    const headBefore = git(["rev-parse", "HEAD"], pinned);

    const first = await capture(() => runGitIdentityCLI(["repair-identity"]));
    const firstText = first.join("\n");
    expect(firstText).toContain("Repaired 1 repo(s)");
    expect(firstText).toContain("- pinned");
    expect(localConfig(pinned, "user.name")).toBeNull();
    expect(localConfig(pinned, "user.email")).toBeNull();
    expect(localConfig(clean, "user.name")).toBeNull();
    expect(git(["rev-parse", "HEAD"], pinned)).toBe(headBefore);

    const second = await capture(() => runGitIdentityCLI(["repair-identity"]));
    const secondText = second.join("\n");
    expect(secondText).toContain("No synthetic git identity pins found");
    expect(secondText).not.toContain("Repaired");
  });

  it("bare invocation prints the identity health report", async () => {
    const lines = await capture(() => runGitIdentityCLI([]));
    expect(lines.join("\n")).toContain("git identity OK");
  });
});
