/**
 * Unit tests for SSE Events API routes (events.ts)
 *
 * Tests Server-Sent Events routes. SSE routes use persistent connections;
 * we test the GET by reading first event chunk, and POST/GET(stats) normally.
 */

import { describe, it, expect } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";

import { createEventsRoutes } from "./events";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/events", createEventsRoutes);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code,
    });
  });
  return app;
}

function sseRequest(
  app: express.Express,
  path: string,
): Promise<{ body: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const http = require("http");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "GET",
          headers: { Host: "localhost" },
        },
        (res: any) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
            // After receiving first SSE data event, close connection
            if (body.includes("data:")) {
              req.destroy();
              server.close();
              resolve({ body });
            }
          });
          res.on("end", () => {
            server.close();
            resolve({ body });
          });
          // Safety timeout: close after 2s if no data
          setTimeout(() => {
            if (!body) {
              req.destroy();
              server.close();
              resolve({ body });
            }
          }, 2000);
        },
      );
      req.on("error", (err: Error) => {
        server.close();
        // ECONNRESET is expected when we destroy the connection
        if (
          err.message.includes("ECONNRESET") ||
          err.message.includes("socket hang up")
        ) {
          resolve({ body: "" });
        } else {
          reject(err);
        }
      });
      req.end();
    });
  });
}

function jsonRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const http = require("http");
      const options: any = {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: "localhost", "Content-Type": "application/json" },
      };
      const req = http.request(options, (res: any) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

describe("GET /api/events/:namespace (SSE connection)", () => {
  // SSE connections are persistent; we test that the connection is established
  // and the initial connected event is sent.

  it("should send SSE connected event with namespace", async () => {
    const app = createApp();
    const { body } = await sseRequest(app, "/api/events/testns");

    // Should contain the SSE connected event
    expect(body).toContain("data:");
    expect(body).toContain("connected");
    expect(body).toContain("testns");
  });

  it("should send SSE event with timestamp", async () => {
    const app = createApp();
    const { body } = await sseRequest(app, "/api/events/another-ns");

    expect(body).toContain("timestamp");
  });

  it("should accept various namespace names", async () => {
    const app = createApp();
    const { body } = await sseRequest(app, "/api/events/my-project_01");

    expect(body).toContain("my-project_01");
  });
});

describe("POST /api/events/:namespace/broadcast", () => {
  it("should broadcast event and return success", async () => {
    const app = createApp();
    const { status, body } = await jsonRequest(
      app,
      "POST",
      "/api/events/testns/broadcast",
      {
        type: "memory.created",
        data: { id: "123", key: "/test" },
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.namespace).toBe("testns");
    expect(body.connectionsNotified).toBe(0); // No active SSE connections
    expect(body.event.type).toBe("memory.created");
  });

  it("should return 400 when event type is missing", async () => {
    const app = createApp();
    const { status, body } = await jsonRequest(
      app,
      "POST",
      "/api/events/testns/broadcast",
      {
        data: { something: true },
      },
    );

    expect(status).toBe(400);
    expect(body.error).toContain("Event type is required");
  });

  it("should default data to empty object when not provided", async () => {
    const app = createApp();
    const { status, body } = await jsonRequest(
      app,
      "POST",
      "/api/events/testns/broadcast",
      {
        type: "namespace.changed",
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.event.data).toEqual({});
  });

  it("should include timestamp in broadcast response", async () => {
    const app = createApp();
    const { status, body } = await jsonRequest(
      app,
      "POST",
      "/api/events/ns1/broadcast",
      {
        type: "custom.event",
        data: { payload: "test" },
      },
    );

    expect(status).toBe(200);
    expect(body.event.timestamp).toBeDefined();
    expect(typeof body.event.timestamp).toBe("string");
  });
});

describe("GET /api/events/:namespace/stats", () => {
  it("should return connection stats for a namespace", async () => {
    const app = createApp();
    const { status, body } = await jsonRequest(
      app,
      "GET",
      "/api/events/myns/stats",
    );

    expect(status).toBe(200);
    expect(body.namespace).toBe("myns");
    expect(body.activeConnections).toBe(0);
    expect(Array.isArray(body.allNamespaces)).toBe(true);
  });

  it("should have activeConnections as a number", async () => {
    const app = createApp();
    const { status, body } = await jsonRequest(
      app,
      "GET",
      "/api/events/ns-x/stats",
    );

    expect(status).toBe(200);
    expect(typeof body.activeConnections).toBe("number");
  });

  it("should include allNamespaces array with connection counts", async () => {
    const app = createApp();
    const { status, body } = await jsonRequest(
      app,
      "GET",
      "/api/events/all/stats",
    );

    expect(status).toBe(200);
    expect(body.allNamespaces).toBeDefined();
    for (const entry of body.allNamespaces) {
      expect(entry.namespace).toBeDefined();
      expect(typeof entry.connections).toBe("number");
    }
  });
});
