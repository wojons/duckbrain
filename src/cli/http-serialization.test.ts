import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createHttpServer } from "./http";
import { readAuditRows } from "../serialization/audit";
import {
  resetSerializerStateForTests,
  setSerializerAuthorizationHook,
} from "../serialization/namespaceWriter";

const root = process.env.DUCKBRAIN_NAMESPACES_PATH as string;
const configPath = process.env.DUCKBRAIN_CONFIG_PATH as string;
let server: Server;
let port: number;

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function postMemory(ns: string, index: number): Promise<Response> {
  const body = JSON.stringify({
    key: `/supa2/http/${ns}/${index}`,
    domain: "concept",
    content: `http ${index}`,
    attributes: { index },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/memories?namespace=${ns}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: raw ? JSON.parse(raw) : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function dataLines(ns: string): any[] {
  const nsDir = path.join(root, ns);
  const result: any[] = [];
  if (!fs.existsSync(nsDir)) return result;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "_audit") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(full, "utf-8").split("\n")) {
          if (line.trim()) result.push(JSON.parse(line));
        }
      }
    }
  };
  walk(nsDir);
  return result;
}

beforeAll(async () => {
  const app = createHttpServer({
    authConfig: { type: "none" },
    rateLimit: 10_000,
  });
  server = await new Promise<Server>((resolve) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  resetSerializerStateForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetSerializerStateForTests();
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      serialization: {
        maxPendingRows: 10_000,
        maxPendingBytes: 32 * 1024 * 1024,
      },
      gitBatching: { enabled: true, maxLines: 100, maxSeconds: 30 },
    }),
  );
  for (let i = 0; i < 4; i++) {
    fs.rmSync(path.join(root, `http${i}`), { recursive: true, force: true });
  }
  fs.rmSync(path.join(root, "bounded"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "denied"), { recursive: true, force: true });
});

describe("SUPA-2 HTTP fan-in", () => {
  it("acknowledges 32 concurrent writes across 4 namespaces with parseable, complete files", async () => {
    const responses = await Promise.all(
      Array.from({ length: 32 }, (_, i) => postMemory(`http${i % 4}`, i)),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(
      responses.every(
        (response) => response.headers["x-durability"] === "buffered",
      ),
    ).toBe(true);
    expect(
      Array.from({ length: 4 }, (_, i) => dataLines(`http${i}`).length).reduce(
        (sum, count) => sum + count,
        0,
      ),
    ).toBe(32);
  });

  it("maps queue pressure to 503 with Retry-After: 1", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        serialization: { maxPendingRows: 1, maxPendingBytes: 32 * 1024 * 1024 },
      }),
    );
    let releaseFlush!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    setSerializerAuthorizationHook(async (_request, phase) => {
      if (phase === "flush") await gate;
      return { allowed: true };
    });

    const first = postMemory("bounded", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await postMemory("bounded", 2);
    expect(second.status).toBe(503);
    expect(second.body.code).toBe("SERIALIZER_QUEUE_FULL");
    expect(second.headers["retry-after"]).toBe("1");

    releaseFlush();
    expect((await first).status).toBe(201);
  });

  it("maps role denial to 403 without writing data and persists a denial audit", async () => {
    setSerializerAuthorizationHook(() => ({
      allowed: false,
      reason: "table_grant",
      message: "write denied",
    }));

    const response = await postMemory("denied", 1);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
    expect(dataLines("denied")).toHaveLength(0);
    expect(readAuditRows(root, "denied")).toMatchObject([
      { ns: "denied", outcome: "denied", reason: "table_grant" },
    ]);
  });
});
