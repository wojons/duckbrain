/**
 * RETR-003 Regression Tests: time-range validation/normalization.
 *
 * Guards src/utils/timerange.ts — the shared ISO-8601 validation used by
 * the MCP recall tool, the HTTP GET /api/memories route, and the CLI:
 *   - valid dates AND datetimes (with Z / ±HH:MM offsets) are accepted
 *   - garbage, calendar-impossible dates, and malformed ISO shapes are
 *     rejected
 *   - between=START,END expands to after+before
 *   - between combined with after/before is rejected (mutually exclusive)
 *   - an empty window (after later than before) is rejected
 */

import { describe, it, expect } from "vitest";
import { isValidIso8601, parseTimeRange } from "./timerange";

describe("isValidIso8601 (RETR-003)", () => {
  it("accepts date-only values", () => {
    expect(isValidIso8601("2026-08-10")).toBe(true);
    expect(isValidIso8601("2026-01-01")).toBe(true);
  });

  it("accepts full ISO-8601 datetimes", () => {
    expect(isValidIso8601("2026-08-10T14:30:00.000Z")).toBe(true);
    expect(isValidIso8601("2026-08-10T14:30Z")).toBe(true);
    expect(isValidIso8601("2026-08-10T14:30:00")).toBe(true);
    expect(isValidIso8601("2026-08-10T14:30:00+05:30")).toBe(true);
    expect(isValidIso8601("2026-08-10T14:30:00.676525+00:00")).toBe(true);
  });

  it("rejects non-ISO shapes", () => {
    expect(isValidIso8601("garbage")).toBe(false);
    expect(isValidIso8601("2026-08-10T")).toBe(false);
    expect(isValidIso8601("2026/08/10")).toBe(false);
    expect(isValidIso8601("08-10-2026")).toBe(false);
    expect(isValidIso8601("2026-08-10 14:30:00")).toBe(false);
    expect(isValidIso8601("2026-08-10T14:30:00+0530")).toBe(false);
    expect(isValidIso8601("")).toBe(false);
  });

  it("rejects calendar-impossible dates", () => {
    expect(isValidIso8601("2026-13-45")).toBe(false);
    expect(isValidIso8601("2026-02-30")).toBe(false);
    expect(isValidIso8601("2026-08-10T25:99:00Z")).toBe(false);
  });
});

describe("parseTimeRange (RETR-003)", () => {
  it("normalizes date-only bounds to full UTC instants", () => {
    // after= date-only → start of that day; before= date-only → END of that
    // day ("until 2026-08-12" must include 2026-08-12 itself).
    expect(parseTimeRange({ after: "2026-08-10" })).toEqual({
      after: "2026-08-10T00:00:00.000Z",
    });
    expect(parseTimeRange({ before: "2026-08-12" })).toEqual({
      before: "2026-08-12T23:59:59.999Z",
    });
    expect(parseTimeRange({})).toEqual({});
  });

  it("canonicalizes datetime bounds with offsets to UTC", () => {
    expect(parseTimeRange({ after: "2026-08-10T14:30:00+05:30" })).toEqual({
      after: "2026-08-10T09:00:00.000Z",
    });
    expect(parseTimeRange({ before: "2026-08-12T00:00:00.000+00:00" })).toEqual(
      { before: "2026-08-12T00:00:00.000Z" },
    );
  });

  it("treats naive datetimes (no Z/offset) as UTC, not host-local", () => {
    expect(parseTimeRange({ after: "2026-08-10T14:30:00" })).toEqual({
      after: "2026-08-10T14:30:00.000Z",
    });
  });

  it("passes canonical datetimes through unchanged", () => {
    expect(parseTimeRange({ before: "2026-08-12T23:59:59.999Z" })).toEqual({
      before: "2026-08-12T23:59:59.999Z",
    });
  });

  it("expands between=START,END into normalized after+before", () => {
    expect(parseTimeRange({ between: "2026-08-10,2026-08-12" })).toEqual({
      after: "2026-08-10T00:00:00.000Z",
      before: "2026-08-12T23:59:59.999Z",
    });
    expect(
      parseTimeRange({
        between: "2026-08-10T00:00:00.000Z,2026-08-12T23:59:59.999Z",
      }),
    ).toEqual({
      after: "2026-08-10T00:00:00.000Z",
      before: "2026-08-12T23:59:59.999Z",
    });
  });

  it("trims whitespace around between values", () => {
    expect(parseTimeRange({ between: " 2026-08-10 , 2026-08-12 " })).toEqual({
      after: "2026-08-10T00:00:00.000Z",
      before: "2026-08-12T23:59:59.999Z",
    });
  });

  it("rejects invalid after/before values", () => {
    expect(() => parseTimeRange({ after: "not-a-date" })).toThrow(
      /Invalid ISO-8601 datetime for after/,
    );
    expect(() => parseTimeRange({ before: "2026-13-45" })).toThrow(
      /Invalid ISO-8601 datetime for before/,
    );
  });

  it("rejects between without a comma", () => {
    expect(() => parseTimeRange({ between: "2026-08-10" })).toThrow(
      /two comma-separated ISO-8601 values/,
    );
  });

  it("rejects between with invalid values", () => {
    expect(() => parseTimeRange({ between: "garbage,2026-08-12" })).toThrow(
      /Invalid ISO-8601 datetime in between/,
    );
  });

  it("rejects between combined with after/before (mutually exclusive)", () => {
    expect(() =>
      parseTimeRange({ between: "2026-08-10,2026-08-12", after: "2026-08-09" }),
    ).toThrow(/either 'between' or 'after'\/'before'/);
    expect(() =>
      parseTimeRange({
        between: "2026-08-10,2026-08-12",
        before: "2026-08-13",
      }),
    ).toThrow(/either 'between' or 'after'\/'before'/);
  });

  it("rejects an empty window (after later than before)", () => {
    expect(() =>
      parseTimeRange({ after: "2026-08-12", before: "2026-08-10" }),
    ).toThrow(/must not be later than before/);
    expect(() => parseTimeRange({ between: "2026-08-12,2026-08-10" })).toThrow(
      /must not be later than before/,
    );
  });

  it("allows equal instants across formats (date vs datetime)", () => {
    // 2026-08-10 (UTC midnight) == 2026-08-10T00:00:00Z — not an empty window.
    expect(() =>
      parseTimeRange({ after: "2026-08-10", before: "2026-08-10T00:00:00Z" }),
    ).not.toThrow();
  });
});
