import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { forgetTool } from "./forget";
import { rememberTool } from "./remember";
import { resetSerializerStateForTests } from "../../serialization/namespaceWriter";
import { drainAsyncCommits } from "../../git/autocommit";

describe("SUPA-2 memory write-path wiring", () => {
  let root: string;
  let oldRoot: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa2-wiring-"));
    oldRoot = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = root;
    resetSerializerStateForTests();
  });

  afterEach(async () => {
    resetSerializerStateForTests();
    // The tools above schedule REAL async git commits (this suite does not
    // override scheduleCommit). A commit landing inside rmSync's unlink
    // walk races it: ENOTEMPTY on the in-flight .git. Drain before removing.
    await drainAsyncCommits();
    if (oldRoot === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    else process.env.DUCKBRAIN_NAMESPACES_PATH = oldRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("routes remember and forget/tombstone through the namespace serializer", async () => {
    const remembered = await rememberTool({
      key: "/supa2/wiring",
      domain: "concept",
      attributes: {},
      embedding_text: "serializer wiring",
      namespace: "wired",
    });
    expect(remembered.success).toBe(true);

    const forgotten = await forgetTool({
      id: remembered.id!,
      namespace: "wired",
    });
    expect(forgotten.success).toBe(true);

    const dataRows: any[] = [];
    const dataRoot = path.join(root, "wired/concept");
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".jsonl")) {
          dataRows.push(
            ...fs
              .readFileSync(full, "utf-8")
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line)),
          );
        }
      }
    };
    walk(dataRoot);
    expect(dataRows.map((row) => row.action)).toEqual(["add", "tombstone"]);

    const auditRows = fs
      .readFileSync(path.join(root, "wired/_audit/current.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row.outcome)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("contains no direct production append bypass in remember or queries", () => {
    const rememberSource = fs.readFileSync(
      path.resolve(__dirname, "remember.ts"),
      "utf-8",
    );
    const queriesSource = fs.readFileSync(
      path.resolve(__dirname, "../../duckdb/queries.ts"),
      "utf-8",
    );
    expect(rememberSource).not.toMatch(
      /append(ToJsonl|JsonlDurable|JsonlDirect)\s*\(/,
    );
    expect(queriesSource).not.toMatch(/fs\.appendFileSync\s*\(/);
  });
});
