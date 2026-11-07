#!/usr/bin/env node
/**
 * HARDEN-DUCKBRAIN-007 — read-only `CHANGELOG_CORRUPT` census (CLI).
 *
 * The census logic lives in `src/ops/changelogCensus.ts`; this file parses
 * flags, shards the namespace list across child processes (namespace
 * granularity: each namespace is its own git repository, so shards never
 * contend for a lock or a working tree) and writes the deterministic JSON.
 *
 * Usage:
 *   pnpm exec tsx scripts/changelog-corrupt-census.ts --root ./namespaces \
 *     --json /tmp/census.json [--ns a,b] [--samples 5] [--jobs 8] \
 *     [--commit-shards K] [--fail-on-corrupt] [--quiet]
 *
 * `--commit-shards K` splits each selected namespace's first-parent history
 * into K contiguous ranges derived CONCURRENTLY and merges the slice reports
 * in history order. Deriving one commit is O(change records x target file
 * size), so a six-figure-commit namespace is wall-clock-bound on one core
 * without it; the merge (sums + history-ordered samples) is the same report.
 *
 * Exit codes: 0 = census completed (corruption is DATA — printed, not a tool
 * failure), 1 = the census could not run (missing root/namespace or a shard
 * failed), 2 = --fail-on-corrupt and at least one namespace was poisoned.
 *
 * The JSON body carries no timestamps or durations, so two runs over an
 * unchanged tree are byte-identical — the idempotency proof.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { parseArgs } from "util";
import {
  buildCensusReport,
  censusNamespace,
  firstParentCommits,
  listCandidateNamespaces,
  mergeNamespaceResults,
  runCensus,
  type NamespaceResult,
} from "../src/ops/changelogCensus.js";

/**
 * The flags a child needs to run THIS file through the same TypeScript
 * pipeline: `execArgv` already carries the tsx preflight/loader, minus the
 * `--eval` pair.
 */
function childExecArgv(): string[] {
  const evalIndex = process.execArgv.findIndex(
    (arg) => arg === "--eval" || arg === "-e",
  );
  return evalIndex === -1
    ? process.execArgv
    : process.execArgv.filter(
        (_arg, index) => index !== evalIndex && index !== evalIndex + 1,
      );
}

/** Spawn one census child and resolve with its exit code. */
function spawnCensus(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...childExecArgv(), process.argv[1], ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => resolve(code));
  });
}

/**
 * Derive ONE namespace's history as `shards` contiguous commit ranges running
 * concurrently, then merge the slice reports in history order. This is the
 * tractable path for a namespace whose single-core derivation would outlast
 * the run (scheduler: 20,202 commits, ~0.5 s/commit on the recent half).
 */
async function runCommitShards(
  root: string,
  namespaces: string[],
  shards: number,
  sampleLimit: number,
  jsonPath: string,
): Promise<NamespaceResult[]> {
  const outDir = path.join(
    path.dirname(jsonPath),
    `census-commit-shards-${process.pid}`,
  );
  fs.mkdirSync(outDir, { recursive: true });
  const results: NamespaceResult[] = [];
  for (const namespace of namespaces) {
    const total = firstParentCommits(path.join(root, namespace)).length;
    const size = Math.max(1, Math.ceil(total / shards));
    const ranges: Array<{ offset: number; limit: number; file: string }> = [];
    for (let offset = 0; offset < Math.max(total, 1); offset += size) {
      ranges.push({
        offset,
        limit: Math.min(size, total - offset),
        file: path.join(outDir, `${namespace.replace(/\W/g, "_")}-${offset}.json`),
      });
    }
    if (!values_quiet()) {
      console.error(
        `${namespace}: ${total} commits in ${ranges.length} range(s) of ${size}`,
      );
    }
    const codes = await Promise.all(
      ranges.map((range) =>
        spawnCensus([
          "--root",
          root,
          "--ns",
          namespace,
          "--samples",
          String(sampleLimit),
          "--jobs",
          "1",
          "--commit-offset",
          String(range.offset),
          "--commit-limit",
          String(range.limit),
          "--json",
          range.file,
          "--quiet",
        ]),
      ),
    );
    const parts: NamespaceResult[] = [];
    ranges.forEach((range, index) => {
      if (codes[index] !== 0) {
        console.error(
          `commit-range ${namespace}[${range.offset}+${range.limit}] failed with status ${codes[index]}`,
        );
        process.exit(1);
      }
      const body = JSON.parse(fs.readFileSync(range.file, "utf-8")) as {
        namespaces: NamespaceResult[];
      };
      parts.push(body.namespaces[0]);
      fs.rmSync(range.file, { force: true });
    });
    results.push(mergeNamespaceResults(parts, sampleLimit));
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  return results;
}

let quietFlag = false;
function values_quiet(): boolean {
  return quietFlag;
}

/**
 * Run the namespace list as `jobs` child processes (round-robin shards) and
 * merge their reports. Shard children always take the serial path.
 */
async function runShards(
  root: string,
  namespaces: string[],
  jobs: number,
  sampleLimit: number,
  jsonPath: string,
): Promise<NamespaceResult[]> {
  const shards: string[][] = Array.from({ length: jobs }, () => []);
  namespaces.forEach((name, index) => {
    shards[index % jobs].push(name);
  });
  const outDir = path.join(
    path.dirname(jsonPath),
    `census-shards-${process.pid}`,
  );
  fs.mkdirSync(outDir, { recursive: true });
  const execArgv = childExecArgv();
  const pending = shards
    .map((shard, index) => ({ shard, index }))
    .filter(({ shard }) => shard.length > 0)
    .map(({ shard, index }) => {
      const shardJson = path.join(outDir, `shard-${index}.json`);
      const child = spawn(
        process.execPath,
        [
          ...execArgv,
          process.argv[1],
          "--root",
          root,
          "--ns",
          shard.join(","),
          "--samples",
          String(sampleLimit),
          "--jobs",
          "1",
          "--json",
          shardJson,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      const exit = new Promise<{ code: number | null; shardJson: string; index: number; count: number }>(
        (resolve) => {
          child.on("close", (code) =>
            resolve({ code, shardJson, index, count: shard.length }),
          );
        },
      );
      return exit;
    });
  // All shards run CONCURRENTLY: each namespace is its own repository, so
  // there is no lock, index or working tree to contend for.
  const finished = await Promise.all(pending);
  const merged: NamespaceResult[] = [];
  for (const shard of finished.sort((left, right) => left.index - right.index)) {
    if (shard.code !== 0) {
      console.error(
        `census shard ${shard.index} (${shard.count} namespaces) failed with status ${shard.code}`,
      );
      process.exit(1);
    }
    const body = JSON.parse(fs.readFileSync(shard.shardJson, "utf-8")) as {
      namespaces: NamespaceResult[];
    };
    merged.push(...body.namespaces);
    fs.rmSync(shard.shardJson, { force: true });
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  return merged;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: path.join(process.cwd(), "namespaces") },
      json: { type: "string" },
      ns: { type: "string" },
      samples: { type: "string", default: "5" },
      jobs: { type: "string", default: "1" },
      "commit-shards": { type: "string", default: "1" },
      "commit-offset": { type: "string" },
      "commit-limit": { type: "string" },
      "fail-on-corrupt": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const root = path.resolve(values.root as string);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`namespaces root not found: ${root}`);
    process.exit(1);
  }
  const sampleLimit = Number.parseInt(values.samples as string, 10);
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) {
    console.error(`--samples must be a non-negative integer`);
    process.exit(1);
  }
  const jobs = Number.parseInt(values.jobs as string, 10);
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error(`--jobs must be a positive integer`);
    process.exit(1);
  }
  const commitShards = Number.parseInt(values["commit-shards"] as string, 10);
  if (!Number.isInteger(commitShards) || commitShards < 1) {
    console.error(`--commit-shards must be a positive integer`);
    process.exit(1);
  }
  const commitOffset = values["commit-offset"] as string | undefined;
  const commitLimit = values["commit-limit"] as string | undefined;
  if ((commitOffset === undefined) !== (commitLimit === undefined)) {
    console.error(`--commit-offset and --commit-limit must be given together`);
    process.exit(1);
  }
  const range =
    commitOffset !== undefined
      ? {
          offset: Number.parseInt(commitOffset, 10),
          limit: Number.parseInt(commitLimit as string, 10),
        }
      : undefined;
  if (
    range !== undefined &&
    (!Number.isInteger(range.offset) ||
      !Number.isInteger(range.limit) ||
      range.offset < 0 ||
      range.limit < 0)
  ) {
    console.error(`--commit-offset/--commit-limit must be non-negative integers`);
    process.exit(1);
  }
  quietFlag = values.quiet === true;
  const only = (values.ns as string | undefined)
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const candidates = listCandidateNamespaces(root);
  const selected =
    only && only.length > 0
      ? candidates.filter((name) => only.includes(name))
      : candidates;
  const missing = only
    ? only.filter((name) => !candidates.includes(name))
    : [];
  if (missing.length > 0) {
    console.error(
      `namespace(s) not found under ${root} (or not git-backed with _audit): ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  const started = Date.now();
  const jsonPath = values.json ? path.resolve(values.json as string) : null;
  let results: NamespaceResult[];
  if (commitShards > 1 && jsonPath !== null) {
    results = await runCommitShards(
      root,
      selected,
      commitShards,
      sampleLimit,
      jsonPath,
    );
  } else if (range !== undefined) {
    results = runCensus(root, selected, sampleLimit, undefined, range);
  } else if (jobs > 1 && selected.length > 1 && jsonPath !== null) {
    if (!values.quiet) {
      console.error(
        `launching ${Math.min(jobs, selected.length)} shard(s) over ${selected.length} namespaces`,
      );
    }
    results = await runShards(
      root,
      selected,
      Math.min(jobs, selected.length),
      sampleLimit,
      jsonPath,
    );
  } else {
    results = runCensus(root, selected, sampleLimit, (result) => {
      if (values.quiet) return;
      const note =
        result.status === "clean"
          ? "clean"
          : result.status === "corrupt"
            ? `CORRUPT ${result.corruptCommits} commit(s) ${JSON.stringify(
                result.classes,
              )} first=${result.samples[0]?.path ?? "?"}:${
                result.samples[0]?.line ?? "?"
              }`
            : `ERROR ${result.error}`;
      console.error(
        `${result.namespace}\t${result.commits} commits\t${result.derivedChanges} changes\t${note}`,
      );
    });
  }

  const report = buildCensusReport(root, candidates.length, results);
  console.error(
    [
      `root=${root}`,
      `namespaces=${report.namespacesScanned}`,
      `commits=${report.commitsScanned}`,
      `poisoned_namespaces=${report.namespacesCorrupt}`,
      `poisoned_commits=${report.corruptCommits}`,
      `errored=${report.namespacesErrored}`,
      `elapsed_ms=${Date.now() - started}`,
    ].join(" "),
  );
  if (jsonPath !== null) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    console.error(`json=${jsonPath}`);
  }
  for (const hit of report.corrupt) {
    const first = hit.firstSample;
    console.error(
      `POISONED ${hit.namespace} commits=${hit.corruptCommits} classes=${JSON.stringify(
        hit.classes,
      )} first_commit=${first?.commit ?? "?"} date=${
        first?.committedAt ?? "unknown"
      } path=${first?.path ?? "?"}:${first?.line ?? "?"}`,
    );
  }
  if (values["fail-on-corrupt"] && report.namespacesCorrupt > 0) {
    process.exit(2);
  }
}

void main();
