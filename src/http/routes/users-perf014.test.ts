/** PERF-014 — bounded /users author aggregation.
 *
 * The route's grant filtering remains owned by listNamespacesTool; these tests
 * exercise the extracted aggregation seam without touching namespace state.
 */
import { describe, expect, it } from "vitest";
import { collectAuthorsForNamespaces } from "./users";

describe("collectAuthorsForNamespaces", () => {
  it("bounds concurrent git scans and preserves per-namespace fallback", async () => {
    const namespaces = Array.from({ length: 5 }, (_, index) => ({
      path: `namespace-${index}`,
    }));
    let activeGitScans = 0;
    let peakGitScans = 0;
    const dbCalls: string[] = [];

    const users = await collectAuthorsForNamespaces(namespaces, {
      concurrency: 2,
      getGitAuthors: async (namespacePath) => {
        activeGitScans += 1;
        peakGitScans = Math.max(peakGitScans, activeGitScans);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeGitScans -= 1;
        if (namespacePath === "namespace-1") throw new Error("git timeout");
        if (namespacePath === "namespace-2") return [];
        return ["shared", namespacePath];
      },
      getDbAuthors: async (namespacePath) => {
        dbCalls.push(namespacePath);
        return [
          "fallback",
          namespacePath === "namespace-1" ? "db-only" : "shared",
        ];
      },
    });

    expect(peakGitScans).toBe(2);
    expect(dbCalls.sort()).toEqual(["namespace-1", "namespace-2"]);
    expect(users).toEqual([
      "db-only",
      "fallback",
      "namespace-0",
      "namespace-3",
      "namespace-4",
      "shared",
    ]);
  });

  it("does not query DuckDB when a namespace has git authors", async () => {
    const dbCalls: string[] = [];

    const users = await collectAuthorsForNamespaces([{ path: "granted" }], {
      getGitAuthors: async () => ["git-user"],
      getDbAuthors: async (namespacePath) => {
        dbCalls.push(namespacePath);
        return ["db-user"];
      },
    });

    expect(users).toEqual(["git-user"]);
    expect(dbCalls).toEqual([]);
  });

  it("returns no authors for an empty granted namespace list", async () => {
    const users = await collectAuthorsForNamespaces([]);
    expect(users).toEqual([]);
  });
});
