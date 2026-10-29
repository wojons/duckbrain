/**
 * DF-2026-12: exercise the published CLI entry point, not an in-process
 * TypeScript import. bin/duckbrain.js prefers an existing dist/ build, so the
 * test must run after the CLI build in CI.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type CliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const repoRoot = path.resolve(__dirname, "../..");
const cliEntry = path.join(repoRoot, "bin", "duckbrain.js");
const scratchDirectories: string[] = [];

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-df012-"));
  scratchDirectories.push(scratch);
  const namespacesPath = path.join(scratch, "namespaces");
  fs.mkdirSync(path.join(namespacesPath, "dogfood1027"), { recursive: true });
  const configPath = path.join(scratch, "duckbrain.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ defaultNamespace: "default" }) + "\n",
  );

  return {
    ...process.env,
    HOME: path.join(scratch, "home"),
    DUCKBRAIN_CONFIG_PATH: configPath,
    DUCKBRAIN_NAMESPACES_PATH: namespacesPath,
    DUCKBRAIN_DATA_DIR: path.join(scratch, "data"),
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: node ${cliEntry} ${args.join(" ")}`));
    }, 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

afterEach(() => {
  while (scratchDirectories.length > 0) {
    fs.rmSync(scratchDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("DF-2026-12: bin/duckbrain.js CLI acceptance", () => {
  it("consumes the space-form namespace value", async () => {
    const result = await runCli(
      ["status", "--namespace", "dogfood1027"],
      isolatedEnvironment(),
    );

    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("STALE");
    expect(result.stdout).toContain("Namespace: dogfood1027");
    expect(result.stdout).toContain("Status: OK");
    expect(result.stdout).not.toContain("Namespace: true");
    expect(result.stdout).not.toContain("./memory/default");
  });

  it("rejects an unknown explicit namespace", async () => {
    const result = await runCli(
      ["status", "--namespace", "does-not-exist-df012"],
      isolatedEnvironment(),
    );

    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("Status: OK");
    expect(result.stdout).not.toContain("./memory/default");
    expect(result.stderr).toContain(
      "Error: Namespace 'does-not-exist-df012' does not exist.",
    );
  });
});

// ch:trace:row=DF-2026-12 spec=.coding-hermes/board/tasks.jsonl#DF-2026-12 test=tests/cli-bin-e2e-df012.test.ts
