/**
 * DF-0923-04: provider=none — the explicit embeddings-disabled configuration.
 *
 * The clean-box / container deployment had no LM Studio or Ollama to reach,
 * so probeEmbeddingHealth found no winner, healthy stayed false and /health
 * answered 503 degraded forever — the compose healthcheck probed a deployment
 * that could never report healthy, and every monitor read the stack as
 * broken. provider=none says "this daemon has no embedding backend": nothing
 * is probed, the aggregate is healthy, recall degrades to keyword search
 * through the existing providers.length === 0 contract.
 *
 * RED-proof arms (pre-fix behavior named in each test comment):
 *  - probeEmbeddingHealth() with provider=none hit the auto path, probed all
 *    three providers, returned healthy:false (503).
 *  - createAutoProviders() with provider=none returned [] only after
 *    probing every dead provider (~1.5s of gate timeouts), and callers could
 *    not distinguish "disabled" from "all dead".
 *  - createProvider() with provider=none threw "Unknown embedding provider
 *    'none'" — no actionable message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { probeEmbeddingHealth } from "./health.js";
import {
  createAutoProviders,
  createProvider,
  resolveEmbeddingConfig,
  resetAutoProvidersCache,
} from "./providers.js";

const ENV_KEYS = [
  "DUCKBRAIN_EMBEDDING_PROVIDER",
  "DUCKBRAIN_EMBEDDING_MODEL",
  "DUCKBRAIN_EMBEDDING_BASE_URL",
  "DUCKBRAIN_EMBEDDING_API_KEY",
  "DUCKBRAIN_EMBEDDING_DIMENSIONS",
  "DUCKBRAIN_EMBEDDING_TIMEOUT_MS",
] as const;

function withCleanEmbeddingEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(() => {
  withCleanEmbeddingEnv();
  resetAutoProvidersCache();
  // Fail loud if any test path leaks a network probe — provider=none must
  // never fetch anything (pre-fix, the auto path issued 1.5s gate fetches).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("provider=none must not issue network probes");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  withCleanEmbeddingEnv();
  resetAutoProvidersCache();
});

describe("resolveEmbeddingConfig: none is an explicit resolution", () => {
  it("carries provider=none through from the explicit param", () => {
    const resolved = resolveEmbeddingConfig({ provider: "none" });
    expect(resolved.provider).toBe("none");
  });

  it("carries provider=none through from DUCKBRAIN_EMBEDDING_PROVIDER", () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "none";
    const resolved = resolveEmbeddingConfig();
    expect(resolved.provider).toBe("none");
  });

  it("still defaults to auto when nothing is set (no behavior change)", () => {
    expect(resolveEmbeddingConfig().provider).toBe("auto");
  });
});

describe("probeEmbeddingHealth: provider=none is healthy without probing", () => {
  it("reports healthy with zero network probes", async () => {
    const result = await probeEmbeddingHealth({ provider: "none" });

    expect(result.healthy).toBe(true);
    expect(result.provider).toBe("");
    expect(result.providers).toEqual([
      {
        id: "none",
        healthy: true,
        note: expect.stringContaining("embeddings disabled"),
      },
    ]);
  });

  it("reads the disable from the environment too", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "none";
    const result = await probeEmbeddingHealth();
    expect(result.healthy).toBe(true);
  });

  it("keeps the all-dead auto path degraded (DOGFOOD-020 unchanged)", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
    const result = await probeEmbeddingHealth();
    // Pre-fix this arm already returned healthy:false — the fix must not
    // relax it: an operator who left auto on IS degraded when nothing answers.
    expect(result.healthy).toBe(false);
    expect(result.providers.every((p) => !p.healthy)).toBe(true);
  });

  it("keeps a pinned provider's failure degraded", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "ollama";
    const result = await probeEmbeddingHealth();
    expect(result.healthy).toBe(false);
    expect(result.providers[0].id).toBe("ollama");
    expect(result.providers[0].healthy).toBe(false);
  });
});

describe("createAutoProviders: none short-circuits to the empty list", () => {
  it("returns [] with no probing and no waiting", async () => {
    const providers = await createAutoProviders({ provider: "none" });
    expect(providers).toEqual([]);
  });

  it("returns [] from the environment form too", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "none";
    expect(await createAutoProviders()).toEqual([]);
  });
});

describe("createProvider: none fails with the actionable message", () => {
  it("throws naming the disabled state and the fix", () => {
    expect(() => createProvider({ provider: "none" })).toThrow(
      /provider=none.*lmstudio \| ollama \| openai \| auto/s,
    );
  });
});
