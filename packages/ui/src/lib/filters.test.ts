/**
 * Unit tests for the shared filter state → REST query params mapping.
 *
 * The backend list route (src/http/routes/memories.ts) parses domain,
 * author, after, before, between, as_of, prefix, allNamespaces. The filter
 * UI supplies after/before/as_of directly (between stays an api-client-level
 * param — no dedicated control) and derives `after` from the date preset.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  filtersToQueryParams,
  type MemoryFilters,
} from "./filters";

function filters(patch: Partial<MemoryFilters>): MemoryFilters {
  return { ...DEFAULT_FILTERS, ...patch };
}

describe("filtersToQueryParams", () => {
  it("returns an empty mapping for the default (filterless) state", () => {
    expect(filtersToQueryParams(DEFAULT_FILTERS)).toEqual({});
  });

  it("maps domain, author and prefix onto the backend param names", () => {
    const params = filtersToQueryParams(
      filters({ domain: "config", author: "a@b.com", prefix: "/projects" }),
    );
    expect(params).toEqual({
      domain: "config",
      author: "a@b.com",
      prefix: "/projects",
    });
  });

  it("derives after from the dateRange preset", () => {
    const before = Date.now();
    const params = filtersToQueryParams(filters({ dateRange: "24h" }));
    const after = params.after!;
    expect(after).toBeTruthy();
    const parsed = new Date(after).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000 - 5000);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });

  it("prefers an explicit after over the dateRange preset", () => {
    const params = filtersToQueryParams(
      filters({ dateRange: "30d", after: "2026-01-01T00:00" }),
    );
    expect(params.after).toBe("2026-01-01T00:00");
  });

  it("passes explicit before and as_of through", () => {
    const params = filtersToQueryParams(
      filters({ before: "2026-09-01T00:00", asOf: "HEAD" }),
    );
    expect(params.before).toBe("2026-09-01T00:00");
    expect(params.asOf).toBe("HEAD");
  });

  it("omits allNamespaces unless the toggle is on", () => {
    expect(
      filtersToQueryParams(filters({ allNamespaces: false })).allNamespaces,
    ).toBeUndefined();
    expect(
      filtersToQueryParams(filters({ allNamespaces: true })).allNamespaces,
    ).toBe(true);
  });
});
