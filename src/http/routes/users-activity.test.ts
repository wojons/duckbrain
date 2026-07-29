/**
 * Unit tests for /users and /activity HTTP endpoints
 *
 * Tests the Express app directly (in-process) — fast, no port binding.
 * Follows the cli-security.test.ts pattern.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";

let server: Server;
let port: number;

function request(
  method: string,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: "localhost" },
      },
      (res: any) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("/users endpoint", () => {
  beforeAll(async () => {
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
    server.close();
  });

  it("should return 200 with users array", async () => {
    const { status, body } = await request("GET", "/users");
    expect(status).toBe(200);
    expect(body.users).toBeDefined();
    expect(Array.isArray(body.users)).toBe(true);
  });

  it("should return count matching users array length", async () => {
    const { status, body } = await request("GET", "/users");
    expect(status).toBe(200);
    expect(body.count).toBe(body.users.length);
  });

  it("should reject POST with 404", async () => {
    const { status } = await request("POST", "/users");
    expect(status).toBe(404);
  });
});

describe("/activity endpoint", () => {
  beforeAll(async () => {
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
    server.close();
  });

  it("should return 200 with activities array", async () => {
    const { status, body } = await request("GET", "/activity");
    expect(status).toBe(200);
    expect(body.activities).toBeDefined();
    expect(Array.isArray(body.activities)).toBe(true);
  });

  it("should return count matching activities array length", async () => {
    const { status, body } = await request("GET", "/activity");
    expect(status).toBe(200);
    expect(body.count).toBe(body.activities.length);
  });

  it("should accept limit query parameter", async () => {
    const { status, body } = await request("GET", "/activity?limit=10");
    expect(status).toBe(200);
    expect(body.limit).toBe(10);
    expect(body.activities).toBeDefined();
    expect(Array.isArray(body.activities)).toBe(true);
  });

  it("should cap limit at 200", async () => {
    const { status, body } = await request("GET", "/activity?limit=500");
    expect(status).toBe(200);
    expect(body.limit).toBeLessThanOrEqual(200);
  });

  it("should reject POST with 404", async () => {
    const { status } = await request("POST", "/activity");
    expect(status).toBe(404);
  });
});

describe("combined: users and activity are separate", () => {
  beforeAll(async () => {
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
    server.close();
  });

  it("/users should not return activity data", async () => {
    const { body: userBody } = await request("GET", "/users");
    expect(userBody.activities).toBeUndefined();
  });

  it("/activity should not return user data", async () => {
    const { body: activityBody } = await request("GET", "/activity");
    expect(activityBody.users).toBeUndefined();
  });

  it("activity entries should have expected shape when populated", async () => {
    const { body } = await request("GET", "/activity");
    expect(body.activities).toBeDefined();
    // If there are activities, verify their shape
    if (body.activities.length > 0) {
      const entry = body.activities[0];
      expect(entry.id).toBeDefined();
      expect(entry.key).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      expect(entry.author).toBeDefined();
      expect(entry.action).toBeDefined();
    }
  });
});
