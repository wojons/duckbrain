/**
 * Tests for human operator CLI commands
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { runHumanCLI } from "./human";
import fs from "fs";
import path from "path";

describe("human CLI commands", () => {
  it("should export runHumanCLI function", () => {
    expect(runHumanCLI).toBeDefined();
    expect(typeof runHumanCLI).toBe("function");
  });

  it("should handle help command", async () => {
    // Verify help command doesn't throw
    await expect(runHumanCLI("help", [])).resolves.not.toThrow();
  });

  it("should handle unknown command with error", async () => {
    await expect(runHumanCLI("unknown-command", [])).rejects.toThrow();
  });
});

/**
 * RETR-003: `duckbrain recall --after/--before/--between` flags reach the
 * recall path and window the results. Runs the real CLI command against a
 * seeded namespace under the DUCKBRAIN_NAMESPACES_PATH temp root and
 * captures the printed output.
 */
describe("RETR-003: time-scoped recall — CLI recall flags", () => {
  const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
  const NS = path.join(NS_ROOT, "default");
  const PARTITION = path.join(NS, "concept", "2026-08");
  const JSONL = path.join(PARTITION, "current.jsonl");
  const MANIFEST = path.join(NS, "manifest.json");

  function mem(id: string, day: string, text: string): string {
    return JSON.stringify({
      id,
      key: `/clitest/${id}`,
      domain: "concept",
      timestamp: `2026-08-${day}T12:00:00.000Z`,
      author: "test@example.com",
      action: "add",
      embedding_text: text,
      attributes: {},
    });
  }

  beforeAll(() => {
    fs.mkdirSync(PARTITION, { recursive: true });
    fs.writeFileSync(
      JSONL,
      [
        mem("c-in-1", "11", "inside window one"),
        mem("c-in-2", "12", "inside window two"),
        mem("c-out", "14", "outside window"),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({
        partitions: ["concept/2026-08"],
        lastUpdated: new Date().toISOString(),
      }),
    );
  });

  afterAll(() => {
    fs.rmSync(PARTITION, { recursive: true, force: true });
    fs.rmSync(MANIFEST, { force: true });
  });

  function captureLog(): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: any[]) => {
        calls.push(args.map(String).join(" "));
      });
    return { calls, restore: () => spy.mockRestore() };
  }

  it("--after/--before window the printed recall results", async () => {
    const { calls, restore } = captureLog();
    try {
      await runHumanCLI("recall", [
        "--prefix=/clitest/",
        "--after=2026-08-11",
        "--before=2026-08-12",
        "--namespace=default",
      ]);
    } finally {
      restore();
    }

    const output = calls.join("\n");
    expect(output).toContain("Found 2 memories");
    expect(output).toContain("inside window one");
    expect(output).toContain("inside window two");
    expect(output).not.toContain("outside window");
  });

  it("--between expands to the same window", async () => {
    const { calls, restore } = captureLog();
    try {
      await runHumanCLI("recall", [
        "--prefix=/clitest/",
        "--between=2026-08-11,2026-08-12",
        "--namespace=default",
      ]);
    } finally {
      restore();
    }

    const output = calls.join("\n");
    expect(output).toContain("Found 2 memories");
    expect(output).not.toContain("outside window");
  });

  it("--help lists the new time-scoped flags", async () => {
    const { calls, restore } = captureLog();
    try {
      await runHumanCLI("recall", ["--help"]);
    } finally {
      restore();
    }

    const output = calls.join("\n");
    expect(output).toContain("--after=<iso>");
    expect(output).toContain("--before=<iso>");
    expect(output).toContain("--between=<a,b>");
  });
});
