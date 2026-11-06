/**
 * SDK-PARITY-001: the FIXED namespace the published SDK document is generated
 * from.
 *
 * The per-namespace OpenAPI document is generated from the live registry, so
 * its table paths depend on whatever happens to be declared on this host. A
 * client checked into the repository cannot depend on that: it has to be
 * reproducible on a machine with no data directory at all. The fixture below
 * is the seam — `generateOpenApi(ns, tablesOverride)` takes the declared set
 * as an argument, and this list is what the generator and its drift test pass.
 *
 * The two tables are deliberately different shapes:
 *   - `notes` has a single primary key, so the document also carries the
 *     key-addressed upsert resource (`/tables/notes/{pk}`);
 *   - `lane_scores` is positional with no primary key, so it exercises a
 *     table that has no `{pk}` path and whose columns are positional.
 */
import type { TableDeclaration } from "../schema/table-registry.js";

export const FIXTURE_NAMESPACE = "sdk_fixture";

export const FIXTURE_TABLES: TableDeclaration[] = [
  {
    name: "notes",
    format: "jsonl-objects",
    columns: [
      { name: "id", type: "varchar" },
      { name: "title", type: "varchar" },
      { name: "score", type: "double" },
      { name: "created", type: "timestamp" },
    ],
    primary: "id",
    glob: "notes/*.jsonl",
    source: "schema.json",
  },
  {
    name: "lane_scores",
    format: "jsonl-positional",
    columns: [
      { name: "lane", type: "varchar" },
      { name: "score", type: "double" },
      { name: "tags", type: "json" },
    ],
    primary: null,
    glob: "lane_scores/*.jsonl",
    source: "legacy",
  },
];
