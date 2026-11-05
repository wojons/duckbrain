/**
 * DURABILITY-HONESTY-001 — the `X-Durability` header must report what a write
 * ACHIEVED, and the generic-table write path must not claim a barrier it never
 * ran.
 *
 * Before this row: every table insert was `fs.appendFileSync` (page cache) and
 * every PATCH/DELETE rewrite was `fs.writeFileSync` + rename, while the route
 * answered `X-Durability: <configured mode>`. A namespace configured `fsync`
 * therefore advertised `fsync` on a path that never called `fdatasync`.
 *
 * The `fs` syscall spy is the falsifier: it counts the barriers that actually
 * ran during the request. The same probe fails on pre-fix code (0 fdatasync
 * calls, header claiming fsync) and passes now (>= 1 fdatasync, header =
 * fsync, configured mode on its own header).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createServer, type Server } from "http";
import { createHttpServer } from "../../cli/http";
import { invalidateTableRegistry } from "../../schema/table-registry";
import { resetSerializerStateForTests } from "../../serialization/namespaceWriter";
import { removeTempDirSafely } from "../../testing/race-safe-daemon";
import {
  appendRowsToTable,
  type AppendOutcome,
} from "../../duckdb/table-store";
import {
  durabilityHeaders,
  setDurabilityHeaders,
} from "../../storage/durability";
import type { TableDeclaration } from "../../schema/table-registry";

const FSYNC_NS = "honesty-fsync";
const BUFFERED_NS = "honesty-buffered";
const DIRECT_NS = "honesty-direct";

let tmpRoot = "";

function writeLegacyFixture(ns: string, rows = 1): void {
  const nsDir = path.join(tmpRoot, ns);
  fs.mkdirSync(path.join(nsDir, "tables"), { recursive: true });
  fs.writeFileSync(
    path.join(nsDir, "tables", "widgets.table.json"),
    JSON.stringify({
      name: "widgets",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "varchar" },
        { name: "qty", type: "double" },
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    }),
    "utf-8",
  );
  const lines: string[] = [];
  for (let i = 1; i <= rows; i += 1) {
    lines.push(JSON.stringify({ id: i, name: `row-${i}`, qty: i }));
  }
  fs.writeFileSync(
    path.join(nsDir, "tables", "widgets.jsonl"),
    lines.join("\n") + "\n",
    "utf-8",
  );
}

function resetFixture(ns: string): void {
  fs.rmSync(path.join(tmpRoot, ns, "tables"), { recursive: true, force: true });
  fs.rmSync(path.join(tmpRoot, ns, "_audit"), { recursive: true, force: true });
  fs.rmSync(path.join(tmpRoot, ".duckbrain-write"), {
    recursive: true,
    force: true,
  });
  writeLegacyFixture(ns);
}

interface HttpResult {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

function httpRequest(
  app: ReturnType<typeof createHttpServer>,
  method: string,
  reqPath: string,
  opts: { headers?: Record<string, string>; body?: object } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const headers: Record<string, string> = {
        Host: "localhost",
        ...(opts.headers || {}),
      };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      const req = http.request(
        { hostname: "127.0.0.1", port, path: reqPath, method, headers },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          const hdrs: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) hdrs[k.toLowerCase()] = v;
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            server.close();
            const raw = Buffer.concat(chunks).toString("utf-8");
            let parsed: any = raw;
            try {
              parsed = JSON.parse(raw);
            } catch {
              // keep raw
            }
            resolve({
              status: res.statusCode ?? 0,
              body: parsed,
              headers: hdrs,
            });
          });
        },
      );
      req.on("error", reject);
      if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
      req.end();
    });
  });
}

/** Count the real `fdatasync` barriers that run while `fn` executes. */
async function withFdatasyncCount<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  let calls = 0;
  const real = fs.fdatasyncSync.bind(fs);
  const spy = vi.spyOn(fs, "fdatasyncSync").mockImplementation((fd: number) => {
    calls += 1;
    return real(fd);
  });
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durability-honesty-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, "duckbrain.config.json");
  delete process.env.DUCKBRAIN_DURABILITY_MODE;
  fs.writeFileSync(
    process.env.DUCKBRAIN_CONFIG_PATH,
    JSON.stringify(
      {
        durability: {
          defaultMode: "buffered",
          overrides: { [FSYNC_NS]: "fsync", [DIRECT_NS]: "direct" },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeLegacyFixture(FSYNC_NS);
  writeLegacyFixture(BUFFERED_NS);
  writeLegacyFixture(DIRECT_NS);
  resetSerializerStateForTests();
});

afterAll(async () => {
  resetSerializerStateForTests();
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  delete process.env.DUCKBRAIN_CONFIG_PATH;
  await removeTempDirSafely(tmpRoot);
});

beforeEach(() => {
  for (const ns of [FSYNC_NS, BUFFERED_NS, DIRECT_NS]) {
    invalidateTableRegistry(ns);
    resetFixture(ns);
  }
  resetSerializerStateForTests();
});

describe("DURABILITY-HONESTY-001: durabilityHeaders()", () => {
  it("reports configured and achieved as separate values", () => {
    expect(durabilityHeaders("fsync", "fsync")).toEqual({
      "X-Durability": "fsync",
      "X-Durability-Configured": "fsync",
    });
  });

  it("marks a weaker achieved mode as degraded", () => {
    expect(durabilityHeaders("fsync", "buffered")).toEqual({
      "X-Durability": "buffered",
      "X-Durability-Configured": "fsync",
      "X-Durability-Degraded": "configured=fsync; achieved=buffered",
    });
    expect(durabilityHeaders("direct", "fsync")["X-Durability-Degraded"]).toBe(
      "configured=direct; achieved=fsync",
    );
  });

  it("never marks an equal or stronger achieved mode degraded", () => {
    expect(durabilityHeaders("buffered", "buffered")["X-Durability-Degraded"]).toBeUndefined();
    expect(durabilityHeaders("direct", "direct")["X-Durability-Degraded"]).toBeUndefined();
  });

  it("setDurabilityHeaders writes every header to the response sink", () => {
    const seen: Record<string, string> = {};
    setDurabilityHeaders(
      { setHeader: (name: string, value: string) => void (seen[name] = value) },
      "fsync",
      "buffered",
    );
    expect(seen).toEqual({
      "X-Durability": "buffered",
      "X-Durability-Configured": "fsync",
      "X-Durability-Degraded": "configured=fsync; achieved=buffered",
    });
  });
});

describe("DURABILITY-HONESTY-001: generic-table writes honour the configured mode", () => {
  it("POST on an fsync namespace runs fdatasync before the 2xx and reports achieved=fsync", async () => {
    const app = createHttpServer({ authType: "none" });
    const { result, calls } = await withFdatasyncCount(() =>
      httpRequest(app, "POST", `/api/ns/${FSYNC_NS}/tables/widgets`, {
        body: { id: 10, name: "durable", qty: 1 },
      }),
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ inserted: 1 });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(result.headers["x-durability"]).toBe("fsync");
    expect(result.headers["x-durability-configured"]).toBe("fsync");
    expect(result.headers["x-durability-degraded"]).toBeUndefined();

    const stored = fs
      .readFileSync(path.join(tmpRoot, FSYNC_NS, "tables", "widgets.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    expect(stored.some((row) => row.id === 10)).toBe(true);
  });

  it("POST on a buffered namespace performs no barrier and reports buffered (control)", async () => {
    const app = createHttpServer({ authType: "none" });
    const { result, calls } = await withFdatasyncCount(() =>
      httpRequest(app, "POST", `/api/ns/${BUFFERED_NS}/tables/widgets`, {
        body: { id: 11, name: "page-cache", qty: 1 },
      }),
    );

    expect(result.status).toBe(201);
    expect(calls).toBe(0);
    expect(result.headers["x-durability"]).toBe("buffered");
    expect(result.headers["x-durability-configured"]).toBe("buffered");
    expect(result.headers["x-durability-degraded"]).toBeUndefined();
  });

  it("POST on a direct namespace reports the achieved fsync and names the degradation", async () => {
    const app = createHttpServer({ authType: "none" });
    const res = await httpRequest(app, "POST", `/api/ns/${DIRECT_NS}/tables/widgets`, {
      body: { id: 12, name: "direct-config", qty: 1 },
    });

    expect(res.status).toBe(201);
    // A legacy table line cannot be block-framed, so O_DIRECT is unreachable:
    // the strongest achieved mode is fsync, and the client is told so.
    expect(res.headers["x-durability"]).toBe("fsync");
    expect(res.headers["x-durability-configured"]).toBe("direct");
    expect(res.headers["x-durability-degraded"]).toBe(
      "configured=direct; achieved=fsync",
    );
  });

  it("PATCH on an fsync namespace runs fdatasync and reports achieved=fsync", async () => {
    const app = createHttpServer({ authType: "none" });
    const { result, calls } = await withFdatasyncCount(() =>
      httpRequest(app, "PATCH", `/api/ns/${FSYNC_NS}/tables/widgets?pk=eq.1`, {
        body: { qty: 99 },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ updated: 1 });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(result.headers["x-durability"]).toBe("fsync");
  });

  it("DELETE on an fsync namespace runs fdatasync and reports achieved=fsync", async () => {
    const app = createHttpServer({ authType: "none" });
    const { result, calls } = await withFdatasyncCount(() =>
      httpRequest(app, "DELETE", `/api/ns/${FSYNC_NS}/tables/widgets?pk=eq.1`),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ deleted: 1 });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(result.headers["x-durability"]).toBe("fsync");
  });

  it("a non-fsync write path cannot report an achieved fsync for an fsync namespace", () => {
    // The literal AC-1 case: the store is asked to write through the buffered
    // path for a namespace configured fsync. The achieved mode it returns must
    // be buffered, and the headers must expose the gap rather than echo config.
    const declaration = JSON.parse(
      fs.readFileSync(
        path.join(tmpRoot, FSYNC_NS, "tables", "widgets.table.json"),
        "utf-8",
      ),
    ) as TableDeclaration;

    const outcome = appendRowsToTable(
      path.join(tmpRoot, FSYNC_NS),
      declaration,
      [{ id: 13, name: "buffered-path", qty: 1 }],
      "buffered",
    ) as AppendOutcome;

    expect(outcome.achieved).toBe("buffered");
    const headers = durabilityHeaders("fsync", outcome.achieved);
    expect(headers["X-Durability"]).toBe("buffered");
    expect(headers["X-Durability-Degraded"]).toBe(
      "configured=fsync; achieved=buffered",
    );
  });
});
