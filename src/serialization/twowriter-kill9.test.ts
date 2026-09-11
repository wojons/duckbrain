import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createMemory } from "../schema/memory";
import { NamespaceWriter } from "./namespaceWriter";

function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`child output: ${output}`)),
      10_000,
    );
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early (${code}): ${output}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child did not exit")),
      10_000,
    );
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function memory(key: string) {
  return createMemory({
    key,
    domain: "concept",
    author: "test@example.com",
    embedding_text: key,
  });
}

function input(key: string) {
  return {
    ns: "shared",
    table: "memories",
    op: "insert" as const,
    record: memory(key),
    principal: undefined,
    targetPath: "concept/2026-09/current.jsonl",
    partitionPath: "concept/2026-09/",
  };
}

function readKeys(root: string): string[] {
  const file = path.join(root, "shared/concept/2026-09/current.jsonl");
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line).key);
}

describe("SUPA-2 cross-process writer recovery", () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    children.length = 0;
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("excludes a live owner, recovers after SIGKILL, and keeps every acknowledged row", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-supa2-xproc-"),
    );
    roots.push(root);
    fs.mkdirSync(path.join(root, "shared"), { recursive: true });
    const helper = path.join(root, "writer-holder.ts");
    const writerModule = path.resolve(__dirname, "namespaceWriter.ts");
    const memoryModule = path.resolve(__dirname, "../schema/memory.ts");
    fs.writeFileSync(
      helper,
      `import { NamespaceWriter } from ${JSON.stringify(writerModule)};\n` +
        `import { createMemory } from ${JSON.stringify(memoryModule)};\n` +
        `import { acquireNamespaceWriteLock } from ${JSON.stringify(path.resolve(__dirname, "lock.ts"))};\n` +
        `void (async () => {\n` +
        `const root = process.argv[2];\n` +
        `const writer = new NamespaceWriter("shared", { namespacesPath: root, scheduleCommit: () => undefined });\n` +
        `const record = createMemory({ key: "/child/acked", domain: "concept", author: "test@example.com", embedding_text: "acked" });\n` +
        `const result = await writer.enqueue({ ns: "shared", table: "memories", op: "insert", record, principal: undefined, targetPath: "concept/2026-09/current.jsonl", partitionPath: "concept/2026-09/" });\n` +
        `if (!result.ok) throw new Error(result.code);\n` +
        `console.log("ACKED");\n` +
        `const lock = acquireNamespaceWriteLock(root, "shared");\n` +
        `if (!lock) throw new Error("lock not acquired");\n` +
        `console.log("LOCKED");\n` +
        `setInterval(() => {}, 1000);\n` +
        `})().catch((error) => { console.error(error); process.exit(1); });\n`,
    );

    const child = spawn(process.execPath, ["--import", "tsx", helper, root], {
      cwd: path.resolve(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForLine(child, "LOCKED");

    const contender = new NamespaceWriter("shared", {
      namespacesPath: root,
      scheduleCommit: () => undefined,
    });
    const excluded = await contender.enqueue(input("/parent/excluded"));
    expect(excluded).toMatchObject({ ok: false, code: "SERIALIZER_LOCKED" });
    expect(readKeys(root)).toEqual(["/child/acked"]);

    child.kill("SIGKILL");
    await waitForExit(child);
    const recovered = await contender.enqueue(input("/parent/acked"));
    expect(recovered).toMatchObject({ ok: true });
    expect(readKeys(root)).toEqual(["/child/acked", "/parent/acked"]);
  });
});
