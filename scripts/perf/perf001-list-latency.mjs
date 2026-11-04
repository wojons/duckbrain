#!/usr/bin/env node
/**
 * PERF-DUCKBRAIN-001 reproducible plain-list sampler.
 *
 * Start an isolated daemon first, then run:
 *   DUCKBRAIN_NAMESPACES_PATH=/path/to/namespaces \
 *     node scripts/perf/perf001-list-latency.mjs http://127.0.0.1:28731
 *
 * Each request independently executes the plain-list path (no response cache).
 * The daemon should be freshly started before sampling to measure its cold
 * application state. The operating-system page cache is intentionally not
 * flushed, since doing so would affect the whole host.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:28731";
const namespacesPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
if (!namespacesPath) {
  console.error("Set DUCKBRAIN_NAMESPACES_PATH to the benchmark data copy.");
  process.exit(2);
}

function countJsonlFiles(root) {
  let count = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if ([".git", ".embeddings", ".search", ".keys"].includes(entry.name)) continue;
        walk(fullPath);
      } else if (entry.name.endsWith(".jsonl")) {
        count += 1;
      }
    }
  };
  walk(root);
  return count;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

for (const namespace of ["coding-hermes", "fleet-quality"]) {
  const namespacePath = path.join(namespacesPath, namespace);
  if (!fs.statSync(namespacePath).isDirectory()) {
    throw new Error(`Namespace directory not found: ${namespacePath}`);
  }
  const fileCount = countJsonlFiles(namespacePath);
  const samplesMs = [];
  // Request 1 is cold for this namespace in a freshly started daemon process;
  // requests 2-4 are the three warm repeats used by the acceptance report.
  for (let run = 0; run < 4; run += 1) {
    const url = new URL("/api/memories", baseUrl);
    url.searchParams.set("namespace", namespace);
    url.searchParams.set("limit", "10");
    const started = performance.now();
    const response = await fetch(url);
    const elapsedMs = performance.now() - started;
    if (!response.ok) {
      throw new Error(`${namespace} run ${run + 1}: HTTP ${response.status}`);
    }
    const body = await response.json();
    if (body.error || !Array.isArray(body.items) || body.items.length > 10) {
      throw new Error(`${namespace} run ${run + 1}: invalid list response`);
    }
    samplesMs.push(elapsedMs);
  }
  console.log(
    `${namespace}: files=${fileCount} limit=10 cold_ms=${samplesMs[0].toFixed(1)} warm_ms=${samplesMs.slice(1).map((n) => n.toFixed(1)).join(",")} warm_median_ms=${median(samplesMs.slice(1)).toFixed(1)}`,
  );
}
