/**
 * HARDEN-DUCKBRAIN-007 — read-only `CHANGELOG_CORRUPT` census.
 *
 * HARDEN-DUCKBRAIN-006 stops NEW orphan change records (a row born and
 * destroyed inside one commit window). It cannot heal a namespace whose
 * COMMITTED history already contains one: `deriveCommitChanges` walks the
 * committed `_audit/` ledger, so a pre-fix orphan record still throws
 * `CHANGELOG_CORRUPT` for every subscriber of that namespace and the daemon
 * logs it at realtime warm-up.
 *
 * This module answers, per namespace, how many commits in its first-parent
 * history fail to derive, of which class, and where the first one sits —
 * using the SHIPPED derivation (`deriveCommitChanges`), never a
 * re-implementation. It reads git objects only, through the readers in
 * `src/git/ledger.ts`: no checkout, no commit, no index mutation, no file
 * write inside a namespace.
 *
 * CLI: `scripts/changelog-corrupt-census.ts`.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { deriveCommitChanges } from "../http/realtime/replay.js";
import { isChangelogCorrupt } from "../serialization/auditLedger.js";
import {
  commitTimeIso,
  isGitRepository,
  resolveHeadSha,
} from "../git/ledger.js";

export interface CorruptSample {
  commit: string;
  committedAt: string | null;
  /** Ledger path relative to the namespace (`_audit/<segment>`). */
  path: string | null;
  /** One-based physical line inside the segment. */
  line: number | null;
  class: string;
  message: string;
}

export interface NamespaceResult {
  namespace: string;
  head: string;
  commits: number;
  derivedChanges: number;
  corruptCommits: number;
  classes: Record<string, number>;
  samples: CorruptSample[];
  samplesTruncated: number;
  status: "clean" | "corrupt" | "error";
  error: string | null;
}

export interface CensusReport {
  root: string;
  namespacesScanned: number;
  namespacesSkipped: number;
  commitsScanned: number;
  namespacesCorrupt: number;
  corruptCommits: number;
  namespacesErrored: number;
  corrupt: Array<{
    namespace: string;
    head: string;
    corruptCommits: number;
    classes: Record<string, number>;
    firstSample: CorruptSample | null;
  }>;
  namespaces: NamespaceResult[];
}

/**
 * Failure classes `deriveCommitChanges` can raise, keyed by the message it
 * writes. Order matters: narrower patterns come first.
 */
const CLASS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/is not valid JSON|is not a JSON object/, "malformed-ledger-line"],
  [/is malformed/, "malformed-change-record"],
  [/has no data row with the recorded content hash/, "unresolvable-row-image"],
  [/is not an append-only extension/, "audit-rewrite"],
  [/does not end on a line boundary/, "torn-audit-line"],
  [/claims namespace/, "wrong-namespace"],
  [/tombstone flag inconsistent/, "tombstone-flag"],
  [/targetPath .*escapes/, "unsafe-target-path"],
  [/does not exist in commit/, "missing-target-path"],
  [/key\.\w+ does not match/, "key-row-mismatch"],
  [/is missing declared key/, "missing-declared-key"],
  [/nested path/, "nested-audit-path"],
  [/segment/, "segment-order"],
];

/** Coarse class name for a `CHANGELOG_CORRUPT` message (stable across runs). */
export function classifyCorruptMessage(message: string): string {
  for (const [pattern, name] of CLASS_PATTERNS) {
    if (pattern.test(message)) return name;
  }
  return "other";
}

/** First-parent history, oldest first — exactly the order the feed replays. */
export function firstParentCommits(repoDir: string): string[] {
  const out = execFileSync(
    "git",
    ["rev-list", "--first-parent", "--reverse", "HEAD"],
    {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim();
  return out === "" ? [] : out.split("\n");
}

/** A namespace directory the feed can derive from: git repo + `_audit/`. */
export function isCensusCandidate(namespaceDir: string): boolean {
  return (
    isGitRepository(namespaceDir) &&
    fs.existsSync(path.join(namespaceDir, "_audit"))
  );
}

/** Immediate child namespaces of `root` that carry committed history. */
export function listCandidateNamespaces(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => isCensusCandidate(path.join(root, name)))
    .sort();
}

/**
 * Walk one namespace's first-parent history oldest→newest, deriving every
 * commit with the shipped replay derivation. Corrupt commits are COUNTED and
 * classified (up to `sampleLimit` samples carry path/line/commit/date); the
 * walk continues so a namespace reports its full corrupt-commit count rather
 * than only its first offender.
 */
export function censusNamespace(
  root: string,
  namespace: string,
  sampleLimit: number,
): NamespaceResult {
  const repoDir = path.join(root, namespace);
  const head = resolveHeadSha(repoDir);
  if (head === null) {
    return {
      namespace,
      head: "",
      commits: 0,
      derivedChanges: 0,
      corruptCommits: 0,
      classes: {},
      samples: [],
      samplesTruncated: 0,
      status: "error",
      error: "namespace repository has no committed HEAD",
    };
  }
  const commits = firstParentCommits(repoDir);
  let derivedChanges = 0;
  let corruptCommits = 0;
  const classes: Record<string, number> = {};
  const samples: CorruptSample[] = [];
  for (const commit of commits) {
    try {
      derivedChanges += deriveCommitChanges(repoDir, commit, {
        ns: namespace,
        namespacePath: repoDir,
      }).length;
    } catch (error) {
      if (!isChangelogCorrupt(error)) {
        return {
          namespace,
          head,
          commits: commits.length,
          derivedChanges,
          corruptCommits,
          classes,
          samples,
          samplesTruncated: 0,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      corruptCommits += 1;
      const kind = classifyCorruptMessage(error.message);
      classes[kind] = (classes[kind] ?? 0) + 1;
      if (samples.length < sampleLimit) {
        let committedAt: string | null = null;
        try {
          committedAt = commitTimeIso(repoDir, commit);
        } catch {
          committedAt = null;
        }
        const detail = error.detail ?? {};
        samples.push({
          commit,
          committedAt,
          path: detail.path ?? null,
          line: detail.line ?? null,
          class: kind,
          message: error.message,
        });
      }
    }
  }
  return {
    namespace,
    head,
    commits: commits.length,
    derivedChanges,
    corruptCommits,
    classes,
    samples,
    samplesTruncated:
      sampleLimit === 0 ? 0 : Math.max(0, corruptCommits - samples.length),
    status: corruptCommits > 0 ? "corrupt" : "clean",
    error: null,
  };
}

/** Census every named namespace in order (the serial path). */
export function runCensus(
  root: string,
  namespaces: string[],
  sampleLimit: number,
  onResult?: (result: NamespaceResult) => void,
): NamespaceResult[] {
  const results: NamespaceResult[] = [];
  for (const namespace of namespaces) {
    const result = censusNamespace(root, namespace, sampleLimit);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

/** Assemble the deterministic report body (sorted, no timestamps/durations). */
export function buildCensusReport(
  root: string,
  candidates: number,
  results: NamespaceResult[],
): CensusReport {
  const namespaces = [...results].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  );
  const corrupt = namespaces
    .filter((result) => result.corruptCommits > 0)
    .map((result) => ({
      namespace: result.namespace,
      head: result.head,
      corruptCommits: result.corruptCommits,
      classes: result.classes,
      firstSample: result.samples[0] ?? null,
    }));
  return {
    root,
    namespacesScanned: namespaces.length,
    namespacesSkipped: Math.max(0, candidates - namespaces.length),
    commitsScanned: namespaces.reduce((sum, result) => sum + result.commits, 0),
    namespacesCorrupt: corrupt.length,
    corruptCommits: corrupt.reduce((sum, hit) => sum + hit.corruptCommits, 0),
    namespacesErrored: namespaces.filter((r) => r.status === "error").length,
    corrupt,
    namespaces,
  };
}
