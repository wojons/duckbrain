/**
 * PERF-015 follow-up — restores the OPS-007 bound that the refactor moved out of
 * observable range.
 *
 * serving-paths-ops007.test.ts used to assert, against a parent-side exec mock,
 * that every author-scan git call carried a finite timeout <= 5000ms. Since
 * PERF-015 runs those scans in a child process, that parent-side mock can no
 * longer see them, so the assertion was dropped there. The bound still has to be
 * tested: this file mocks the single git seam (src/git/exec), drives the shared
 * aggregation directly, and asserts the same contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type GitCall = { args: string[]; cwd: string; opts: Record<string, unknown> };

const rec = vi.hoisted(() => ({ calls: [] as GitCall[], inFlight: 0, peak: 0 }));

vi.mock("../../git/exec", () => ({
  runGitAsync: async (args: string[], cwd: string, opts: Record<string, unknown>) => {
    rec.calls.push({ args, cwd, opts });
    rec.inFlight += 1;
    rec.peak = Math.max(rec.peak, rec.inFlight);
    // Yield so the bounded pool actually overlaps, then answer with no authors
    // so the caller's DuckDB fallback (injected below) is what supplies output.
    await new Promise((resolve) => setTimeout(resolve, 5));
    rec.inFlight -= 1;
    return "";
  },
}));

import {
  AUTHOR_CHILD_SCAN_CONCURRENCY,
  AUTHOR_SCAN_CONCURRENCY,
  collectAuthorsForNamespaces,
} from "./authorAggregation";

const NAMESPACE_COUNT = 40;

describe("OPS-007 bound survives the PERF-015 child move", () => {
  beforeEach(() => {
    rec.calls = [];
    rec.inFlight = 0;
    rec.peak = 0;
  });

  it("gives every author-scan git call a finite <=5000ms timeout and a buffer cap", async () => {
    const namespaces = Array.from({ length: NAMESPACE_COUNT }, (_, index) => ({
      path: `/nonexistent/namespace-${index}`,
    }));

    const authors = await collectAuthorsForNamespaces(namespaces, {
      getDbAuthors: async () => [],
    });

    expect(authors).toEqual([]);
    expect(rec.calls).toHaveLength(NAMESPACE_COUNT);

    for (const call of rec.calls) {
      expect(call.args).toContain("--format=%aN");
      expect(typeof call.opts.timeoutMs).toBe("number");
      expect(call.opts.timeoutMs as number).toBeGreaterThan(0);
      expect(call.opts.timeoutMs as number).toBeLessThanOrEqual(5000);
      expect(typeof call.opts.maxBufferBytes).toBe("number");
      expect(call.opts.maxBufferBytes as number).toBeGreaterThan(0);
    }
  });

  it("keeps child scans at or below ten concurrent workers", () => {
    expect(AUTHOR_CHILD_SCAN_CONCURRENCY).toBeLessThanOrEqual(10);
  });

  it("never exceeds AUTHOR_SCAN_CONCURRENCY in-flight scans", async () => {
    const namespaces = Array.from({ length: NAMESPACE_COUNT }, (_, index) => ({
      path: `/nonexistent/namespace-${index}`,
    }));

    await collectAuthorsForNamespaces(namespaces, { getDbAuthors: async () => [] });

    expect(AUTHOR_SCAN_CONCURRENCY).toBe(32);
    expect(rec.peak).toBeGreaterThan(1);
    expect(rec.peak).toBeLessThanOrEqual(AUTHOR_SCAN_CONCURRENCY);
  });
});
