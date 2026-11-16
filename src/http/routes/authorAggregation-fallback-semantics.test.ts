/**
 * PERF-015 regression: a namespace whose git scan SUCCEEDS must never leak
 * JSONL-only identities into the author set, while a git scan that is empty or
 * throws must fall back to the namespace's memory rows.
 *
 * The old route reached the same numbers only when fast git scans happened to
 * finish inside the timeout; under load some scans failed and the fallback then
 * injected authors from namespaces that already had git authors, so the answer
 * depended on machine load. This test pins the semantics deterministically.
 */
import { describe, expect, it } from "vitest";
import { collectAuthorsForNamespaces } from "./authorAggregation";

describe("author aggregation git/fallback semantics", () => {
  it("does not consult the memory fallback when git yields authors", async () => {
    const gitCalls: string[] = [];
    const dbCalls: string[] = [];

    const authors = await collectAuthorsForNamespaces(
      [{ path: "/ns/git-only" }],
      {
        getGitAuthors: async (namespacePath) => {
          gitCalls.push(namespacePath);
          return ["Git Author"];
        },
        getDbAuthors: async (namespacePath) => {
          dbCalls.push(namespacePath);
          return ["Jsonl Only"];
        },
      },
    );

    expect(authors).toEqual(["Git Author"]);
    expect(gitCalls).toEqual(["/ns/git-only"]);
    expect(dbCalls).toEqual([]);
  });

  it("falls back to memory rows when the git scan is empty", async () => {
    const authors = await collectAuthorsForNamespaces(
      [{ path: "/ns/no-git" }],
      {
        getGitAuthors: async () => [],
        getDbAuthors: async () => ["Jsonl Only"],
      },
    );

    expect(authors).toEqual(["Jsonl Only"]);
  });

  it("falls back to memory rows when the git scan throws", async () => {
    const authors = await collectAuthorsForNamespaces(
      [{ path: "/ns/git-broken" }],
      {
        getGitAuthors: async () => {
          throw new Error("git log timed out");
        },
        getDbAuthors: async () => ["Recovered Author"],
      },
    );

    expect(authors).toEqual(["Recovered Author"]);
  });

  it("unions per-namespace results deterministically regardless of order", async () => {
    const namespaces = [{ path: "/ns/a" }, { path: "/ns/b" }, { path: "/ns/c" }];
    const options = {
      getGitAuthors: async (namespacePath: string) =>
        namespacePath === "/ns/a" ? ["Zoe"] : [],
      getDbAuthors: async (namespacePath: string) =>
        namespacePath === "/ns/b" ? ["Ada"] : [],
    };

    const forward = await collectAuthorsForNamespaces(namespaces, options);
    const reverse = await collectAuthorsForNamespaces(
      [...namespaces].reverse(),
      options,
    );

    expect(forward).toEqual(["Ada", "Zoe"]);
    expect(reverse).toEqual(forward);
  });
});
