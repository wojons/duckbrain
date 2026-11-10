/**
 * QA-DUCKBRAIN-022 — malformed JSONL lines must never vanish silently.
 *
 * Pre-fix behaviour (reproduced live on 2026-11-09): a torn record at the tail
 * of a namespace's active chunk (`<ns>/<domain>/<YYYY-MM>/current.jsonl`) was
 * dropped by the DuckDB serving read (`read_json(..., ignore_errors=true)`)
 * with rc=0 and nothing on stdout/stderr, and `status` still said `Status: OK`.
 * Meanwhile `readFromJsonl` THREW `Invalid JSON or schema at line N` for the
 * same bytes, so the two readers disagreed (AC4).
 *
 * This suite pins the post-fix contract:
 *   1. the shared scanner reports the count and the exact path:line (AC1/AC4)
 *   2. `readFromJsonl` no longer throws and reports the SAME count as the
 *      scanner used by the serving read path (AC4)
 *   3. `recall` / `search` warn on stderr naming count + path:line (AC1)
 *   4. `status` no longer prints `Status: OK` (AC2)
 *   5. a clean namespace stays silent, and its status line is unchanged
 *
 * CLI arms drive the real binary in a subprocess (same convention as
 * src/cli/remember-eq-value-clitrunc001.test.ts) with the write path redirected
 * through DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_CONFIG_PATH.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  auditNamespace,
  collectNamespaceChunkFiles,
  resetCorruptionCache,
  scanMalformedLines,
} from "./corruption";
import { readFromJsonlWithReport } from "./jsonl";

vi.setConfig({ hookTimeout: 60_000, testTimeout: 90_000 });

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");

const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-qa022-"));

const PREV_NS_PATH = process.env.DUCKBRAIN_NAMESPACES_PATH;
const PREV_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;

/** A record truncated mid-JSON — the real crash/disk-full half-line shape. */
const TORN_LINE = '{"id":"torn","key":"/probe/tw';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], namespaceRoot: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd: SCRATCH_ROOT,
      env: {
        ...process.env,
        DUCKBRAIN_NAMESPACES_PATH: namespaceRoot,
        DUCKBRAIN_CONFIG_PATH: path.join(SCRATCH_ROOT, "none.json"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Write a namespace whose active chunk holds ONE intact record + ONE torn line. */
function makeCorruptNamespace(name: string): {
  nsRoot: string;
  namespacePath: string;
  chunkPath: string;
} {
  const nsRoot = path.join(SCRATCH_ROOT, name);
  const namespacePath = path.join(nsRoot, name);
  const chunkDir = path.join(namespacePath, "event", "2026-11");
  fs.mkdirSync(chunkDir, { recursive: true });

  const record = {
    id: "11111111-1111-4111-8111-111111111111",
    key: "/probe/one",
    domain: "event",
    timestamp: "2026-11-10T00:00:00.000Z",
    author: "qa022@example.com",
    action: "add",
    embedding_text: "alpha",
    attributes: {},
  };
  const chunkPath = path.join(chunkDir, "current.jsonl");
  fs.writeFileSync(chunkPath, `${JSON.stringify(record)}\n${TORN_LINE}\n`);
  return { nsRoot, namespacePath, chunkPath };
}

/** A fully clean namespace: one intact record, no torn line. */
function makeCleanNamespace(name: string): { nsRoot: string; namespacePath: string } {
  const nsRoot = path.join(SCRATCH_ROOT, name);
  const namespacePath = path.join(nsRoot, name);
  const chunkDir = path.join(namespacePath, "event", "2026-11");
  fs.mkdirSync(chunkDir, { recursive: true });
  const record = {
    id: "22222222-2222-4222-8222-222222222222",
    key: "/probe/two",
    domain: "event",
    timestamp: "2026-11-10T00:00:00.000Z",
    author: "qa022@example.com",
    action: "add",
    embedding_text: "beta",
    attributes: {},
  };
  fs.writeFileSync(path.join(chunkDir, "current.jsonl"), `${JSON.stringify(record)}\n`);
  return { nsRoot, namespacePath };
}

beforeEach(() => {
  resetCorruptionCache();
});

afterAll(() => {
  if (PREV_NS_PATH === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = PREV_NS_PATH;
  if (PREV_CONFIG_PATH === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = PREV_CONFIG_PATH;
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe("QA-DUCKBRAIN-022 shared scanner", () => {
  it("counts the torn line and reports its path:line", () => {
    const { namespacePath, chunkPath } = makeCorruptNamespace("scanner-ns");
    const report = scanMalformedLines(collectNamespaceChunkFiles(namespacePath));

    expect(report.skipped).toBe(1);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.path).toBe(chunkPath);
    expect(report.files[0]?.line).toBe(2);
  });

  it("keeps the serving-read entry point and readFromJsonl on the SAME count", () => {
    const { namespacePath, chunkPath } = makeCorruptNamespace("parity-ns");
    const stderr: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      stderr.push(String(message));
    });

    // Serving-read side (`auditServingChunks` delegates here).
    const serving = auditNamespace(namespacePath);
    // JSONL-read side: must NOT throw the old `Invalid JSON or schema` error.
    const read = readFromJsonlWithReport(chunkPath);

    spy.mockRestore();

    expect(serving.skipped).toBe(1);
    expect(read.corruption.skipped).toBe(1);
    expect(read.corruption.skipped).toBe(serving.skipped);
    // One intact record survives on both sides — same short page, same count.
    expect(read.records).toHaveLength(1);
    // Both warned, naming the count and the path.
    const joined = stderr.join("\n");
    expect(joined).toContain("1 malformed record skipped");
    expect(joined).toContain(chunkPath);
  });

  it("does not throw from readFromJsonl (AC4: one policy, never a throw)", () => {
    const { chunkPath } = makeCorruptNamespace("nothrow-ns");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => readFromJsonlWithReport(chunkPath)).not.toThrow();
    spy.mockRestore();
  });

  it("stays silent for a clean namespace", () => {
    const { namespacePath } = makeCleanNamespace("clean-ns");
    const stderr: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      stderr.push(String(message));
    });

    const report = auditNamespace(namespacePath);
    const read = readFromJsonlWithReport(
      path.join(namespacePath, "event", "2026-11", "current.jsonl"),
    );

    spy.mockRestore();

    expect(report.skipped).toBe(0);
    expect(read.corruption.skipped).toBe(0);
    expect(read.records).toHaveLength(1);
    expect(stderr).toHaveLength(0);
  });

  it("treats a missing chunk as absent, not corrupt", () => {
    const report = scanMalformedLines([
      path.join(SCRATCH_ROOT, "does-not-exist", "current.jsonl"),
    ]);
    expect(report.skipped).toBe(0);
    expect(report.files).toHaveLength(0);
  });
});

describe("QA-DUCKBRAIN-022 CLI arms", () => {
  it("recall warns with count + path:line (AC1)", async () => {
    const { nsRoot } = makeCorruptNamespace("cli-recall");
    const run = await runCli(["recall", "--namespace=cli-recall"], nsRoot);

    expect(run.stderr).toContain("1 malformed record skipped");
    expect(run.stderr).toContain("current.jsonl:2");
  }, 90_000);

  it("search warns with count + path:line (AC1)", async () => {
    const { nsRoot } = makeCorruptNamespace("cli-search");
    const run = await runCli(["search", "alpha", "--namespace=cli-search"], nsRoot);
    expect(run.stderr).toContain("1 malformed record skipped");
    expect(run.stderr).toContain("current.jsonl:2");
  }, 90_000);

  it("status reports DEGRADED instead of OK, and exits non-zero (AC2)", async () => {
    const { nsRoot } = makeCorruptNamespace("cli-status");
    const run = await runCli(["status", "--namespace=cli-status"], nsRoot);
    expect(run.stdout).not.toContain("Status: OK");
    expect(run.stdout).toContain("Status: DEGRADED");
    expect(run.stdout).toContain("Corruption:");
    expect(run.stdout).toContain("current.jsonl:2");
    expect(run.code).not.toBe(0);
  }, 90_000);

  it("a clean namespace keeps `Status: OK` and adds no noise", async () => {
    const { nsRoot } = makeCleanNamespace("cli-clean");
    const run = await runCli(["status", "--namespace=cli-clean"], nsRoot);
    expect(run.stdout).toContain("Status: OK");
    expect(run.stdout).not.toContain("DEGRADED");
    expect(run.stderr).not.toContain("malformed");
    expect(run.code).toBe(0);
  }, 90_000);
});
