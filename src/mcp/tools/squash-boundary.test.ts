import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { squashTool } from "./squash";
import { compactHistory } from "../../git/squash";
import type { AuthPrincipal } from "../../auth/middleware";

const root = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const namespace = path.join(root, "default");
const fixture = path.join(namespace, "squash-boundary-fixture");
const outside = path.join(root, "squash-boundary-outside");
const data = '{"id":"secret","action":"remember"}\n';
const principal: AuthPrincipal = {
  name: "scoped",
  authenticated: true,
  tokenType: "apikey",
  roles: ["writer"],
  namespaces: ["default"],
};

beforeAll(() => {
  if (!root || !process.env.DUCKBRAIN_CONFIG_PATH)
    throw new Error("Isolated test setup required");
  fs.mkdirSync(path.join(fixture, "valid"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(fixture, "valid", "data.jsonl"), data);
  fs.writeFileSync(path.join(outside, "data.jsonl"), data);
  fs.symlinkSync(outside, path.join(fixture, "link"));
  fs.mkdirSync(path.join(fixture, "file-link"));
  fs.symlinkSync(
    path.join(outside, "data.jsonl"),
    path.join(fixture, "file-link", "data.jsonl"),
  );
});
afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("squash namespace boundary", () => {
  const invoke = (partition: string, dryRun = true) =>
    squashTool(
      { namespace: "default", partition, dryRun, aggressive: false },
      { principal },
    );
  it.each([false, true])(
    "rejects external absolute and traversal paths, dryRun=%s",
    async (dryRun) => {
      for (const partition of [
        outside,
        path.relative(namespace, outside),
        path.join(fixture, "link"),
        path.join(fixture, "file-link"),
      ]) {
        const result = await invoke(partition, dryRun);
        expect(result.success).toBe(false);
        expect(result.message).toContain("inside the selected namespace");
        expect(fs.readFileSync(path.join(outside, "data.jsonl"), "utf8")).toBe(
          data,
        );
        expect(fs.readdirSync(outside)).toEqual(["data.jsonl"]);
      }
    },
  );
  it("rejects symlink escapes listed in a compaction manifest", async () => {
    const isolated = path.join(fixture, "history");
    fs.mkdirSync(isolated);
    fs.symlinkSync(outside, path.join(isolated, "escape"));
    fs.writeFileSync(
      path.join(isolated, "manifest.json"),
      JSON.stringify({ partitions: ["escape"], lastUpdated: "2020-01-01" }),
    );
    const result = await compactHistory({
      namespacePath: isolated,
      dryRun: false,
      threshold: 0,
      maxAge: 0,
      squashCommits: false,
    });
    expect(result.success).toBe(false);
    expect(result.errors?.join()).toContain("inside the selected namespace");
    expect(fs.readFileSync(path.join(outside, "data.jsonl"), "utf8")).toBe(
      data,
    );
    expect(fs.readdirSync(outside)).toEqual(["data.jsonl"]);
  });
  it("compacts an authorized partition for real", async () => {
    const dir = path.join(fixture, "write");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "data.jsonl"), data);
    const result = await invoke("squash-boundary-fixture/write", false);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(dir, "data.jsonl"))).toBe(false);
    expect(fs.readdirSync(dir).some((file) => file.endsWith(".parquet"))).toBe(
      true,
    );
  });
  it("accepts in-namespace relative and absolute partitions", async () => {
    for (const partition of [
      "squash-boundary-fixture/valid",
      path.join(fixture, "valid"),
    ]) {
      const result = await invoke(partition);
      expect(result.success).toBe(true);
      expect(result.stats?.totalRecordsKept).toBe(1);
    }
  });
});
