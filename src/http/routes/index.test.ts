/**
 * Unit tests for routes barrel file (index.ts)
 *
 * Verifies that all expected route modules are exported
 * and that each export is a function (Express router factory).
 */

import { describe, it, expect } from "vitest";
import * as routeIndex from "./index";

describe("Routes barrel exports (index.ts)", () => {
  it("should export createMemoryRoutes as a function", () => {
    expect(routeIndex.createMemoryRoutes).toBeDefined();
    expect(typeof routeIndex.createMemoryRoutes).toBe("function");
  });

  it("should export createKeyRoutes as a function", () => {
    expect(routeIndex.createKeyRoutes).toBeDefined();
    expect(typeof routeIndex.createKeyRoutes).toBe("function");
  });

  it("should export createNamespaceRoutes as a function", () => {
    expect(routeIndex.createNamespaceRoutes).toBeDefined();
    expect(typeof routeIndex.createNamespaceRoutes).toBe("function");
  });

  it("should export createEventsRoutes as a function", () => {
    expect(routeIndex.createEventsRoutes).toBeDefined();
    expect(typeof routeIndex.createEventsRoutes).toBe("function");
  });

  it("should not export anything unexpected", () => {
    const expectedExports = [
      "createMemoryRoutes",
      "createKeyRoutes",
      "createNamespaceRoutes",
      "createEventsRoutes",
    ];
    const actualExports = Object.keys(routeIndex).filter(
      (k) => k !== "default",
    );
    expect(actualExports.sort()).toEqual(expectedExports.sort());
  });

  it("should NOT have a default export (barrel files use named exports)", () => {
    expect((routeIndex as any).default).toBeUndefined();
  });
});
