/**
 * DB-GAP-056 regression suite — the historical "{}" empty-payload literal.
 *
 * DB-GAP-058 closed blank and placeholder ("null"/"undefined"/"n/a") bodies,
 * but the historical corruption class in the fleet corpus is a row whose
 * embedding_text is the literal string "{}" — an attributes object
 * stringified into the content slot (Off-by-One answer 2309: empty memory
 * content must fail validation at the write boundary). Before this fix,
 * POST /api/memories with content "{}" returned 201, created the namespace,
 * and appended the junk row.
 *
 * The assertions that matter are on stored bytes and namespace creation:
 * the defect was junk reaching the storage of record, not the status code.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, Server } from "http";
import { createHttpServer } from "../../cli/http";
import {
  isPlaceholderContent,
  writeContentViolation,
} from "../../schema/memory";
import { rememberTool } from "../../mcp/tools/remember";
import { drainAsyncCommits } from "../../git/autocommit";

const SCRATCH_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "duckbrain-emptycontent-"),
);
const SCRATCH_NS_ROOT = path.join(SCRATCH_ROOT, "namespaces");
const SCRATCH_CONFIG_PATH = path.join(SCRATCH_ROOT, "duckbrain.config.json");
/** Namespace used ONLY for rejected writes — it must never be created. */
const INVALID_NS = "dbgap056-invalid";
/** Namespace for the valid control write. */
const VALID_NS = "dbgap056-valid";

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

/** Every stored row under the scratch namespaces root (audit excluded). */
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

function postContent(content: unknown, key: string, namespace: string) {
  return httpRequest("POST", "/api/memories", {
    key,
    domain: "raw_note",
    content,
    attributes: {},
    namespace,
  });
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
  // Await the close, then drain in-flight async git work BEFORE deleting
  // the scratch tree: an unawaited close returns while the last POST's
  // auto-commit chain (debounce timers are unref'd) can still be writing
  // into <root>/namespaces/<ns>/.git, and the rmSync then dies with
  // ENOTEMPTY while every test in the file has already passed. Mirrors
  // the http-auth.test.ts teardown (close → flush → drainAsyncCommits →
  // rmSync).
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await drainAsyncCommits();
  if (PREV_NS_PATH === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = PREV_NS_PATH;
  if (PREV_CONFIG_PATH === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
  else process.env.DUCKBRAIN_CONFIG_PATH = PREV_CONFIG_PATH;
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe("DB-GAP-056: the shared write-content policy rejects the '{}' literal", () => {
  it("flags the historical empty-payload literal, trimmed", () => {
    expect(isPlaceholderContent("{}")).toBe(true);
    expect(isPlaceholderContent("  {}  ")).toBe(true);
    expect(isPlaceholderContent("\t{}\n")).toBe(true);
  });

  it("does NOT flag JSON-looking real content", () => {
    expect(isPlaceholderContent('{"a": 1}')).toBe(false);
    expect(isPlaceholderContent("{} is the empty object")).toBe(false);
    expect(isPlaceholderContent("[{}]")).toBe(false);
  });

  it("rejects '{}' bodies for a real write, accepts real content", () => {
    for (const bad of ["{}", "  {}  ", "\t{}\n"]) {
      expect(
        writeContentViolation({ action: "add", embedding_text: bad }),
        `content ${JSON.stringify(bad)} must be refused`,
      ).not.toBeNull();
    }
    expect(
      writeContentViolation({ action: "add", embedding_text: "a real memory" }),
    ).toBeNull();
  });

  it("EXEMPTS tombstones — a deletion marker has no content by definition", () => {
    expect(
      writeContentViolation({ action: "tombstone", embedding_text: "{}" }),
    ).toBeNull();
  });
});

describe("DB-GAP-056: POST /api/memories refuses the '{}' literal", () => {
  it("rejects content '{}' with 400", async () => {
    const { status } = await postContent("{}", "/dbgap056/braces", INVALID_NS);
    expect(status).toBe(400);
  });

  it("rejects padded content '  {}  ' with 400", async () => {
    const { status } = await postContent(
      "  {}  ",
      "/dbgap056/braces-padded",
      INVALID_NS,
    );
    expect(status).toBe(400);
  });

  it("NEGATIVE CONTROL: real content is still accepted (201)", async () => {
    const { status, body } = await postContent(
      "a genuine memory body",
      "/dbgap056/real",
      VALID_NS,
    );
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
  });
});

describe("DB-GAP-056: the MCP remember tool refuses the '{}' literal", () => {
  it("returns success=false with the BLANK_CONTENT code before any write", async () => {
    const result = await rememberTool({
      key: "/dbgap056/mcp-braces",
      domain: "raw_note",
      attributes: {},
      embedding_text: "{}",
      namespace: INVALID_NS,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("BLANK_CONTENT");
  });
});

describe("DB-GAP-056: rejected writes leave no trace", () => {
  it("created no namespace for the invalid writes", () => {
    expect(
      fs.existsSync(path.join(SCRATCH_NS_ROOT, INVALID_NS)),
      `namespace '${INVALID_NS}' must not exist after rejected writes`,
    ).toBe(false);
  });

  it("appended no JSONL row for the invalid writes; the valid control landed", () => {
    const rows = storedRows();
    const junk = rows.filter((r) => {
      const text = r.embedding_text;
      return typeof text === "string" && text.trim() === "{}";
    });
    expect(
      junk.map((r) => ({ key: r.key, text: r.embedding_text })),
      "no '{}' row may reach the storage of record",
    ).toEqual([]);

    const keys = rows.map((r) => r.key);
    expect(keys).toContain("/dbgap056/real");
    expect(keys).not.toContain("/dbgap056/braces");
    expect(keys).not.toContain("/dbgap056/braces-padded");
    expect(keys).not.toContain("/dbgap056/mcp-braces");
  });
});
