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
 *     [--fail-on-corrupt] [--quiet]
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
  listCandidateNamespaces,
  runCensus,
  type NamespaceResult,
} from "../src/ops/changelogCensus.js";

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
  // `execArgv` already carries this process's tsx preflight/loader — drop the
  // `--eval` pair and keep the loader flags so each child runs this very file
  // through the same TypeScript pipeline.
  const evalIndex = process.execArgv.findIndex(
    (arg) => arg === "--eval" || arg === "-e",
  );
  const execArgv =
    evalIndex === -1
      ? process.execArgv
      : process.execArgv.filter(
          (_arg, index) => index !== evalIndex && index !== evalIndex + 1,
        );
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
  if (jobs > 1 && selected.length > 1 && jsonPath !== null) {
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
