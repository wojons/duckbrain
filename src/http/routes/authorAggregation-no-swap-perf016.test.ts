/**
 * PERF-016 — a FAILED git scan must never swap a namespace's source.
 *
 * GET /users historically consulted memory records for any namespace whose git
 * authors came back empty, without asking WHY they were empty. Under load a git
 * scan that timed out or failed returned "empty", so the route silently
 * substituted that namespace's memory-record authors for its git identities and
 * the served set drifted between identical requests (recorded: 20, 45, 72, 73,
 * 74, 77 identities from the same store).
 *
 * These cases pin the status boundary: verified-empty / no-repo / enoent may
 * fall back to memory; timeout and every other operational failure may not.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectAuthorsForNamespaces,
  gitStatusAllowsMemoryFallback,
} from "./authorAggregation";

type GitMode = "empty" | "not-a-repo" | "timeout" | "operational" | "authors";

const git = vi.hoisted(() => ({
  mode: "empty" as GitMode,
  calls: [] as string[],
}));

vi.mock("../../git/exec", () => ({
  runGitAsync: async (_args: string[], cwd: string) => {
    git.calls.push(cwd);
    if (git.mode === "not-a-repo") {
      throw new Error(
        "Command failed: git log --all --format=%aN\nfatal: not a git repository (or any of the parent directories): .git",
      );
    }
    if (git.mode === "timeout") {
      const error = new Error("Command failed: git log --all --format=%aN");
      (error as Error & { killed?: boolean }).killed = true;
      throw error;
    }
    if (git.mode === "operational") {
      throw new Error("fatal: index: .git/index: operation not permitted");
    }
    if (git.mode === "authors") return "Git Author\n";
    return "";
  },
}));

const tempDirectories: string[] = [];

/** A namespace with a manifest and one JSONL partition carrying two authors. */
function makeMemoryNamespace(): string {
  const namespacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-perf016-authors-"),
  );
  tempDirectories.push(namespacePath);
  const partitionPath = path.join(namespacePath, "concept", "2026-11");
  fs.mkdirSync(partitionPath, { recursive: true });
  fs.writeFileSync(
    path.join(namespacePath, "manifest.json"),
    JSON.stringify({ partitions: ["concept/2026-11"] }),
  );
  fs.writeFileSync(
    path.join(partitionPath, "current.jsonl"),
    [
      JSON.stringify({ author: "Zoe" }),
      JSON.stringify({ author: "Ada" }),
      JSON.stringify({ author: "Zoe" }),
      JSON.stringify({ author: "Mina" }),
    ].join("\n") + "\n",
  );
  return namespacePath;
}

beforeEach(() => {
  git.mode = "empty";
  git.calls = [];
});

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("PERF-016 injected git lookup failure semantics", () => {
  it("does not surface memory authors when the injected lookup rejects with a timeout", async () => {
    const gitCalls: string[] = [];
    const dbCalls: string[] = [];

    const authors = await collectAuthorsForNamespaces(
      [{ path: "/ns/has-both" }],
      {
        getGitAuthors: async (namespacePath) => {
          gitCalls.push(namespacePath);
          const error = new Error("git log timed out");
          (error as Error & { killed?: boolean }).killed = true;
          throw error;
        },
        getDbAuthors: async (namespacePath) => {
          dbCalls.push(namespacePath);
          return ["Memory Record Author"];
        },
      },
    );

    expect(authors).not.toContain("Memory Record Author");
    expect(authors).toEqual([]);
    expect(gitCalls).toEqual(["/ns/has-both"]);
    expect(dbCalls).toEqual([]);
  });

  it("does not surface memory authors when the injected lookup rejects with an operational error", async () => {
    const dbCalls: string[] = [];

    const authors = await collectAuthorsForNamespaces(
      [{ path: "/ns/has-both" }],
      {
        getGitAuthors: async () => {
          throw new Error("fatal: index: .git/index: operation not permitted");
        },
        getDbAuthors: async (namespacePath) => {
          dbCalls.push(namespacePath);
          return ["Memory Record Author"];
        },
      },
    );

    expect(authors).not.toContain("Memory Record Author");
    expect(authors).toEqual([]);
    expect(dbCalls).toEqual([]);
  });

  it("still surfaces memory authors when the injected lookup resolves empty", async () => {
    const dbCalls: string[] = [];

    const authors = await collectAuthorsForNamespaces(
      [{ path: "/ns/verified-empty" }],
      {
        getGitAuthors: async () => [],
        getDbAuthors: async (namespacePath) => {
          dbCalls.push(namespacePath);
          return ["Memory Record Author"];
        },
      },
    );

    expect(authors).toEqual(["Memory Record Author"]);
    expect(dbCalls).toEqual(["/ns/verified-empty"]);
  });
});

describe("PERF-016 real git seam status mapping", () => {
  it("falls back for a directory git reports as not a repository", async () => {
    git.mode = "not-a-repo";
    const namespacePath = makeMemoryNamespace();

    const authors = await collectAuthorsForNamespaces([{ path: namespacePath }]);

    expect(git.calls).toContain(namespacePath);
    expect(authors).toEqual(["Ada", "Mina", "Zoe"]);
  });

  it("falls back when the git scan succeeds with no authors", async () => {
    git.mode = "empty";
    const namespacePath = makeMemoryNamespace();

    const authors = await collectAuthorsForNamespaces([{ path: namespacePath }]);

    expect(authors).toEqual(["Ada", "Mina", "Zoe"]);
  });

  it("contributes nothing when the git scan times out, even with memory rows present", async () => {
    git.mode = "timeout";
    const namespacePath = makeMemoryNamespace();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const authors = await collectAuthorsForNamespaces([{ path: namespacePath }]);

    expect(git.calls).toEqual([namespacePath]);
    expect(authors).toEqual([]);
    const diagnostics = errorSpy.mock.calls.map((call) => call.join(" "));
    expect(diagnostics.join("\n")).toContain("result=no-fallback-on-failure");
    expect(diagnostics.join("\n")).toContain("git=timeout");
  });

  it("contributes nothing when the git scan fails operationally, even with memory rows present", async () => {
    git.mode = "operational";
    const namespacePath = makeMemoryNamespace();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const authors = await collectAuthorsForNamespaces([{ path: namespacePath }]);

    expect(authors).toEqual([]);
    const diagnostics = errorSpy.mock.calls.map((call) => call.join(" "));
    expect(diagnostics.join("\n")).toContain("result=no-fallback-on-failure");
    expect(diagnostics.join("\n")).toContain("git=non-zero:");
  });

  it("keeps git authors when the scan succeeds", async () => {
    git.mode = "authors";
    const namespacePath = makeMemoryNamespace();

    const authors = await collectAuthorsForNamespaces([{ path: namespacePath }]);

    expect(authors).toEqual(["Git Author"]);
  });
});

describe("PERF-016 status vocabulary", () => {
  it("allows fallback only for verified-absent git statuses", () => {
    for (const status of ["empty-success", "no-repo", "enoent"]) {
      expect(gitStatusAllowsMemoryFallback(status)).toBe(true);
    }
    for (const status of [
      "timeout",
      "non-zero:fatal: index: .git/index: operation not permitted",
      "non-zero:unknown git failure",
      "injected",
      "",
    ]) {
      expect(gitStatusAllowsMemoryFallback(status)).toBe(false);
    }
  });
});
