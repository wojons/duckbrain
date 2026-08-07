/**
 * DOGFOOD-002 Regression Tests: semantic recall provider fallback.
 *
 * Regressions guarded:
 *  - when the first healthy provider's embed() throws (e.g. LM Studio 400 on
 *    an unloaded model) and a second provider is reachable, recall with
 *    query= falls back and returns semantic results instead of an error
 *  - a 200-with-empty-vector embed response is treated as failure at the
 *    recall level too (defense in depth on top of makeHttpEmbed)
 *  - when ALL providers fail, recall returns the error payload (which the MCP
 *    wrapHandler then surfaces as isError:true — see server-dogfood002.test.ts)
 *
 * The providers module is mocked (createAutoProviders stubbed); the namespace
 * is real (seeded JSONL partition + manifest under the test-setup temp root),
 * so the full semantic path — embed → queryMemories → semanticSearch — runs
 * against real DuckDB without any live embedding service.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import fs from "fs";
import path from "path";
import { recallTool } from "./recall";
import { createAutoProviders } from "../../embedding/providers";
import type { EmbeddingProvider } from "../../embedding/providers";

vi.mock("../../embedding/providers", () => ({
  createAutoProviders: vi.fn(),
}));

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;
const NS = path.join(NS_ROOT, "default");
const PARTITION = path.join(NS, "concept", "2026-08");
const JSONL = path.join(PARTITION, "current.jsonl");
const MANIFEST = path.join(NS, "manifest.json");

function failingProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: "broken",
    dimensions: 4,
    async embed() {
      throw new Error(`embed HTTP 400: model unloaded (${id})`);
    },
  };
}

function workingProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: "working",
    dimensions: 4,
    async embed() {
      return [0.1, 0.2, 0.3, 0.4];
    },
  };
}

function emptyVectorProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: "empty",
    dimensions: 4,
    async embed() {
      return []; // 200 with {"embedding":[]} — must be treated as failure
    },
  };
}

beforeAll(() => {
  fs.mkdirSync(PARTITION, { recursive: true });
  fs.writeFileSync(
    JSONL,
    JSON.stringify({
      id: "m1",
      key: "/notes/alpha",
      domain: "concept",
      timestamp: "2026-08-07T00:00:00.000Z",
      author: "test@example.com",
      action: "add",
      embedding_text: "alpha notes",
      attributes: {},
    }) + "\n",
  );
  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({
      partitions: ["concept/2026-08"],
      lastUpdated: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  fs.rmSync(PARTITION, { recursive: true, force: true });
  fs.rmSync(MANIFEST, { force: true });
  fs.rmSync(path.join(NS, ".embeddings"), { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(createAutoProviders).mockReset();
});

afterEach(() => {
  vi.mocked(createAutoProviders).mockReset();
});

describe("DOGFOOD-002: recall semantic provider fallback", () => {
  it("falls back to the next provider when the first embed() throws", async () => {
    const first = failingProvider("lmstudio/broken");
    const second = workingProvider("ollama/working");
    vi.mocked(createAutoProviders).mockResolvedValue([first, second]);

    const result = await recallTool({
      query: "alpha",
      namespace: "default",
      limit: 5,
    });

    expect(result.error).toBeUndefined();
    expect(result.count).toBe(1);
    expect(result.memories[0].id).toBe("m1");
  });

  it("treats a 200-with-empty-vector embed as failure and falls through", async () => {
    const first = emptyVectorProvider("lmstudio/empty");
    const second = workingProvider("ollama/working");
    vi.mocked(createAutoProviders).mockResolvedValue([first, second]);

    const result = await recallTool({
      query: "alpha",
      namespace: "default",
      limit: 5,
    });

    expect(result.error).toBeUndefined();
    expect(result.count).toBe(1);
    expect(result.memories[0].id).toBe("m1");
  });

  it("returns the error payload when ALL providers fail", async () => {
    const first = failingProvider("lmstudio/broken");
    const second = failingProvider("ollama/broken");
    vi.mocked(createAutoProviders).mockResolvedValue([first, second]);

    const result = await recallTool({
      query: "alpha",
      namespace: "default",
      limit: 5,
    });

    expect(result.memories).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.error).toContain("Embedding generation failed");
    expect(result.error).toContain("lmstudio/broken");
    expect(result.error).toContain("ollama/broken");
  });

  it("keeps the no-provider error message (DOGFOOD-001 contract)", async () => {
    vi.mocked(createAutoProviders).mockResolvedValue([]);

    const result = await recallTool({
      query: "alpha",
      namespace: "default",
      limit: 5,
    });

    expect(result.error).toBe(
      "Semantic search requires an embedding provider - start LM Studio/Ollama or set DUCKBRAIN_EMBEDDING_PROVIDER, then run 'duckbrain embeddings rebuild'",
    );
  });
});
