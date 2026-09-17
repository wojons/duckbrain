/**
 * DB-SUPA-6 AC-2 — historical manifest reading stays compatible.
 *
 * `src/git/asof.ts` reads the manifest as it existed at a ref. DB-SUPA-6 adds
 * a SEPARATE artifact (`schema.json`) and never changes manifest semantics, so
 * a ref that predates the DDL must still resolve exactly as before, and a
 * schema.json committed alongside it must never leak into the partition index.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { readManifestAtRef, readRowsAtRef } from "./asof";
import { createTable } from "../serialization/ddl";
import { loadNamespaceSchema } from "../serialization/schemaRegistry";
import type { AuthPrincipal } from "../auth/middleware";

const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};

const roots: string[] = [];

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "duckbrain-test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "duckbrain-test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function makeRepo(): { repoDir: string; manifestCommit: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-asof-"));
  roots.push(repoDir);
  fs.mkdirSync(path.join(repoDir, "concept", "2026-08"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "manifest.json"),
    `${JSON.stringify({ partitions: ["concept/2026-08/"], lastUpdated: "2026-08-31T00:00:00.000Z" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(repoDir, "concept", "2026-08", "current.jsonl"),
    `${JSON.stringify({
      id: "/concept/one",
      key: "/concept/one",
      domain: "concept",
      embedding_text: "one",
      updatedAt: "2026-08-31T00:00:00.000Z",
    })}\n`,
  );
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "memory rows"]);
  return { repoDir, manifestCommit: git(repoDir, ["rev-parse", "HEAD"]) };
}

afterEach(() => {
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("SUPA-6 historical manifest compatibility", () => {
  it("historical manifest remains readable", async () => {
    const { repoDir, manifestCommit } = makeRepo();
    const ns = path.basename(repoDir);
    const namespacesPath = path.dirname(repoDir);

    // A real DDL operation in the same namespace, committed as evidence.
    const created = await createTable(
      ns,
      {
        table: "events",
        rowShape: "object",
        keyColumns: ["id"],
        storagePath: "events/2026-09/current.jsonl",
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "kind", type: "string", nullable: false },
        ],
      },
      {
        namespacesPath,
        principal: ADMIN,
        scheduleCommit: () => undefined,
      },
    );
    expect(created.ok).toBe(true);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-q", "-m", "feat(schema): declare events"]);
    const head = git(repoDir, ["rev-parse", "HEAD"]);
    expect(head).not.toBe(manifestCommit);

    // The pre-DDL ref still resolves through the manifest exactly as before:
    // DB-SUPA-6 changed no manifest field and no reader.
    const historical = readManifestAtRef(repoDir, manifestCommit);
    expect(historical).toEqual({
      partitions: ["concept/2026-08/"],
      lastUpdated: "2026-08-31T00:00:00.000Z",
    });
    const historicalRows = readRowsAtRef(repoDir, manifestCommit);
    expect(historicalRows.map((row) => row.id)).toEqual(["/concept/one"]);

    // The DDL commit added schema.json — which must NOT appear as a partition
    // and must not disturb the manifest read at HEAD.
    const headManifest = readManifestAtRef(repoDir, head);
    expect(headManifest?.partitions).toEqual(["concept/2026-08/"]);
    expect(git(repoDir, ["show", `${head}:schema.json`])).toMatch(
      /"schemaVersion"/,
    );
    expect(git(repoDir, ["show", `${head}:manifest.json`])).not.toMatch(
      /schemaVersion|tables/,
    );

    // The declared table resolves through its declared path while the manifest
    // keeps meaning "active physical partitions".
    const schema = loadNamespaceSchema(ns, { namespacesPath }).document;
    expect(schema.tables.events?.storage.path).toBe(
      "events/2026-09/current.jsonl",
    );
    expect(headManifest?.partitions).not.toContain("events/2026-09/");
    // The DDL commit stages schema.json plus its migration evidence; the
    // manifest is untouched because this path is not a physical partition.
    const ddlCommitFiles = git(repoDir, [
      "show",
      "--name-only",
      "--format=",
      head,
    ]).split("\n");
    expect(ddlCommitFiles).toContain("schema.json");
    expect(
      ddlCommitFiles.some((file) => file.startsWith(".duckbrain-ddl/")),
    ).toBe(true);
    expect(ddlCommitFiles).not.toContain("manifest.json");
  });
});
