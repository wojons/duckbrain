import { describe, expect, it } from "vitest";
import { evaluateLatency } from "../../scripts/perf/latency-assertion.mjs";

describe("PERF-DUCKBRAIN-002 latency assertion", () => {
  it("passes a sample below the ceiling", () => {
    expect(evaluateLatency({ "coding-hermes": [499] }, { PERF_ASSERT_MS: "500" }).pass).toBe(true);
  });

  it("fails above the ceiling and names the sample", () => {
    expect(evaluateLatency({ "fleet-quality": [501] }, { PERF_ASSERT_MS: "500" })).toEqual({
      pass: false,
      ceilingMs: 500,
      namespace: "fleet-quality",
      sampleMs: 501,
    });
  });

  it("passes a sample exactly equal to the ceiling", () => {
    expect(evaluateLatency({ "coding-hermes": [500] }, { PERF_ASSERT_MS: "500" }).pass).toBe(true);
  });

  it("honours the environment override", () => {
    expect(evaluateLatency({ "coding-hermes": [600] }, { PERF_ASSERT_MS: "700" }).pass).toBe(true);
  });
});
