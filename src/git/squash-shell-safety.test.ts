import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { squashPartition } from "./squash";

let root: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("squash history shell safety", () => {
  it("treats shell metacharacters in a partition as a literal git path", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-squash-shell-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Fixture");

    // The shell variable expands to an absolute path inside this fixture.
    const marker = path.join(root, "shell-injection-marker");
    vi.stubEnv("DUCKBRAIN_SQUASH_TEST_MARKER", marker);
    const partition = path.join(
      root,
      `$(touch${"${IFS}"}${"${DUCKBRAIN_SQUASH_TEST_MARKER}"})`,
    );
    fs.mkdirSync(partition);
    const record = JSON.stringify({
      id: "00000000-0000-4000-8000-000000000001",
      key: "/event/test",
      domain: "event",
      timestamp: "2026-01-01T00:00:00Z",
      author: "fixture@example.test",
      action: "add",
      embedding_text: "test",
      attributes: {},
    });
    const file = path.join(partition, "0001.jsonl");
    fs.writeFileSync(file, `${record}\n`);
    git("add", "--all");
    git("commit", "-qm", "first");
    fs.appendFileSync(file, `${record}\n`);
    git("add", "--all");
    git("commit", "-qm", "second");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await squashPartition(partition, { squashCommits: true });
    expect(result.success).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("2 commits could be squashed"),
    );
  });
});
