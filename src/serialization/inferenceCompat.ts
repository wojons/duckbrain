/**
 * DB-SUPA-6 — bounded `read_json_auto` compatibility window.
 *
 * Generic declared tables never infer: reads/writes go through declared types
 * and headers from day one. The only surviving inference is create-only, in
 * `ddl.createTable` with `inferFrom`, and only while this window is open.
 *
 * The window closes when BOTH conditions hold (spec: "two minor releases or
 * 90 days after DB-SUPA-6 ships, whichever is later"):
 *   - `minorReleasesShipped >= minMinorReleases`
 *   - `now >= shippedAt + graceDays`
 *
 * Once closed, every generic inference attempt fails
 * `409 SCHEMA_DECLARATION_REQUIRED` with a migration warning. While it is
 * open, each undeclared generic-file access emits ONE warning per
 * (namespace, file) per process and increments the
 * `duckbrain_schema_inference_compat_total` counter, so an operator can see
 * exactly which file still needs a declaration before the window shuts.
 */

import { ApiError } from "../http/middleware/errorHandler.js";
import { getConfig } from "../config/index.js";

/** Counter name recorded by every compatibility-window inference access. */
export const SCHEMA_INFERENCE_COMPAT_COUNTER =
  "duckbrain_schema_inference_compat_total";

export interface InferenceWindowConfig {
  shippedAt: string;
  graceDays: number;
  minMinorReleases: number;
  minorReleasesShipped: number;
}

export interface InferenceWindowState {
  active: boolean;
  /** Why the window is open/closed (operator-facing). */
  reason: string;
  /** Earliest instant the release-count rule would allow closing. */
  shippedAt: string;
  /** Instant the grace rule closes the window. */
  graceDeadline: string;
  releasesShipped: number;
  minMinorReleases: number;
}

export function configInferenceWindow(): InferenceWindowConfig {
  const block = getConfig(".").ddl?.inferenceCompat;
  return {
    shippedAt: block?.shippedAt ?? "2026-09-17T00:00:00.000Z",
    graceDays: block?.graceDays ?? 90,
    minMinorReleases: block?.minMinorReleases ?? 2,
    minorReleasesShipped: block?.minorReleasesShipped ?? 0,
  };
}

export function resolveInferenceWindow(
  override: Partial<InferenceWindowConfig> | undefined,
  now: Date = new Date(),
): InferenceWindowState {
  const config = { ...configInferenceWindow(), ...(override ?? {}) };
  const shipped = Date.parse(config.shippedAt);
  if (!Number.isFinite(shipped))
    throw new ApiError(
      `ddl.inferenceCompat.shippedAt is not a valid instant: ${config.shippedAt}`,
      500,
      "CONFIG_INVALID",
    );
  const graceDeadline = new Date(
    shipped + config.graceDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const releasesSatisfied =
    config.minorReleasesShipped >= config.minMinorReleases;
  const graceSatisfied = now.getTime() >= Date.parse(graceDeadline);
  const active = !(releasesSatisfied && graceSatisfied);
  const reason = active
    ? `inference compatibility window open (${
        releasesSatisfied
          ? "waiting for the grace period"
          : "waiting for the minor-release rule"
      }: ${config.minorReleasesShipped}/${config.minMinorReleases} releases, grace ends ${graceDeadline})`
    : `inference compatibility window closed (${config.minorReleasesShipped}/${config.minMinorReleases} releases shipped and grace ended ${graceDeadline})`;
  return {
    active,
    reason,
    shippedAt: config.shippedAt,
    graceDeadline,
    releasesShipped: config.minorReleasesShipped,
    minMinorReleases: config.minMinorReleases,
  };
}

// ---------------------------------------------------------------------------
// Counter + one-warning-per-file seam
// ---------------------------------------------------------------------------

let inferenceCompatTotal = 0;
const warned = new Set<string>();

/** Current value of `duckbrain_schema_inference_compat_total`. */
export function schemaInferenceCompatCount(): number {
  return inferenceCompatTotal;
}

export function resetInferenceCompatState(): void {
  inferenceCompatTotal = 0;
  warned.clear();
}

/**
 * Record one compatibility-window access: always increments the counter,
 * warns once per (namespace, file) for this process.
 */
export function recordInferenceCompat(
  ns: string,
  file: string,
  detail: string,
): void {
  inferenceCompatTotal += 1;
  const key = `${ns}\u0000${file}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[duckbrain] schema inference compatibility access (${SCHEMA_INFERENCE_COMPAT_COUNTER}): ` +
      `namespace '${ns}' read '${file}' without a declaration — ${detail}. ` +
      "Declare the table via DDL before the compatibility window closes; " +
      "generic reads/writes then use declared types and headers only.",
  );
}

/**
 * Gate for every generic inference attempt (create-only inference and the
 * legacy per-query auto path). Throws `409 SCHEMA_DECLARATION_REQUIRED` once
 * the window has closed; otherwise records the access and returns.
 */
export function assertGenericInferenceAllowed(
  ns: string,
  file: string,
  options: {
    now?: Date;
    window?: Partial<InferenceWindowConfig>;
    detail?: string;
  } = {},
): InferenceWindowState {
  const state = resolveInferenceWindow(
    options.window,
    options.now ?? new Date(),
  );
  if (!state.active) {
    throw new ApiError(
      `Per-query schema inference is no longer permitted for namespace '${ns}' (${state.reason}). ` +
        `Declare the resource first; generic access requires a declaration (409 SCHEMA_DECLARATION_REQUIRED).`,
      409,
      "SCHEMA_DECLARATION_REQUIRED",
    );
  }
  recordInferenceCompat(
    ns,
    file,
    options.detail ?? "inference compatibility window",
  );
  return state;
}
