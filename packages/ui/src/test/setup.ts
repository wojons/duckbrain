/**
 * Global UI test setup.
 *
 * - registers @testing-library/jest-dom matchers for Vitest
 * - hardens jsdom with the browser APIs the UI reads (EventSource,
 *   ResizeObserver, matchMedia, clipboard, scrollTo)
 * - installs a throwing `fetch` guard so no test can silently reach the
 *   network: tests must opt in with installApiStub() from ./api-stub
 * - resets the Zustand UI store between tests
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { useUIStore } from "../stores/ui-store";

// api-health debug logging is DEV-gated and very chatty under Vitest. Silence
// console.log only; console.warn / console.error stay visible (React warnings
// must not be hidden).
vi.spyOn(console, "log").mockImplementation(() => {});

/* ------------------------------------------------------------------ *
 * jsdom API stubs
 * ------------------------------------------------------------------ */

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = 2;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
}

class MockObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

const globalAny = globalThis as unknown as Record<string, unknown>;
if (!globalAny.EventSource) globalAny.EventSource = MockEventSource;
if (!globalAny.ResizeObserver) globalAny.ResizeObserver = MockObserver;
if (!globalAny.IntersectionObserver)
  globalAny.IntersectionObserver = MockObserver;

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  window.scrollTo = (() => {}) as unknown as typeof window.scrollTo;
}

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: async () => {} },
});

/* ------------------------------------------------------------------ *
 * Per-test isolation
 * ------------------------------------------------------------------ */

const DEFAULT_UI_STATE = {
  selectedMemory: null,
  inspectorOpen: false,
  sidebarCollapsed: false,
  currentNamespace: "default",
  searchQuery: "",
  realtimeEnabled: true,
};

beforeEach(() => {
  // Reset persisted UI state so a test can never inherit another test's
  // namespace or search term.
  useUIStore.setState({ ...DEFAULT_UI_STATE });
  window.localStorage.clear();

  // Zero-network guarantee: any unstubbed fetch fails loudly. Tests stub it
  // explicitly via installApiStub() (vi.stubGlobal), so the stub replaces this
  // guard for the duration of the test.
  globalAny.fetch = (() => {
    throw new Error(
      "UI tests must not touch the network — install a fetch stub with installApiStub() from src/test/api-stub.ts",
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
