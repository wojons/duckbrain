import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

function allowlistPathPatterns(): string[] {
  const config = readFileSync(path.resolve(repoRoot, ".gitleaks.toml"), "utf8");
  const pathsBlock = config.match(/paths\s*=\s*\[(.*?)\]/s)?.[1];
  if (!pathsBlock) {
    throw new Error(".gitleaks.toml is missing [allowlist].paths");
  }
  return [...pathsBlock.matchAll(/'''(.*?)'''/g)].map((match) => match[1]);
}

describe("secret scanner scope", () => {
  it("excludes GitReins harness state without excluding tracked source", () => {
    const patterns = allowlistPathPatterns();
    const harnessPattern = patterns.find((pattern) => /gitreins/.test(pattern));

    expect(harnessPattern).toBe("\\.gitreins/.*");

    const harnessRegex = new RegExp(harnessPattern ?? "$");
    expect(harnessRegex.test(".gitreins/history/verdict.json")).toBe(true);
    expect(harnessRegex.test(".gitreins/logs/guard.log")).toBe(true);
    expect(harnessRegex.test("src/index.ts")).toBe(false);
    expect(harnessRegex.test("src/git-reins.ts")).toBe(false);
  });
});
