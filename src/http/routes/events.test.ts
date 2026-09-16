/**
 * Unit tests for SSE Events API routes (events.ts)
 *
 * Tests Server-Sent Events routes. SSE routes use persistent connections;
 * we test the GET by reading first event chunk, and POST/GET(stats) normally.
 */

import { describe, it, expect, afterEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";

import { createEventsRoutes } from "./events";
import { REALTIME_ROUTE_PATH, createRealtimeRoutes } from "./realtime";
import { RealtimeHub } from "../realtime/hub";
import {
  createRealtimeFixture,
  memoryInput,
  openSseClient,
  principalMiddleware,
  startApp,
  type RealtimeFixture,
  type RunningApp,
} from "../realtime/fixtures";

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

/**
 * DB-SUPA-5 — the legacy broadcast scaffold is not the committed change feed.
 *
 * The legacy route keeps its own process-local connection map and writes
 * caller-supplied payloads. It must never publish a `duckbrain.change.v1`
 * record, and it must not share active-connection state with the realtime
 * feed. The positive control below proves the feed was live in the same app
 * while the legacy broadcast went out — otherwise "nothing leaked" would only
 * mean "nothing worked".
 */
describe("legacy events route remains isolated", () => {
  const fixtures: RealtimeFixture[] = [];
  const hubs: RealtimeHub[] = [];
  const apps: RunningApp[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const hub of hubs.splice(0)) hub.closeAll();
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  it("does not publish change records and shares no connection state", async () => {
    const fixture = createRealtimeFixture("duckbrain-supa5-legacy-", {
      commitOnFlush: false,
    });
    fixtures.push(fixture);
    const { ns } = fixture;
    const hub = new RealtimeHub({
      namespacesPath: fixture.root,
      pollIntervalMs: 60 * 60 * 1000,
      heartbeatMs: 60 * 60 * 1000,
    });
    hubs.push(hub);

    const app = express();
    app.use(express.json());
    app.use(principalMiddleware(undefined));
    app.use("/api/events", createEventsRoutes);
    app.use(REALTIME_ROUTE_PATH, createRealtimeRoutes({ hub }));
    const running = await startApp(app);
    apps.push(running);

    const legacy = await openSseClient(running.port, `/api/events/${ns}`);
    const feed = await openSseClient(
      running.port,
      `/api/ns/${ns}/changes?tables=memories`,
    );
    expect(legacy.status).toBe(200);
    expect(feed.status).toBe(200);
    await legacy.waitFor((client) => client.frames().length >= 1);
    await feed.waitFor((client) => client.frames().length >= 1);

    // A caller-supplied broadcast on the legacy route.
    const response = await fetch(
      running.url(`/api/events/${ns}/broadcast`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "custom", data: { hello: "legacy" } }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();

    // The legacy client still receives its payload, as an unnamed data frame.
    await legacy.waitFor((client) => client.text().includes("legacy"));
    expect(legacy.text()).not.toContain("duckbrain.change.v1");
    expect(legacy.text()).not.toContain("dbch1.");

    // Nothing from that broadcast reached the change feed: no change record,
    // no cursor, no revisioned position.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(feed.frames().some((frame) => frame.event === "duckbrain.change.v1")).toBe(false);
    expect(feed.text()).not.toContain("dbch1.");
    expect(feed.text()).not.toContain("legacy");

    // Positive control: the feed in this very app delivers a real committed
    // change, so the negative above is isolation and not a dead route.
    await fixture.writer.enqueue(memoryInput(1, ns));
    fixture.commit("test: legacy isolation control");
    await hub.check(ns);
    await feed.waitFor((client) =>
      client.frames().some((frame) => frame.event === "duckbrain.change.v1"),
    );
    const change = feed
      .frames()
      .filter((frame) => frame.event === "duckbrain.change.v1")[0];
    expect(change.id).toMatch(/^dbch1\./);
    expect(JSON.parse(change.data ?? "{}").namespace).toBe(ns);
    // The legacy client never sees committed change records either.
    expect(legacy.text()).not.toContain("duckbrain.change.v1");

    legacy.close();
    feed.close();
  }, 45_000);
});
