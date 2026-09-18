/**
 * CLI-TRUNC-001: `duckbrain remember` must keep flag values that contain "=".
 *
 * `parseArgs` in src/cli/human.ts split flag tokens with `split("=")` and
 * destructured the first two segments, so everything after the SECOND "=" in
 * a token was DROPPED. Any value carrying an assignment, a URL query string or
 * base64 padding was stored truncated at its first "=" — e.g.
 * `alpha rc=1 omega dims=4096 tail=END` (35 chars) was persisted as
 * `alpha rc` (8 chars), while the success line and the UUID looked perfect.
 * That silently shaped fleet narration writes.
 *
 * These tests drive the REAL CLI (`node bin/duckbrain.js remember … --wait`,
 * the foreman's own live command form) in a subprocess and assert on the
 * PARTITION JSONL ROW — not on the exit line. The exit line is not evidence:
 * pre-fix it printed `✓ Remembered …` for truncated data.
 *
 * Hermeticity: the child's write path is redirected with
 * DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_CONFIG_PATH pointed at a scratch dir
 * (save/restore around the suite), so nothing here touches the repo's
 * `namespaces/` or `duckbrain.config.json`, and no daemon is required.
 * The final case asserts that no write leaked into the repo namespace root.
 *
 * Pre-fix (RED) outcome for all three value cases: the two "=" sources store
 * their truncated prefix, and the `--attr=<json>` case fails JSON.parse of the
 * truncated fragment and exits 1 — so the row never lands.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Process-spawning suite: file-scoped budgets (same convention as
// src/git/autocommit-ops006.test.ts and src/s3/cli.test.ts).
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const REPO_NAMESPACES_DIR = path.join(process.cwd(), "namespaces");

const SCRATCH_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-clitrunc001-"),
);
const SCRATCH_NS_ROOT = path.join(SCRATCH_ROOT, "namespaces");
const SCRATCH_CONFIG_PATH = path.join(SCRATCH_ROOT, "duckbrain.config.json");

/** Scratch namespace for this suite — never registered in any config file. */
const NS = "clitrunc001-scratch";

/** Values under test. ONE_EQ has a single "=", MULTI_EQ three of them. */
const ONE_EQ_SOURCE = "alpha rc=1 omega END";
const MULTI_EQ_SOURCE = "alpha rc=1 omega dims=4096 tail=END";
/** The pre-fix truncation of MULTI_EQ_SOURCE (what the bug actually stored). */
const MULTI_EQ_TRUNCATED_PREFIX = "alpha rc";
/** `--attr` JSON whose value contains "=". */
const ATTR_ARG = '--attr={"pattern":"k=v"}';

/** Env vars that gate the write path — saved and restored around this suite. */
const PREV_NS_PATH = process.env.DUCKBRAIN_NAMESPACES_PATH;
const PREV_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;

beforeAll(() => {
  fs.mkdirSync(SCRATCH_NS_ROOT, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = SCRATCH_NS_ROOT;
  process.env.DUCKBRAIN_CONFIG_PATH = SCRATCH_CONFIG_PATH;
});

afterAll(() => {
  if (PREV_NS_PATH === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = PREV_NS_PATH;
  if (PREV_CONFIG_PATH === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = PREV_CONFIG_PATH;
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

/** Spawn the real CLI and capture stdout/stderr until exit or timeout. */
function runCli(
  args: string[],
  timeoutMs = 45_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      // Explicit redirect: the child must never inherit a live namespaces
      // root, whatever the ambient env says.
      env: {
        ...process.env,
        DUCKBRAIN_NAMESPACES_PATH: SCRATCH_NS_ROOT,
        DUCKBRAIN_CONFIG_PATH: SCRATCH_CONFIG_PATH,
        NO_COLOR: "1",
      },
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Every JSONL row written under a namespace, audit sidecar excluded. */
function readNamespaceRows(ns: string): Record<string, unknown>[] {
  const nsDir = path.join(SCRATCH_NS_ROOT, ns);
  const rows: Record<string, unknown>[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(full);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      if (full.split(path.sep).includes("_audit")) continue;
      for (const line of fs.readFileSync(full, "utf8").split("\n")) {
        if (line.trim()) rows.push(JSON.parse(line));
      }
    }
  };
  walk(nsDir);
  return rows;
}

/** The stored row for `key`, plus the raw CLI output for failure messages. */
async function rememberAndReadRow(
  key: string,
  extraArgs: string[],
): Promise<{
  row: Record<string, unknown> | undefined;
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const { code, stdout, stderr } = await runCli([
    "remember",
    key,
    "--domain=concept",
    `--namespace=${NS}`,
    ...extraArgs,
    "--wait",
  ]);
  expect(code, `CLI exit code (stdout=${stdout} stderr=${stderr})`).toBe(0);
  const row = readNamespaceRows(NS).find((r) => r.key === key);
  return { row, code, stdout, stderr };
}

describe("CLI-TRUNC-001: remember keeps flag values containing '='", () => {
  it("a value with ONE '=' round-trips byte-for-byte (length AND tail)", async () => {
    expect(ONE_EQ_SOURCE.split("=").length - 1).toBe(1);

    const { row } = await rememberAndReadRow("/clitrunc001/one-eq", [
      `--content=${ONE_EQ_SOURCE}`,
      `--embedding-text=${ONE_EQ_SOURCE}`,
    ]);

    expect(row, "partition JSONL row for /clitrunc001/one-eq").toBeDefined();
    const stored = row!.embedding_text as string;
    expect(stored).toBe(ONE_EQ_SOURCE);
    expect(stored.length).toBe(ONE_EQ_SOURCE.length);
    expect(stored.endsWith("END")).toBe(true);
    // The pre-fix truncation is not merely shorter — it is a DIFFERENT string.
    expect(stored).not.toBe(ONE_EQ_SOURCE.slice(0, ONE_EQ_SOURCE.indexOf("=")));
  });

  it("a value with MULTIPLE '=' round-trips byte-for-byte", async () => {
    expect(MULTI_EQ_SOURCE.split("=").length - 1).toBe(3);
    expect(MULTI_EQ_SOURCE.length).toBe(35);

    const { row } = await rememberAndReadRow("/clitrunc001/multi-eq", [
      `--content=${MULTI_EQ_SOURCE}`,
      `--embedding-text=${MULTI_EQ_SOURCE}`,
    ]);

    expect(row, "partition JSONL row for /clitrunc001/multi-eq").toBeDefined();
    const stored = row!.embedding_text as string;
    expect(stored).toBe(MULTI_EQ_SOURCE);
    expect(stored.length).toBe(35);
    expect(stored.endsWith("tail=END")).toBe(true);
    // Load-bearing anti-regression: this is what the bug stored.
    expect(stored).not.toBe(MULTI_EQ_TRUNCATED_PREFIX);
  });

  it("an --attr=<json> value containing '=' survives and parses", async () => {
    const body = "attr body without equals";
    const { row } = await rememberAndReadRow("/clitrunc001/attr-eq", [
      `--content=${body}`,
      ATTR_ARG,
    ]);

    expect(row, "partition JSONL row for /clitrunc001/attr-eq").toBeDefined();
    // Pre-fix the truncated fragment `{"pattern":"k` failed JSON.parse and the
    // CLI exited 1 ("--attr must be valid JSON") — no row, no attributes.
    expect(row!.attributes).toEqual({ pattern: "k=v" });
    expect((row!.attributes as Record<string, string>).pattern).toBe("k=v");
    expect(row!.embedding_text).toBe(body);
  });

  it("hermeticity: no write leaked into the repo's own namespaces/ root", () => {
    expect(process.env.DUCKBRAIN_NAMESPACES_PATH).toBe(SCRATCH_NS_ROOT);
    // Positive control: the redirect target is where the rows above were read
    // from, and it exists.
    expect(fs.existsSync(path.join(SCRATCH_NS_ROOT, NS))).toBe(true);
    // Negative control: the same run must not have created a namespace in the
    // repo checkout.
    expect(fs.existsSync(path.join(REPO_NAMESPACES_DIR, NS))).toBe(false);
  });
});
