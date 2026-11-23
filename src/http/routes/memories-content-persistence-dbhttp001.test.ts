/**
 * DB-HTTP-001 regression suite: the `content` field must be PERSISTED.
 *
 * Defect: POST /api/memories (port 3000) returned 201 and echoed `content`,
 * but the persisted JSONL record had NO content field — the payload survived
 * only inside embedding_text. The 201 response promised a field the storage
 * of record never carried (pre-fix control: fresh daemon POST with content
 * "REPRO-PAYLOAD-dbhttp001-at-5d3b5556" → on-disk row was
 * {id,key,domain,timestamp,author,action,embedding_text,attributes} — no
 * `content` key).
 *
 * Fix shape: MemorySchema carries an optional `content` field; createMemory()
 * persists the caller's content and stamps embedding_text when absent (so
 * MCP/CLI/stdio writes flip the store-wide census too); the HTTP POST and PUT
 * routes forward content into rememberTool; read builders prefer the
 * persisted field with an embedding_text fallback for legacy rows.
 *
 * Every `it` below fails on the pre-fix code: the on-disk assertions read
 * the namespace JSONL files DIRECTLY (never through the API), mirroring the
 * acceptance criterion — "record on disk carries content byte-equal to the
 * POSTed string, verified by direct file read".
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, Server } from "http";
import { createHttpServer } from "../../cli/http";
import { drainAsyncCommits } from "../../git/autocommit";
import { createMemory } from "../../schema/memory";
import { rememberTool } from "../../mcp/tools/remember";

const SCRATCH_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-dbhttp001-"),
);
const SCRATCH_NS_ROOT = path.join(SCRATCH_ROOT, "namespaces");
const SCRATCH_CONFIG_PATH = path.join(SCRATCH_ROOT, "duckbrain.config.json");
const NS = "dbhttp001-scratch";

const PREV_NS_PATH = process.env.DUCKBRAIN_NAMESPACES_PATH;
const PREV_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(
  method: string,
  reqPath: string,
  body?: Record<string, unknown>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: reqPath,
      method,
      headers: { Host: "localhost", "Content-Type": "application/json" },
    };
    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Every stored row in the scratch namespace (audit sidecar excluded). */
function storedRows(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_audit" || entry.name === ".duckbrain-audit") {
          continue;
        }
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(full, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            out.push(JSON.parse(line));
          } catch {
            /* unparseable line is its own problem, not this suite's */
          }
        }
      }
    }
  };
  walk(SCRATCH_NS_ROOT);
  return out;
}

function rowById(id: string): Record<string, unknown> | undefined {
  return storedRows().find((r) => r.id === id);
}

beforeAll(async () => {
  fs.mkdirSync(SCRATCH_NS_ROOT, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = SCRATCH_NS_ROOT;
  process.env.DUCKBRAIN_CONFIG_PATH = SCRATCH_CONFIG_PATH;

  const app = createHttpServer({ authType: "none" });
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  // INT-CI-023 (dbgap058 pattern): await the close and drain in-flight async
  // commits BEFORE deleting the scratch tree; bounded-retry rm as the final
  // belt-and-suspenders — cleanup of a temp dir must never red a test.
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await drainAsyncCommits();
  if (PREV_NS_PATH === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = PREV_NS_PATH;
  if (PREV_CONFIG_PATH === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = PREV_CONFIG_PATH;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
});

describe("DB-HTTP-001: record factory persists content", () => {
  it("createMemory persists the supplied content byte-faithfully", () => {
    const payload = "client payload with\ttabs and\nnewlines ✓";
    const memory = createMemory({
      key: "/dbhttp001/unit-supplied",
      domain: "raw_note",
      author: "test@duckbrain.local",
      embedding_text: payload,
      content: payload,
    });
    expect(memory.content).toBe(payload);
    expect(memory.embedding_text).toBe(payload);
  });

  it("createMemory STAMPS content from embedding_text when absent", () => {
    const memory = createMemory({
      key: "/dbhttp001/unit-stamped",
      domain: "raw_note",
      author: "test@duckbrain.local",
      embedding_text: "stamped payload",
    });
    expect(memory.content).toBe("stamped payload");
  });
});

describe("DB-HTTP-001: POST /api/memories persists content on disk", () => {
  it("plain-string content: the JSONL row carries content byte-equal to the POSTed string", async () => {
    const payload = "POSTFIX-PAYLOAD-dbhttp001";
    const { status, body } = await httpRequest("POST", "/api/memories", {
      key: "/dbhttp001/post-plain",
      domain: "raw_note",
      content: payload,
      attributes: {},
      namespace: NS,
    });
    expect(status).toBe(201);
    expect(body.content).toBe(payload); // the echo the defect pretended with

    // DIRECT FILE READ — never through the API. This is the AC.
    const row = rowById(body.id);
    expect(row, "row must exist on disk").toBeDefined();
    if (!row) throw new Error("row must exist on disk");
    expect(
      Object.prototype.hasOwnProperty.call(row, "content"),
      "content key must be PRESENT on the stored row (not absent, not null)",
    ).toBe(true);
    expect(row.content).toBe(payload);
    expect(row.content, "content must be a string, not null").not.toBeNull();
    // embedding_text still carries the payload (embedding generation
    // consumes it — the new field does not replace it).
    expect(row.embedding_text).toBe(payload);
  });

  it("unicode + newlines content survives byte-equal on disk", async () => {
    const payload = "line1\nline2 — ünïcödé ✓ 中文\ttabbed";
    const { status, body } = await httpRequest("POST", "/api/memories", {
      key: "/dbhttp001/post-unicode",
      domain: "raw_note",
      content: payload,
      attributes: {},
      namespace: NS,
    });
    expect(status).toBe(201);

    const row = rowById(body.id);
    expect(row).toBeDefined();
    if (!row) throw new Error("row must exist on disk");
    expect(row.content).toBe(payload);
    expect(row.embedding_text).toBe(payload);
  });
});

describe("DB-HTTP-001: PUT /api/memories/:id persists content on disk", () => {
  it("updated record's content reflects the new content", async () => {
    const created = await httpRequest("POST", "/api/memories", {
      key: "/dbhttp001/put-target",
      domain: "raw_note",
      content: "original body",
      attributes: {},
      namespace: NS,
    });
    expect(created.status).toBe(201);

    const newContent = "updated body — DB-HTTP-001";
    const { status, body } = await httpRequest(
      "PUT",
      `/api/memories/${created.body.id}?namespace=${NS}`,
      { content: newContent },
    );
    expect(status).toBe(200);
    expect(body.content).toBe(newContent);

    // The NEW version row carries the new content on disk. (rememberTool
    // writes every new version with action "add" — the tombstone written by
    // forgetTool carries the deletion; the route's 200 echoes "update" but
    // the stored row's action is "add". Assert the stored truth: a distinct
    // new id, append-only multi-version.)
    const newRow = rowById(body.id);
    expect(newRow).toBeDefined();
    if (!newRow) throw new Error("newRow must exist on disk");
    expect(Object.prototype.hasOwnProperty.call(newRow, "content")).toBe(true);
    expect(newRow.content).toBe(newContent);
    expect(body.id).not.toBe(created.body.id);

    // The original row is untouched (append-only multi-version).
    const oldRow = rowById(created.body.id);
    expect(oldRow).toBeDefined();
    if (!oldRow) throw new Error("oldRow must exist on disk");
    expect(oldRow.content).toBe("original body");
    expect(oldRow.action).toBe("add");
  });

  it("attributes-only update (empty content): new row content = existing embedding_text", async () => {
    const created = await httpRequest("POST", "/api/memories", {
      key: "/dbhttp001/put-attr-only",
      domain: "raw_note",
      content: "body kept through attribute update",
      attributes: {},
      namespace: NS,
    });
    expect(created.status).toBe(201);

    const { status, body } = await httpRequest(
      "PUT",
      `/api/memories/${created.body.id}?namespace=${NS}`,
      { content: "", attributes: { touched: true } },
    );
    expect(status).toBe(200);

    const newRow = rowById(body.id);
    expect(newRow).toBeDefined();
    if (!newRow) throw new Error("newRow must exist on disk");
    expect(newRow.content).toBe("body kept through attribute update");
    expect(newRow.embedding_text).toBe("body kept through attribute update");
  });
});

describe("DB-HTTP-001: rememberTool persists content (stdio / MCP transport equivalence)", () => {
  it("NO content arg: the stored record stamps content === embedding_text", async () => {
    const result = await rememberTool({
      key: "/dbhttp001/mcp-stamped",
      domain: "raw_note",
      attributes: {},
      embedding_text: "stdio payload without separate content",
      namespace: NS,
    });
    expect(result.success).toBe(true);

    const row = rowById(result.id!);
    expect(row).toBeDefined();
    if (!row) throw new Error("row must exist on disk");
    expect(row.content).toBe("stdio payload without separate content");
    expect(row.embedding_text).toBe("stdio payload without separate content");
  });

  it("WITH content arg: the stored record carries content byte-equal (unicode + newlines)", async () => {
    const payload = "mcp payload\nwith — unicode ✓ 中文";
    const result = await rememberTool({
      key: "/dbhttp001/mcp-content",
      domain: "raw_note",
      attributes: {},
      embedding_text: payload,
      content: payload,
      namespace: NS,
    });
    expect(result.success).toBe(true);

    const row = rowById(result.id!);
    expect(row).toBeDefined();
    if (!row) throw new Error("row must exist on disk");
    expect(row.content).toBe(payload);
    expect(row.embedding_text).toBe(payload);
  });
});

describe("DB-HTTP-001: store-wide census — no new record ships without content", () => {
  it("every non-tombstone row in the namespace carries a content string", () => {
    const rows = storedRows().filter((r) => r.action !== "tombstone");
    expect(rows.length).toBeGreaterThan(0);
    const payloadless = rows.filter(
      (r) =>
        !Object.prototype.hasOwnProperty.call(r, "content") ||
        typeof r.content !== "string",
    );
    expect(
      payloadless.map((r) => ({ key: r.key, id: r.id })),
      "every non-tombstone record must carry a content field on disk",
    ).toEqual([]);
  });
});
