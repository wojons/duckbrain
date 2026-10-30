#!/usr/bin/env node
/**
 * DuckBrain recall quality benchmark runner (DF-2026-17).
 *
 * Executes a fixed 20-case benchmark (scripts/recall-benchmark/cases.json)
 * against a DuckBrain HTTP surface and reports every rate WITH its
 * denominator: case pass rate, key recall (macro + micro), precision,
 * correct-refusal rate, and unanswered rate. An unanswered case (empty
 * result where a key was expected, or a request error) counts as
 * unanswered — never as correct.
 *
 * Modes:
 *   --scratch            Boot a hermetic DuckBrain instance (embeddings
 *                        disabled via DUCKBRAIN_EMBEDDING_PROVIDER=none, so
 *                        the measurement is the deterministic offline
 *                        keyword surface), seed the fixture corpus, run the
 *                        cases, tear everything down. Used by the nightly
 *                        workflow.
 *   --base-url <url>     Run against an existing surface. Pass --seed to
 *                        plant the fixture corpus first (scratch / staging
 *                        surfaces only — never point this at production
 *                        without meaning it). --api-key / env
 *                        DUCKBRAIN_BENCH_API_KEY sends x-api-key.
 *
 * Exit codes:
 *   0  every case passed and precision >= --min-precision
 *   1  quality failure: at least one missed case, or precision below the
 *      gate (the scheduled run's loud failure)
 *   2  infrastructure failure: bad args, unreadable/invalid fixture,
 *      daemon boot failure, seed failure — NEVER confused with a quality
 *      signal
 *
 * Measurement-only: this script never changes product query behavior; it
 * observes the surface as shipped.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_CASES = path.join(SCRIPT_DIR, "cases.json");

const HEALTH_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------- args ---

function usage() {
  return `Usage: node scripts/recall-benchmark/run.mjs (--scratch | --base-url <url>) [options]

Modes:
  --scratch                 Boot a hermetic instance, seed, measure, tear down.
  --base-url <url>          Measure an existing surface.

Options:
  --cases <path>            Fixture file (default: ${DEFAULT_CASES})
  --seed                    With --base-url: seed the fixture corpus first.
  --api-key <key>           x-api-key header (or env DUCKBRAIN_BENCH_API_KEY).
  --min-precision <float>   Precision gate, default 1.0.
  --limit <n>               Per-case result cap, default ${DEFAULT_LIMIT}.
  --json <path>             Also write the machine-readable report here.
  --help                    This text.`;
}

function parseArgs(argv) {
  const opts = {
    cases: DEFAULT_CASES,
    minPrecision: 1.0,
    limit: DEFAULT_LIMIT,
    seed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    switch (true) {
      case a === "--scratch":
        opts.scratch = true;
        break;
      case a === "--base-url":
        opts.baseUrl = next();
        break;
      case a === "--cases":
        opts.cases = next();
        break;
      case a === "--seed":
        opts.seed = true;
        break;
      case a === "--api-key":
        opts.apiKey = next();
        break;
      case a === "--min-precision":
        opts.minPrecision = Number(next());
        break;
      case a === "--limit":
        opts.limit = Number(next());
        break;
      case a === "--json":
        opts.json = next();
        break;
      case a === "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (opts.scratch && opts.baseUrl)
    throw new Error("--scratch and --base-url are mutually exclusive");
  if (!opts.scratch && !opts.baseUrl)
    throw new Error("Choose a mode: --scratch or --base-url <url>");
  if (opts.seed && !opts.baseUrl)
    throw new Error(
      "--seed only applies to --base-url mode (scratch always seeds)",
    );
  if (
    !Number.isFinite(opts.minPrecision) ||
    opts.minPrecision < 0 ||
    opts.minPrecision > 1
  )
    throw new Error("--min-precision must be a number in [0, 1]");
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000)
    throw new Error("--limit must be an integer in [1, 1000]");
  opts.apiKey = opts.apiKey ?? process.env.DUCKBRAIN_BENCH_API_KEY;
  return opts;
}

// ------------------------------------------------------------- fixture ---

function loadFixture(casesPath, { requireSeed }) {
  let raw;
  try {
    raw = fs.readFileSync(casesPath, "utf8");
  } catch (e) {
    throw new Error(`Fixture unreadable: ${casesPath} (${e.message})`);
  }
  let fixture;
  try {
    fixture = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Fixture is not valid JSON: ${casesPath} (${e.message})`);
  }
  const problems = [];
  if (!fixture.namespace || typeof fixture.namespace !== "string")
    problems.push("fixture.namespace must be a non-empty string");
  if (!Array.isArray(fixture.seed))
    problems.push("fixture.seed must be an array");
  else if (requireSeed && fixture.seed.length === 0)
    problems.push(
      "fixture.seed must be non-empty when seeding (--scratch / --seed)",
    );
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0)
    problems.push("fixture.cases must be a non-empty array");
  if (problems.length > 0)
    throw new Error(`Invalid fixture: ${problems.join("; ")}`);

  const seedKeys = new Set();
  for (const [i, m] of (fixture.seed ?? []).entries()) {
    if (!m || typeof m.key !== "string" || !m.key.startsWith("/"))
      problems.push(`seed[${i}].key must be a path starting with /`);
    else if (seedKeys.has(m.key))
      problems.push(`seed key duplicated: ${m.key}`);
    else seedKeys.add(m.key);
    if (!m || typeof m.domain !== "string" || m.domain === "")
      problems.push(`seed[${i}].domain missing`);
    if (!m || typeof m.content !== "string" || m.content.trim() === "")
      problems.push(`seed[${i}].content must be a non-empty string`);
  }
  const ids = new Set();
  for (const [i, c] of fixture.cases.entries()) {
    if (!Number.isInteger(c?.id))
      problems.push(`cases[${i}].id must be an integer`);
    else if (ids.has(c.id)) problems.push(`case id duplicated: ${c.id}`);
    else ids.add(c.id);
    if (typeof c?.query !== "string" || c.query.trim() === "")
      problems.push(`case ${c?.id ?? i}: query must be a non-empty string`);
    const hasKeys = Array.isArray(c?.expectKeys);
    const hasRefusal = c?.expectRefusal === true;
    if (hasKeys === hasRefusal)
      problems.push(
        `case ${c?.id ?? i}: exactly one of expectKeys / expectRefusal is required`,
      );
    if (hasKeys) {
      for (const k of c.expectKeys)
        if (typeof k !== "string" || !k.startsWith("/"))
          problems.push(
            `case ${c.id}: expectKeys entries must be paths starting with /`,
          );
      if (new Set(c.expectKeys).size !== c.expectKeys.length)
        problems.push(`case ${c.id}: expectKeys contains duplicates`);
    }
  }
  if (problems.length > 0)
    throw new Error(
      `Invalid fixture ${casesPath}:\n  - ${problems.join("\n  - ")}`,
    );
  return { fixture, seedKeys };
}

// ---------------------------------------------------------------- http ---

async function apiFetch(baseUrl, p, { method = "GET", body, apiKey } = {}) {
  const headers = { Host: "localhost" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (apiKey) headers["x-api-key"] = apiKey;
  let res;
  try {
    res = await fetch(`${baseUrl}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      transportError: e instanceof Error ? e.message : String(e),
    };
  }
  let parsed = null;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body — kept as null */
  }
  return { ok: res.ok, status: res.status, body: parsed, rawBody: text };
}

async function waitForHealth(baseUrl, child) {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    // A scratch daemon with embeddings disabled answers /health 200; the
    // repo's own helper accepts 401/503 as "up" too (GAP-030) — match that.
    const r = await apiFetch(baseUrl, "/health").catch(() => null);
    if (r && (r.status === 200 || r.status === 401 || r.status === 503)) return;
    if (child && child.exitCode !== null)
      throw new Error(
        `Daemon exited during boot (code ${child.exitCode}).\n--- stderr tail ---\n${child.stderrTail ?? ""}`,
      );
    await new Promise((r2) => setTimeout(r2, 250));
  }
  throw new Error(
    `Timed out waiting for ${baseUrl}/health after ${HEALTH_TIMEOUT_MS}ms.\n--- stderr tail ---\n${child?.stderrTail ?? ""}`,
  );
}

// -------------------------------------------------------------- scratch ---

function startScratchDaemon() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-recall-bench-"));
  const dataDir = path.join(tmp, "data");
  const namespacesPath = path.join(tmp, "namespaces");
  fs.mkdirSync(path.join(namespacesPath, "default"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const port = 21000 + Math.floor(Math.random() * 9000);
  const args = [
    "--import",
    "tsx",
    "bin/duckbrain.ts",
    "http",
    `--port=${port}`,
    "--auth=none",
    "--rate-limit=100000",
  ];
  // Hermeticity: a benchmark measurement must not inherit the host's
  // DUCKBRAIN_* knobs (an ambient DUCKBRAIN_SEARCH_MIN_SCORE or
  // DUCKBRAIN_NAMESPACE would silently skew every case), so ambient
  // DUCKBRAIN_* is scrubbed and only the explicit pins below reach the
  // daemon.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("DUCKBRAIN_")) env[k] = v;
  }
  Object.assign(env, {
    // Hermetic pins (QA-DUCKBRAIN-002 pattern): scratch data dir,
    // scratch namespaces root, and a deliberately-nonexistent config so
    // cwd discovery cannot find the repo's production registry.
    DUCKBRAIN_DATA_DIR: dataDir,
    DUCKBRAIN_NAMESPACES_PATH: namespacesPath,
    DUCKBRAIN_CONFIG_PATH: path.join(tmp, "duckbrain.config.json"),
    // The benchmark measures the deterministic offline keyword surface:
    // provider=none disables the semantic leg outright (no network, no
    // probing) and every ?q= response carries the keyword-only degraded
    // marker, which the report records per case.
    DUCKBRAIN_EMBEDDING_PROVIDER: "none",
    // Headless git identity (CI-GITID-028) — writes autocommit.
    DUCKBRAIN_GIT_AUTHOR_NAME: "DuckBrain Recall Benchmark",
    DUCKBRAIN_GIT_AUTHOR_EMAIL: "recall-benchmark@example.com",
  });
  const child = spawn("node", args, {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // own process group — teardown kills the whole tree
    env,
  });
  // Rolling stderr tail for boot-failure diagnostics.
  const lines = [];
  let partial = "";
  child.stderr.on("data", (chunk) => {
    partial += chunk.toString();
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      if (lines.length > 50) lines.shift();
    }
  });
  return {
    child,
    tmp,
    baseUrl: `http://127.0.0.1:${port}`,
    get stderrTail() {
      return partial ? `${lines.join("\n")}\n${partial}` : lines.join("\n");
    },
  };
}

async function stopScratchDaemon(state) {
  const { child } = state;
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve("timeout"), 15_000),
  );
  const result = await Promise.race([closed.then(() => "closed"), timeout]);
  if (result === "timeout") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already dead */
    }
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5_000))]);
  }
}

// ----------------------------------------------------------------- seed ---

async function seedCorpus(baseUrl, fixture, apiKey) {
  const seeded = [];
  for (const m of fixture.seed) {
    const r = await apiFetch(baseUrl, "/api/memories", {
      method: "POST",
      apiKey,
      body: {
        key: m.key,
        domain: m.domain,
        content: m.content,
        namespace: fixture.namespace,
      },
    });
    if (!r.ok) {
      throw new Error(
        `Seed POST failed for ${m.key}: HTTP ${r.status} ${r.transportError ?? r.rawBody ?? ""}`,
      );
    }
    seeded.push(m.key);
  }
  // Seed integrity: the plain list path must see every planted row before
  // any case runs — otherwise a seed gap would masquerade as a recall miss.
  const list = await apiFetch(
    baseUrl,
    `/api/memories?namespace=${encodeURIComponent(fixture.namespace)}&limit=1000`,
    { apiKey },
  );
  if (!list.ok || !Array.isArray(list.body?.items)) {
    throw new Error(
      `Seed verification failed: list returned HTTP ${list.status} ${list.transportError ?? ""}`,
    );
  }
  const visible = new Set(list.body.items.map((it) => it.key));
  const missing = seeded.filter((k) => !visible.has(k));
  if (missing.length > 0) {
    throw new Error(
      `Seed verification failed: ${missing.length}/${seeded.length} planted keys not visible: ${missing.join(", ")}`,
    );
  }
  return seeded.length;
}

// ------------------------------------------------------------ execution ---

async function runCase(baseUrl, fixture, benchCase, opts) {
  const ns = benchCase.namespace ?? fixture.namespace;
  const p =
    `/api/memories?namespace=${encodeURIComponent(ns)}` +
    `&q=${encodeURIComponent(benchCase.query)}&limit=${opts.limit}`;
  const r = await apiFetch(baseUrl, p, { apiKey: opts.apiKey });
  const items = Array.isArray(r.body?.items) ? r.body.items : [];
  const returnedKeys = items
    .map((it) => it.key)
    .filter((k) => typeof k === "string");
  const errored = !r.ok || typeof r.body?.error === "string";
  return {
    id: benchCase.id,
    query: benchCase.query,
    namespace: ns,
    httpStatus: r.status,
    ...(r.transportError ? { transportError: r.transportError } : {}),
    ...(errored && r.body?.error ? { error: r.body.error } : {}),
    degraded: r.body?.degraded?.mode,
    returnedKeys,
    errored,
  };
}

function scoreCase(benchCase, outcome, seedKeys) {
  const expectation = benchCase.expectRefusal
    ? { kind: "refusal" }
    : { kind: "keys", keys: benchCase.expectKeys };
  const base = {
    id: benchCase.id,
    query: benchCase.query,
    namespace: outcome.namespace,
    httpStatus: outcome.httpStatus,
    ...(outcome.transportError
      ? { transportError: outcome.transportError }
      : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.degraded ? { degraded: outcome.degraded } : {}),
    returnedKeys: outcome.returnedKeys,
    ...(benchCase.observed ? { observed: benchCase.observed } : {}),
    ...(benchCase.note ? { note: benchCase.note } : {}),
  };
  if (outcome.errored) {
    // An error is never an answer and never a refusal: unanswered + miss.
    return {
      ...base,
      expectation: benchCase.expectRefusal ? "refusal" : "keys",
      ...(benchCase.expectKeys ? { expectKeys: benchCase.expectKeys } : {}),
      verdict: "MISS",
      unanswered: true,
      missing: benchCase.expectKeys ?? [],
      extras: [],
    };
  }
  if (expectation.kind === "refusal") {
    const pass = outcome.returnedKeys.length === 0;
    return {
      ...base,
      expectation: "refusal",
      verdict: pass ? "PASS" : "MISS",
      unanswered: false,
      missing: [],
      extras: pass ? [] : outcome.returnedKeys,
    };
  }
  const returned = new Set(outcome.returnedKeys);
  const missing = expectation.keys.filter((k) => !returned.has(k));
  const extras = outcome.returnedKeys.filter(
    (k) => !expectation.keys.includes(k),
  );
  const unanswered = outcome.returnedKeys.length === 0;
  // Expected keys absent from the seeded corpus are called out: on a seeded
  // surface they can never be found, so the note keeps the miss attributable.
  const notSeeded = expectation.keys.filter((k) => !seedKeys.has(k));
  return {
    ...base,
    expectation: "keys",
    expectKeys: expectation.keys,
    verdict: missing.length === 0 ? "PASS" : "MISS",
    unanswered,
    missing,
    extras,
    ...(notSeeded.length > 0 ? { expectedKeysNotInSeed: notSeeded } : {}),
  };
}

function summarize(results, cases) {
  const total = results.length;
  const passed = results.filter((r) => r.verdict === "PASS").length;
  const missed = results.filter((r) => r.verdict === "MISS").length;
  const unanswered = results.filter((r) => r.unanswered).length;
  const keyCases = results.filter((r) => r.expectation === "keys");
  const refusalCases = results.filter((r) => r.expectation === "refusal");
  const keyCasesSatisfied = keyCases.filter(
    (r) => r.missing.length === 0,
  ).length;
  const expectedTotal = keyCases.reduce((n, r) => n + r.expectKeys.length, 0);
  const expectedHits = keyCases.reduce(
    (n, r) => n + (r.expectKeys.length - r.missing.length),
    0,
  );
  const returnedTotal = keyCases.reduce((n, r) => n + r.returnedKeys.length, 0);
  const refusalsCorrect = refusalCases.filter(
    (r) => !r.errored && r.returnedKeys.length === 0,
  ).length;
  const rate = (numerator, denominator) => ({
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  });
  return {
    cases: { total, executed: total, passed, missed, unanswered },
    rates: {
      casePassRate: rate(passed, total),
      keyRecallMacro: rate(keyCasesSatisfied, keyCases.length),
      keyRecallMicro: rate(expectedHits, expectedTotal),
      precisionMicro: rate(expectedHits, returnedTotal),
      correctRefusalRate: rate(refusalsCorrect, refusalCases.length),
      unansweredRate: rate(unanswered, total),
    },
    keyCaseCount: keyCases.length,
    refusalCaseCount: refusalCases.length,
    caseCountDeclared: cases.length,
  };
}

// --------------------------------------------------------------- report ---

function fmtRate(label, r) {
  const v = r.value === null ? "  n/a" : r.value.toFixed(3);
  return `  ${label.padEnd(24)} ${String(r.numerator).padStart(3)}/${String(r.denominator).padEnd(3)} = ${v}`;
}

function printReport(report) {
  const out = [];
  out.push("DuckBrain recall quality benchmark (DF-2026-17)");
  out.push(`fixture: ${report.fixturePath}`);
  out.push(
    `surface: ${report.surface.mode}${report.surface.baseUrl ? " " + report.surface.baseUrl : ""}`,
  );
  out.push(`namespace: ${report.namespace}`);
  if (report.seeded !== undefined)
    out.push(`seeded: ${report.seeded} memories`);
  out.push(`cases: ${report.cases.executed}/${report.cases.total} executed`);
  out.push("");
  for (const r of report.results) {
    const tag = r.verdict.padEnd(4);
    const expectation =
      r.expectation === "refusal"
        ? "refusal expected"
        : `expected=[${(r.expectKeys ?? []).join(", ")}]`;
    const got = r.errored
      ? `ERROR http=${r.httpStatus} ${r.transportError ?? r.error ?? ""}`
      : `returned=[${r.returnedKeys.join(", ")}]${r.unanswered ? " (unanswered)" : ""}`;
    out.push(
      `[${String(r.id).padStart(2, "0")}] ${tag} q=${JSON.stringify(r.query)} :: ${expectation} :: ${got}`,
    );
  }
  out.push("");
  out.push("rates (numerator/denominator):");
  out.push(fmtRate("case pass rate", report.rates.casePassRate));
  out.push(fmtRate("key recall (macro)", report.rates.keyRecallMacro));
  out.push(fmtRate("key recall (micro)", report.rates.keyRecallMicro));
  out.push(fmtRate("precision (micro)", report.rates.precisionMicro));
  out.push(fmtRate("correct refusal rate", report.rates.correctRefusalRate));
  out.push(fmtRate("unanswered rate", report.rates.unansweredRate));
  out.push("unanswered cases count as unanswered, never as correct");
  const misses = report.results.filter((r) => r.verdict === "MISS");
  if (misses.length > 0) {
    out.push("");
    out.push("misses:");
    for (const r of misses) {
      const detail = r.errored
        ? `request error (http=${r.httpStatus})`
        : r.expectation === "refusal"
          ? `expected refusal, got [${r.returnedKeys.join(", ")}]`
          : [
              r.missing.length > 0 ? `missing=[${r.missing.join(", ")}]` : "",
              r.extras.length > 0 ? `extras=[${r.extras.join(", ")}]` : "",
            ]
              .filter(Boolean)
              .join(" ");
      out.push(
        `  [${String(r.id).padStart(2, "0")}] q=${JSON.stringify(r.query)}: ${detail}`,
      );
    }
  }
  out.push("");
  out.push(`verdict: ${report.verdict}`);
  out.push(`exit code: ${report.exitCode}`);
  console.log(out.join("\n"));
}

// ----------------------------------------------------------------- main ---

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`ERROR: ${e.message}\n\n${usage()}`);
    process.exit(2);
  }

  let fixtureBundle;
  try {
    fixtureBundle = loadFixture(opts.cases, {
      requireSeed: opts.scratch === true || opts.seed === true,
    });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  }
  const { fixture, seedKeys } = fixtureBundle;

  let scratch = null;
  let baseUrl = opts.baseUrl;
  let seeded;
  // process.exit() terminates synchronously — finally blocks do NOT run
  // after it, so the exit code is decided here and process.exit happens
  // only AFTER daemon teardown and temp-dir cleanup below.
  let exitCode;
  try {
    if (opts.scratch) {
      scratch = startScratchDaemon();
      baseUrl = scratch.baseUrl;
      await waitForHealth(baseUrl, scratch.child);
      seeded = await seedCorpus(baseUrl, fixture, opts.apiKey);
    } else {
      baseUrl = baseUrl.replace(/\/+$/, "");
      await waitForHealth(baseUrl, null);
      if (opts.seed) seeded = await seedCorpus(baseUrl, fixture, opts.apiKey);
    }

    const outcomes = [];
    for (const c of fixture.cases) {
      outcomes.push(await runCase(baseUrl, fixture, c, opts));
    }
    const results = fixture.cases.map((c, i) =>
      scoreCase(c, outcomes[i], seedKeys),
    );
    const summary = summarize(results, fixture.cases);

    const precision = summary.rates.precisionMicro;
    const precisionOk =
      precision.denominator === 0
        ? summary.cases.missed > 0 // 0/0 means every key case went unanswered
          ? false
          : true
        : precision.value >= opts.minPrecision;
    const verdict = summary.cases.missed === 0 && precisionOk ? "PASS" : "FAIL";
    exitCode = verdict === "PASS" ? 0 : 1;

    const report = {
      tool: "duckbrain-recall-benchmark",
      task: "DF-2026-17",
      fixturePath: path.relative(REPO_ROOT, path.resolve(opts.cases)),
      startedAt: new Date().toISOString(),
      surface: {
        mode: opts.scratch ? "scratch" : "base-url",
        ...(baseUrl ? { baseUrl } : {}),
      },
      namespace: fixture.namespace,
      ...(seeded !== undefined ? { seeded } : {}),
      minPrecisionGate: opts.minPrecision,
      ...summary,
      results,
      verdict,
      exitCode,
    };
    printReport(report);
    if (opts.json) {
      fs.writeFileSync(
        opts.json,
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      );
      console.log(`report written: ${opts.json}`);
    }
  } catch (e) {
    console.error(
      `INFRASTRUCTURE FAILURE: ${e instanceof Error ? e.message : String(e)}`,
    );
    exitCode = 2;
  }
  if (scratch) {
    await stopScratchDaemon(scratch);
    try {
      fs.rmSync(scratch.tmp, { recursive: true, force: true });
    } catch {
      console.error(`warning: could not remove scratch dir ${scratch.tmp}`);
    }
  }
  process.exit(exitCode);
}

main();
