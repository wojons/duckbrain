/**
 * PERF-015 regression: the author fallback must read partition JSONL without
 * opening the namespace DuckDB file, and must remain stable across calls.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectAuthorsForNamespaces } from "./authorAggregation";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("author aggregation in-memory DuckDB fallback", () => {
  it("reads the same distinct sorted authors twice without a namespace DB lock", async () => {
    const namespacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-perf015-authors-"),
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

    const options = {
      getGitAuthors: async () => [],
    };
    const first = await collectAuthorsForNamespaces(
      [{ path: namespacePath }],
      options,
    );
    const second = await collectAuthorsForNamespaces(
      [{ path: namespacePath }],
      options,
    );

    expect(first).toEqual(["Ada", "Mina", "Zoe"]);
    expect(second).toEqual(first);
    expect(fs.existsSync(path.join(namespacePath, "duckdb.db"))).toBe(false);
  });
});
