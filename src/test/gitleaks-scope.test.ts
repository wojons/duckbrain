import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function gitleaksConfig(): string {
  return readFileSync(resolve(repoRoot, ".gitleaks.toml"), "utf8");
}

function allowlistPathPatterns(): string[] {
  const config = gitleaksConfig();
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

    // The builtin path-class guard is configured separately for committed
    // templates; this scope regression must not turn that into a source-wide
    // exemption or a .gitreins blanket rule.
    expect(patterns).not.toContain("\\.npmrc");
    expect(patterns).not.toContain("\\.env");
    expect(gitleaksConfig()).toContain("'''\\.gitreins/.*'''");
    expect(patterns).toContain("tests/.*");
    expect(patterns).toContain("docs/.*");
  });
});
