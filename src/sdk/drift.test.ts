/**
 * SDK-PARITY-001 AC-4: the published client cannot drift from the document.
 *
 * Two halves, both necessary:
 *   1. the committed document IS what the server's generator produces for the
 *      fixture namespace (so a route change that is not captured fails here);
 *   2. the committed client IS what the committed document generates (so a
 *      hand-edit of the client, or a document edit without `pnpm sdk:gen`,
 *      fails here).
 *
 * The last test is the falsifier: it mutates a COPY of the document and shows
 * both the client bytes and the drift check change — i.e. the guard bites.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SDK_CLIENT_PATH,
  SDK_SPEC_PATH,
  buildSpecDocument,
  collectOperations,
  driftedFiles,
  renderClient,
  renderSpec,
  type OpenApiDocument,
} from "./generate.js";

const repoRoot = process.cwd();
const committed = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

describe("SDK-PARITY-001 generated client", () => {
  it("checks in the document the server actually generates", () => {
    expect(committed(SDK_SPEC_PATH)).toBe(renderSpec());
  });

  it("checks in the client the document actually generates", () => {
    expect(driftedFiles(repoRoot)).toEqual([]);
    expect(committed(SDK_CLIENT_PATH)).toBe(renderClient());
  });

  it("covers every operation in the document, with its path and method", () => {
    const client = committed(SDK_CLIENT_PATH);
    const operations = collectOperations(buildSpecDocument());
    expect(operations.length).toBeGreaterThanOrEqual(18);
    for (const op of operations) {
      // A generated method per operationId, and the exact path template.
      expect(client).toContain(`${op.id}(args?:`);
      expect(client).toContain(`path: ${JSON.stringify(op.path)}`);
    }
    // The surface AC-1 names explicitly, by operation, not by prose.
    const ids = operations.map((op) => op.id);
    for (const required of [
      "listMemories",
      "createMemory",
      "getMemoryByKey",
      "updateMemory",
      "deleteMemory",
      "list_tables",
      "declare_table",
      "list_notes",
      "insert_notes",
      "update_notes",
      "delete_notes",
      "upsert_notes",
      "streamEvents",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("refuses to generate from a document with an undocumented operation", () => {
    const spec = buildSpecDocument() as OpenApiDocument;
    spec.paths["/api/undocumented"] = { get: { summary: "no operationId" } };
    expect(() => collectOperations(spec)).toThrow(/operationId/);
  });

  it("fails when the document and the client drift (falsifier)", () => {
    const mutated = structuredClone(buildSpecDocument());
    mutated.paths["/api/namespaces"] = {
      get: {
        operationId: "listNamespaces",
        summary: "Added by the drift test — not in the committed document.",
        responses: { "200": { description: "ok" } },
      },
    };
    const mutatedClient = renderClient(mutated);
    expect(mutatedClient).not.toBe(committed(SDK_CLIENT_PATH));
    expect(driftedFiles(repoRoot, mutated)).toEqual([
      SDK_SPEC_PATH,
      SDK_CLIENT_PATH,
    ]);
  });
});
