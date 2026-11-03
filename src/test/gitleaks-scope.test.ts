import { execSync } from "node:child_process";
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

function sensitivePathsAllow(): string[] {
  // guards.sensitive_paths.allow from .gitreins/config.yaml. The block is a
  // flat string list, so a line-based parse is exact here; switch to a YAML
  // parser if the block ever grows nested structure.
  const config = readFileSync(path.resolve(repoRoot, ".gitreins/config.yaml"), "utf8");
  const spMatch = config.match(/^  sensitive_paths:\n((?:    .*\n)+)/m);
  if (!spMatch) {
    throw new Error(
      ".gitreins/config.yaml is missing guards.sensitive_paths.allow — tracked " +
        "credential-store files would fail the tier1 secrets leg again (DF-2026-20)",
    );
  }
  return [...spMatch[1].matchAll(/- "([^"]+)"/g)].map((match) => match[1]);
}

function trackedFiles(): string[] {
  return execSync("git ls-files -z", { cwd: repoRoot })
    .toString()
    .split("\0")
    .filter(Boolean);
}

// Mirrors gitreins 0.17.1 engine/guard_manager.py SENSITIVE_PATH_PATTERNS —
// the credential-store PATH class the builtin secrets cross-check enforces
// REGARDLESS of content (REVIEW-GITREINS-027), and which .gitleaks.toml
// allowlists deliberately cannot silence (GR-GAP-007). Re-sync this list
// when the shipped gitreins version changes.
const SENSITIVE_PATH_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  ".ssh/**",
  "credentials.json",
  ".npmrc",
  ".pypirc",
  "*.keystore",
  "*.jks",
  ".netrc",
  ".pgpass",
  "credentials*",
  "service-account*.json",
  "config/database.yml",
];

// Gitignore-flavoured compile, mirroring _compile_sensitive_path_patterns:
// a pattern without "/" matches the FILENAME at any depth; a pattern with "/"
// is anchored to a path tail; "**" as a full segment means everything below;
// "*" never crosses "/".
function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/").map((segment) =>
    segment === "**"
      ? ".+"
      : segment
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]"),
  );
  return new RegExp(`(^|/)${segments.join("/")}$`);
}

function isSensitivePath(fpath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.map(globToRegExp).some((rx) => rx.test(fpath));
}

function isSensitiveFixturePath(fpath: string): boolean {
  return /(^|\/)(tests?|fixtures)\//.test(fpath);
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

  // DF-2026-20: the five 2026-10-30 verdicts failed tier1 secrets because the
  // builtin cross-check's credential-store PATH class fired on the tracked
  // .npmrc / .env.example while gitleaks (content-based, honouring the repo
  // config) stayed clean. The sanctioned, auditable escape is
  // guards.sensitive_paths.allow — this pins that every tracked file the
  // class would flag is covered by it (or lives in a fixture dir), so a new
  // tracked credential-store file turns this test red instead of silently
  // redding every fresh-worktree verdict again.
  it("covers every tracked credential-store path with a sensitive_paths override", () => {
    const allow = sensitivePathsAllow();
    expect(allow).toContain(".npmrc");
    expect(allow).toContain(".env.example");

    const allowSet = new Set(allow);
    const violations = trackedFiles()
      .filter((f) => isSensitivePath(f) && !isSensitiveFixturePath(f))
      .filter((f) => !allowSet.has(f) && !allowSet.has(path.basename(f)));

    expect(violations).toEqual([]);
  });

  // Scope agreement, tracked-state side: every tracked .gitreins/** artifact
  // is covered by the repo .gitleaks.toml harness pattern (the external
  // scanner's scope) — and .gitreins paths are NOT in the credential-store
  // class (the builtin prunes them structurally). If a new harness state dir
  // is ever tracked outside .gitreins/, this goes red.
  it("keeps tracked harness state inside the gitleaks harness exclusion", () => {
    const harnessPattern = allowlistPathPatterns().find((pattern) => /gitreins/.test(pattern));
    expect(harnessPattern).toBeDefined();
    const harnessRegex = new RegExp(harnessPattern ?? "$");

    const trackedHarnessFiles = trackedFiles().filter((f) => f.startsWith(".gitreins/"));
    expect(trackedHarnessFiles.length).toBeGreaterThan(0);
    const uncovered = trackedHarnessFiles.filter((f) => !harnessRegex.test(f));
    expect(uncovered).toEqual([]);

    expect(isSensitivePath(".gitreins/history/2026-10-30/55043021/verdict.json")).toBe(false);
  });
});
