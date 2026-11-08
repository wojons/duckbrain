/**
 * Types for the plain-Node helper `latency-assertion.mjs`.
 *
 * The helper is a `.mjs` module so `scripts/perf/perf001-list-latency.mjs` can import it
 * from plain node without a loader, but the unit test that exercises it is TypeScript.
 * Without this declaration `tsc --noEmit` (CI "Run type check") fails TS7016 on the
 * import; `build:cli` alone does not cover the test tree, which is how that red reached
 * main on 0d43addb.
 */
export interface LatencyVerdict {
  pass: boolean;
  ceilingMs: number;
  namespace?: string;
  sampleMs?: number;
}

export function evaluateLatency(
  samplesByNamespace: Record<string, readonly number[]>,
  env?: Record<string, string | undefined>,
): LatencyVerdict;
