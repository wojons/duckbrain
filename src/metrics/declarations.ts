/**
 * ADOPT-DECLARED-001 — how many namespaces actually run the declared-schema
 * path, as a number on the scrape surface.
 *
 * The 2026-11-04 bakeoff measured the gap this module exists to keep visible:
 * `find namespaces -maxdepth 2 -name schema.json` returned 0 while
 * `find namespaces -name '*.table.json'` returned 949. The SUPA-6 persistent
 * schema (schema.json) is the path every new feature rides — DDL fence,
 * validation before the atomic switch, change records on writes — and no
 * namespace had adopted it, while the legacy per-table declaration served every
 * real table. A one-off shell count cannot notice a regression; a gauge that
 * moves can.
 *
 * WHAT IS COUNTED (per namespace directory directly under the namespaces root):
 *
 *   - `schema.json` — the SUPA-6 persistent declaration document. One per
 *     namespace, holding every declared table.
 *   - `tables/<name>.table.json` — the legacy per-table declaration. A
 *     namespace counts as legacy when at least one such file exists.
 *
 * A namespace may honestly be BOTH (a schema.json plus legacy declarations it
 * inherited); the two gauges are independent populations, not a partition.
 *
 * SAMPLING — collect time, exactly like src/metrics/storage.ts: no background
 * timer, a TTL cache (60 s) so a 15 s scrape does not re-walk the tree, and
 * single-flight so concurrent scrapes share one walk. A walk that fails leaves
 * the sampler returning `null`, which the metrics layer renders as NO SAMPLE —
 * never a fabricated 0, because "0 adopted" and "we could not measure" are the
 * opposite facts and this row is about telling them apart.
 */

import fs from "fs";
import path from "path";

/** The SUPA-6 persistent schema document (src/serialization/schemaJson.ts). */
export const SCHEMA_FILE = "schema.json";

/** The legacy per-table declaration directory. */
export const LEGACY_TABLE_DIR = "tables";

/** The legacy per-table declaration suffix. */
export const LEGACY_DECLARATION_SUFFIX = ".table.json";

/** Steady-state reuse window for one census walk. */
export const DECLARATION_SCAN_TTL_MS = 60_000;

export interface DeclarationCensus {
  /** Namespace directories examined (proof the walk traversed the store). */
  namespaces: number;
  /** Namespaces holding a schema.json. */
  namespacesWithSchemaJson: number;
  /** Namespaces holding at least one tables/*.table.json. */
  namespacesWithLegacy: number;
  /** Tables declared across all schema.json documents. */
  tablesInSchemaJson: number;
  /** Legacy declaration files across all namespaces. */
  tablesLegacy: number;
}

function emptyCensus(): DeclarationCensus {
  return {
    namespaces: 0,
    namespacesWithSchemaJson: 0,
    namespacesWithLegacy: 0,
    tablesInSchemaJson: 0,
    tablesLegacy: 0,
  };
}

/** Table entries in one schema.json text, or 0 when it cannot be read. */
function countSchemaTables(file: string): number {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return 0;
    const tables = (parsed as { tables?: unknown }).tables;
    if (typeof tables !== "object" || tables === null) return 0;
    return Object.keys(tables as Record<string, unknown>).length;
  } catch {
    return 0;
  }
}

/**
 * Count declaration adoption under `namespacesPath`.
 *
 * Throws only when the ROOT cannot be read (the caller's cue that no
 * measurement exists). A per-namespace failure — a directory deleted mid-walk,
 * an unreadable `tables/` — is skipped, never turned into a zero for the whole
 * store.
 */
export async function measureDeclarations(
  namespacesPath: string,
): Promise<DeclarationCensus> {
  const root = path.resolve(namespacesPath);
  const census = emptyCensus();

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nsDir = path.join(root, entry.name);
    census.namespaces += 1;

    const schemaFile = path.join(nsDir, SCHEMA_FILE);
    try {
      if ((await fs.promises.stat(schemaFile)).isFile()) {
        census.namespacesWithSchemaJson += 1;
        census.tablesInSchemaJson += countSchemaTables(schemaFile);
      }
    } catch {
      /* no schema.json — the legacy path, not a measurement failure */
    }

    try {
      const declarations = await fs.promises.readdir(
        path.join(nsDir, LEGACY_TABLE_DIR),
        { withFileTypes: true },
      );
      const legacy = declarations.filter(
        (file) =>
          file.isFile() && file.name.endsWith(LEGACY_DECLARATION_SUFFIX),
      ).length;
      if (legacy > 0) {
        census.namespacesWithLegacy += 1;
        census.tablesLegacy += legacy;
      }
    } catch {
      /* no tables/ dir — nothing declared the legacy way */
    }
  }

  return census;
}

/** The two label values the gauges expose. */
export type DeclarationFormat = "schema.json" | "legacy";

export const DECLARATION_METRIC_NAMES = [
  "duckbrain_table_declaration_namespaces",
  "duckbrain_table_declarations",
] as const;

export interface DeclarationSamplerOptions {
  /** Resolved namespaces root. A getter so the daemon can pass a late value. */
  namespacesPath: () => string;
  /** Reuse window (default DECLARATION_SCAN_TTL_MS). */
  ttlMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
  /** Measurement seam (tests): defaults to measureDeclarations. */
  measure?: (namespacesPath: string) => Promise<DeclarationCensus>;
}

export interface DeclarationSampler {
  /** The current census, or `null` when none has ever completed. */
  read(): Promise<DeclarationCensus | null>;
}

/**
 * TTL-cached, single-flight wrapper around `measureDeclarations`.
 *
 * Same contract as `createStorageSampler` (src/metrics/storage.ts): a failure
 * keeps the previous real measurement instead of publishing a zero.
 */
export function createDeclarationSampler(
  options: DeclarationSamplerOptions,
): DeclarationSampler {
  const ttlMs = options.ttlMs ?? DECLARATION_SCAN_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const measure = options.measure ?? measureDeclarations;

  let cached: { at: number; census: DeclarationCensus } | null = null;
  let inFlight: Promise<DeclarationCensus | null> | null = null;

  return {
    async read(): Promise<DeclarationCensus | null> {
      if (cached && now() - cached.at < ttlMs) return cached.census;
      if (inFlight) return cached?.census ?? null;
      inFlight = (async () => {
        try {
          const census = await measure(options.namespacesPath());
          cached = { at: now(), census };
          return census;
        } catch {
          return cached?.census ?? null;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}
