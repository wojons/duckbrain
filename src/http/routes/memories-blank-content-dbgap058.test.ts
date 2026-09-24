/**
 * DB-GAP-058 / TOKEN-NAME-001 / API-CONTRACT-001 regression suite.
 *
 * Three defects reproduced at runtime while executing the release test plan
 * (see the plan's S1/S2/S3 gates). Each `describe` block below fails on the
 * pre-fix code and passes after it.
 *
 *  DB-GAP-058        the write path accepted junk bodies. `""` was caught by
 *                    a truthiness test, but `"   "`, `"\t\n  "`, `"null"` and
 *                    `"undefined"` all returned 201, were written to the
 *                    namespace JSONL and were replicated to S3.
 *  TOKEN-NAME-001    `token --name X` (space form) stored the token name as
 *                    the literal string "true" — and the token name is the
 *                    author identity, so every row it wrote was attributed to
 *                    true@duckbrain.local.
 *  API-CONTRACT-001  GET /api/memories returned no `count` and no `memories`
 *                    key, so a client reading either spelling saw zero rows
 *                    while the server had returned a full page.
 *
 * The stored-bytes assertions matter more than the status codes here: the
 * original defect was not that the API answered oddly, it was that junk
 * reached the storage of record.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, Server } from "http";
import { createHttpServer } from "../../cli/http";
import {
  BLANK_CONTENT_MESSAGE,
  isBlankContent,
  isPlaceholderContent,
  writeContentViolation,
} from "../../schema/memory";

const SCRATCH_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-blankcontent-"),
);
const SCRATCH_NS_ROOT = path.join(SCRATCH_ROOT, "namespaces");
const SCRATCH_CONFIG_PATH = path.join(SCRATCH_ROOT, "duckbrain.config.json");
const NS = "blankcontent-scratch";

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

function postContent(content: unknown, key: string) {
  return httpRequest("POST", "/api/memories", {
    key,
    domain: "raw_note",
    content,
    attributes: {},
    namespace: NS,
  });
}

beforeAll(async () => {
  fs.mkdirSync(SCRATCH_NS_ROOT, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = SCRATCH_NS_ROOT;
  process.env.DUCKBRAIN_CONFIG_PATH = SCRATCH_CONFIG_PATH;

  const app = createHttpServer();
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") port = addr.port;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  if (PREV_NS_PATH === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = PREV_NS_PATH;
  if (PREV_CONFIG_PATH === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = PREV_CONFIG_PATH;
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe("DB-GAP-058: the shared write-content policy", () => {
  it("classifies every body the defect let through as blank", () => {
    expect(isBlankContent("")).toBe(true);
    expect(isBlankContent("   ")).toBe(true);
    expect(isBlankContent("\t\n  ")).toBe(true);
    expect(isBlankContent("\u00a0")).toBe(true); // non-breaking space
    expect(isBlankContent(undefined)).toBe(true);
    expect(isBlankContent(null)).toBe(true);
    expect(isBlankContent(42)).toBe(true);
  });

  it("does NOT classify real content as blank", () => {
    expect(isBlankContent("x")).toBe(false);
    expect(isBlankContent("  hi  ")).toBe(false);
    expect(isBlankContent("0")).toBe(false); // a stringified zero is content
    expect(isBlankContent("false")).toBe(false); // so is the word "false"
  });

  it("flags the placeholder literals that made junk look real", () => {
    expect(isPlaceholderContent("null")).toBe(true);
    expect(isPlaceholderContent("NULL")).toBe(true);
    expect(isPlaceholderContent("  undefined ")).toBe(true);
    expect(isPlaceholderContent("n/a")).toBe(true);
    expect(isPlaceholderContent("nullified")).toBe(false);
    expect(isPlaceholderContent("a null value")).toBe(false);
  });

  it("rejects blank and placeholder bodies for a real write", () => {
    for (const bad of ["", "   ", "\t\n  ", "null", "undefined", "N/A"]) {
      expect(
        writeContentViolation({ action: "add", embedding_text: bad }),
        `content ${JSON.stringify(bad)} must be refused`,
      ).not.toBeNull();
    }
    expect(writeContentViolation({ action: "add", embedding_text: "" })).toBe(
      BLANK_CONTENT_MESSAGE,
    );
  });

  it("EXEMPTS tombstones — a deletion marker has no content by definition", () => {
    // tombstoneMemory() writes embedding_text:"" for an unknown-id delete.
    // Retro-rejecting that would make deletion impossible.
    expect(
      writeContentViolation({ action: "tombstone", embedding_text: "" }),
    ).toBeNull();
    expect(
      writeContentViolation({ action: "tombstone", embedding_text: "   " }),
    ).toBeNull();
  });

  it("accepts real content", () => {
    expect(
      writeContentViolation({ action: "add", embedding_text: "a real memory" }),
    ).toBeNull();
    expect(
      writeContentViolation({ action: "add", embedding_text: "  padded  " }),
    ).toBeNull();
  });
});

describe("DB-GAP-058: POST /api/memories refuses junk bodies", () => {
  it('rejects whitespace-only content ("   ") with 400', async () => {
    const { status } = await postContent("   ", "/dbgap058/ws3");
    expect(status).toBe(400);
  });

  it('rejects tab/newline whitespace ("\\t\\n  ") with 400', async () => {
    const { status } = await postContent("\t\n  ", "/dbgap058/wstab");
    expect(status).toBe(400);
  });

  it('rejects the placeholder "null" with 400', async () => {
    const { status } = await postContent("null", "/dbgap058/null");
    expect(status).toBe(400);
  });

  it('rejects the placeholder "undefined" with 400', async () => {
    const { status } = await postContent("undefined", "/dbgap058/undef");
    expect(status).toBe(400);
  });

  it("still rejects an empty string, with the original message (back-compat)", async () => {
    const { status, body } = await postContent("", "/dbgap058/empty");
    expect(status).toBe(400);
    expect(String(body.error)).toContain("Missing required fields");
  });

  it("still rejects a missing content field", async () => {
    const { status, body } = await httpRequest("POST", "/api/memories", {
      key: "/dbgap058/nofield",
      domain: "raw_note",
      attributes: {},
      namespace: NS,
    });
    expect(status).toBe(400);
    expect(String(body.error)).toContain("Missing required fields");
  });

  it("refuses a non-string content", async () => {
    const { status } = await postContent(12345, "/dbgap058/nonstring");
    expect(status).toBe(400);
  });

  it("NEGATIVE CONTROL: real content padded with spaces is still accepted", async () => {
    const { status, body } = await postContent(
      "  a genuine memory body  ",
      "/dbgap058/padded",
    );
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
  });

  it("NEGATIVE CONTROL: a legitimate body with an inner '=' is still accepted", async () => {
    const { status } = await postContent(
      "config rc=1 dims=4096",
      "/dbgap058/eq",
    );
    expect(status).toBe(201);
  });

  it("STORED BYTES: after every rejection, not one junk row exists in the namespace", async () => {
    const rows = storedRows();
    const junk = rows.filter((r) => {
      const text = r.embedding_text;
      if (typeof text !== "string") return true;
      const t = text.trim().toLowerCase();
      return t.length === 0 || t === "null" || t === "undefined" || t === "n/a";
    });
    expect(
      junk.map((r) => ({ key: r.key, text: r.embedding_text })),
      "the namespace must contain no blank or placeholder body",
    ).toEqual([]);

    // And the rows that SHOULD have landed, did.
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("/dbgap058/padded");
    expect(keys).not.toContain("/dbgap058/ws3");
    expect(keys).not.toContain("/dbgap058/null");
  });
});

describe("DB-GAP-058: PUT /api/memories/:id refuses a junk body", () => {
  it("refuses whitespace-only content on update", async () => {
    const created = await postContent("original body", "/dbgap058/put-target");
    expect(created.status).toBe(201);
    const id = created.body.id;

    const { status } = await httpRequest(
      "PUT",
      `/api/memories/${id}?namespace=${NS}`,
      { content: "   " },
    );
    expect(status).toBe(400);
  });

  it("refuses the placeholder 'null' on update", async () => {
    const created = await postContent(
      "original body 2",
      "/dbgap058/put-target2",
    );
    expect(created.status).toBe(201);

    const { status } = await httpRequest(
      "PUT",
      `/api/memories/${created.body.id}?namespace=${NS}`,
      { content: "null" },
    );
    expect(status).toBe(400);
  });

  it("still allows an attributes-only update (empty content = keep existing)", async () => {
    const created = await postContent(
      "original body 3",
      "/dbgap058/put-target3",
    );
    expect(created.status).toBe(201);

    const { status } = await httpRequest(
      "PUT",
      `/api/memories/${created.body.id}?namespace=${NS}`,
      { content: "", attributes: { touched: true } },
    );
    expect(status).toBe(200);
  });
});

describe("API-CONTRACT-001: GET /api/memories exposes the alias spellings", () => {
  it("returns count and memories alongside total and items, and they agree", async () => {
    const { status, body } = await httpRequest(
      "GET",
      `/api/memories?namespace=${NS}`,
    );
    expect(status).toBe(200);

    // The two spellings a client is most likely to reach for.
    expect(body.count).toBeDefined();
    expect(body.memories).toBeDefined();

    // They must agree with the canonical fields — not merely exist.
    expect(body.count).toBe(body.total);
    expect(Array.isArray(body.memories)).toBe(true);
    expect(body.memories).toEqual(body.items);

    // And a client reading only the alias must not see a phantom zero.
    expect(body.count).toBeGreaterThan(0);
    expect(body.memories.length).toBe(body.count);
  });
});
