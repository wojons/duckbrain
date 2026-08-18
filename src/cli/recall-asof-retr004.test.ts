/**
 * RETR-004 Regression Tests: memory-as-of via the CLI `recall --as-of`.
 *
 * Guards src/cli/human.ts recallCommand against a REAL git-backed namespace
 * (per-namespace repo under the DUCKBRAIN_NAMESPACES_PATH temp root):
 *   - `recall --as-of=<first commit>` prints exactly the rows at that ref
 *   - `--as-of=<date>` resolves to the nearest commit at-or-before it
 *   - invalid refs exit cleanly with a message (no stack, no partial query)
 *   - `recall --help` lists the new flag
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { runHumanCLI } from "./human";

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "default");
const PARTITION = path.join(NS, "concept", "2026-07");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

const D1 = "2026-07-01T10:00:00Z";
const D2 = "2026-08-01T10:00:00Z";

function git(dir: string, args: string, env?: Record<string, string>): string {
  return execSync(`git ${args}`, {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  })
    .toString()
    .trim();
}

function commitAll(msg: string, date: string): string {
  git(NS, "add -A");
  git(NS, `commit -qm "${msg}"`, {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(NS, "rev-parse HEAD");
}

function mem(id: string, key: string, timestamp: string, text: string): string {
  return JSON.stringify({
    id,
    key,
    domain: "concept",
    timestamp,
    author: "test@example.com",
    action: "add",
    embedding_text: text,
    attributes: {},
  });
}

let sha1: string;

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  git(NS, "init -q");
  git(NS, 'config user.email "test@example.com"');
  git(NS, 'config user.name "Test"');

  fs.writeFileSync(
    JSONL,
    mem(
      "cli-asof-1",
      "/cliasof/one",
      "2026-07-01T08:00:00.000Z",
      "cli first memory",
    ) + "\n",
  );
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["concept/2026-07"],
      lastUpdated: new Date().toISOString(),
    }),
  );
  sha1 = commitAll("cli first memory", D1);

  fs.writeFileSync(
    JSONL,
    mem(
      "cli-asof-1",
      "/cliasof/one",
      "2026-07-01T08:00:00.000Z",
      "cli first memory",
    ) +
      "\n" +
      mem(
        "cli-asof-2",
        "/cliasof/two",
        "2026-07-20T08:00:00.000Z",
        "cli second memory",
      ) +
      "\n",
  );
  commitAll("cli second memory", D2);
});

afterAll(() => {
  fs.rmSync(NS, { recursive: true, force: true });
});

function capture(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: any[]) => logs.push(a.map(String).join(" ")));
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: any[]) => errors.push(a.map(String).join(" ")));
  return {
    logs,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("RETR-004: memory-as-of — CLI recall --as-of", () => {
  it("--as-of=<first commit> prints exactly the rows at that ref", async () => {
    const { logs, restore } = capture();
    try {
      await runHumanCLI("recall", [
        `--as-of=${sha1}`,
        "--prefix=/cliasof/",
        "--namespace=default",
      ]);
    } finally {
      restore();
    }
    const output = logs.join("\n");
    expect(output).toContain("Found 1 memories");
    expect(output).toContain("cli first memory");
    expect(output).not.toContain("cli second memory");
  });

  it("--as-of=<date> resolves to the nearest commit at-or-before it", async () => {
    const { logs, restore } = capture();
    try {
      await runHumanCLI("recall", [
        "--as-of=2026-07-15",
        "--prefix=/cliasof/",
        "--namespace=default",
      ]);
    } finally {
      restore();
    }
    const output = logs.join("\n");
    expect(output).toContain("Found 1 memories");
    expect(output).toContain("cli first memory");
    expect(output).not.toContain("cli second memory");
  });

  it("current-state recall (no --as-of) still returns both rows", async () => {
    const { logs, restore } = capture();
    try {
      await runHumanCLI("recall", [
        "--prefix=/cliasof/",
        "--namespace=default",
      ]);
    } finally {
      restore();
    }
    const output = logs.join("\n");
    expect(output).toContain("Found 2 memories");
    expect(output).toContain("cli first memory");
    expect(output).toContain("cli second memory");
  });

  it("an invalid --as-of value exits cleanly with a message", async () => {
    const { errors, restore } = capture();
    try {
      // process.exit(1) is converted to a throw by vitest (same pattern as
      // remember-dogfood003.test.ts), so rejects captures the exit.
      await expect(
        runHumanCLI("recall", ["--as-of=not-a-ref", "--namespace=default"]),
      ).rejects.toThrow(/process\.exit/);
    } finally {
      restore();
    }
    expect(errors.join("\n")).toMatch(/Invalid --as-of value 'not-a-ref'/);
  });

  it("--help lists the --as-of flag", async () => {
    const { logs, restore } = capture();
    try {
      await runHumanCLI("recall", ["--help"]);
    } finally {
      restore();
    }
    expect(logs.join("\n")).toContain("--as-of=<ref>");
  });
});
