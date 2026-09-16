/**
 * DB-SUPA-5 AC-2 — SSE-only route and strict subscription grammar.
 *
 * Named checks: `strict subscription grammar`, `SSE is the sole v1 transport`.
 *
 * These requests run against a real Express server with the real route mounted
 * at `REALTIME_ROUTE_PATH`, exercised over real HTTP.
 */

import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import fs from "fs";
import path from "path";
import { REALTIME_ROUTE_PATH, createRealtimeRoutes } from "./realtime";
import { RealtimeHub } from "../realtime/hub";
import {
  createRealtimeFixture,
  memoryInput,
  openSseClient,
  principalMiddleware,
  startApp,
  tombstoneInput,
  waitFor,
  type RealtimeFixture,
  type RunningApp,
} from "../realtime/fixtures";

const fixtures: RealtimeFixture[] = [];
const hubs: RealtimeHub[] = [];
const apps: RunningApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const hub of hubs.splice(0)) hub.closeAll();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function server(): Promise<{
  fixture: RealtimeFixture;
  hub: RealtimeHub;
  app: RunningApp;
  feed: (query: string, ns?: string) => string;
  legacyPath: string;
}> {
  const fixture = createRealtimeFixture("duckbrain-supa5-routes-", {
    commitOnFlush: false,
  });
  fixtures.push(fixture);
  const hub = new RealtimeHub({
    namespacesPath: fixture.root,
    pollIntervalMs: 60 * 60 * 1000,
    heartbeatMs: 60 * 60 * 1000,
  });
  hubs.push(hub);

  const app = express();
  app.use(express.json());
  // `auth=none` local mode installs no principal; the route then evaluates
  // grants against `undefined` exactly as the real middleware chain leaves it.
  app.use(principalMiddleware(undefined));
  app.use(REALTIME_ROUTE_PATH, createRealtimeRoutes({ hub }));
  const running = await startApp(app);
  apps.push(running);

  return {
    fixture,
    hub,
    app: running,
    feed: (query: string, ns = fixture.ns) =>
      `/api/ns/${ns}/changes${query === "" ? "" : `?${query}`}`,
    legacyPath: `/api/events/${fixture.ns}`,
  };
}

async function expectJsonError(
  port: number,
  requestPath: string,
  status: number,
  code: string,
): Promise<void> {
  const client = await openSseClient(port, requestPath);
  const text = client.text();
  client.close();
  expect({ status: client.status, code: JSON.parse(text).code }).toEqual({
    status,
    code,
  });
  // No partial stream on a rejected subscription.
  expect(client.headers["content-type"]).toContain("application/json");
  expect(text).not.toContain("duckbrain.ready.v1");
  expect(text).not.toContain("duckbrain.change.v1");
}

describe("DB-SUPA-5 subscription grammar", () => {
  it("strict subscription grammar", async () => {
    const { fixture, hub, app, feed } = await server();
    const { ns } = fixture;

    // ---- accepted grammar -------------------------------------------------
    const ok = await openSseClient(app.port, feed("ops=insert&tables=memories"));
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/event-stream");
    expect(ok.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(ok.headers["connection"]).toBe("keep-alive");
    expect(ok.headers["x-accel-buffering"]).toBe("no");
    await ok.waitFor((client) => client.frames().length >= 1);
    const readyFrames = ok.frames();
    expect(readyFrames[0].event).toBe("duckbrain.ready.v1");
    // The control event is not a data change and carries no SSE id.
    expect(readyFrames[0].id).toBeNull();
    expect(JSON.parse(readyFrames[0].data ?? "{}")).toEqual({
      version: 1,
      namespace: ns,
      head: null,
    });
    expect(ok.frames().some((frame) => frame.event === "duckbrain.change.v1")).toBe(
      false,
    );

    // An absent cursor is legal; an empty one is not.
    await expectJsonError(app.port, feed("cursor="), 400, "INVALID_CURSOR");

    // ---- unknown, duplicate, malformed tokens ----------------------------
    await expectJsonError(
      app.port,
      feed("ops=upsert"),
      400,
      "INVALID_SUBSCRIPTION",
    );
    await expectJsonError(
      app.port,
      feed("ops=insert,INSERT"),
      400,
      "INVALID_SUBSCRIPTION",
    );
    await expectJsonError(
      app.port,
      feed("ops=insert,insert"),
      400,
      "INVALID_SUBSCRIPTION",
    );
    await expectJsonError(app.port, feed("ops="), 400, "INVALID_SUBSCRIPTION");
    await expectJsonError(
      app.port,
      feed("ops=insert,,delete"),
      400,
      "INVALID_SUBSCRIPTION",
    );
    await expectJsonError(
      app.port,
      feed("ops=insert&ops=delete"),
      400,
      "INVALID_SUBSCRIPTION",
    );
    await expectJsonError(
      app.port,
      feed("tables=memories,memories"),
      400,
      "INVALID_SUBSCRIPTION",
    );
    await expectJsonError(app.port, feed("tables="), 400, "INVALID_SUBSCRIPTION");
    // An unknown table never yields a partial stream.
    await expectJsonError(
      app.port,
      feed("tables=memories,nope"),
      400,
      "INVALID_SUBSCRIPTION",
    );
    await expectJsonError(
      app.port,
      feed("tables=nope"),
      400,
      "INVALID_SUBSCRIPTION",
    );
    // Malformed cursor / conflicting Last-Event-ID.
    await expectJsonError(
      app.port,
      feed("cursor=not-a-cursor"),
      400,
      "INVALID_CURSOR",
    );
    await expectJsonError(
      app.port,
      feed("cursor=dbch1.abc"),
      400,
      "INVALID_CURSOR",
    );
    await expectJsonError(
      app.port,
      feed("cursor=not-a-cursor"),
      400,
      "INVALID_CURSOR",
    );
    // An unknown namespace is a documented 404, not an empty stream.
    const missing = await openSseClient(app.port, feed("", "ns-does-not-exist"));
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.text()).code).toBe("NOT_FOUND");
    missing.close();

    // `cursor` and a non-identical `Last-Event-ID` are mutually exclusive.
    const conflicting = await openSseClient(app.port, feed("cursor=dbch1.abc"), {
      headers: { "Last-Event-ID": "dbch1.def" },
    });
    expect(conflicting.status).toBe(400);
    expect(JSON.parse(conflicting.text()).code).toBe("INVALID_SUBSCRIPTION");
    conflicting.close();

    // ---- the requested subset is honored ---------------------------------
    const all = await openSseClient(app.port, feed(""));
    expect(all.status).toBe(200);
    const insertOnly = await openSseClient(app.port, feed("ops=insert"));
    expect(insertOnly.status).toBe(200);

    const insert = memoryInput(1, ns);
    await fixture.writer.enqueue(insert);
    await fixture.writer.enqueue(tombstoneInput(insert.record as never, ns));
    fixture.commit("test: ops subset");
    await hub.check(ns);

    // The unfiltered subscriber sees both committed changes; the `ops=insert`
    // subscribers see only the insert — the same commit, filtered per request.
    await all.waitFor((client) => client.events().length >= 2);
    await waitFor(
      () => insertOnly.events().length >= 1 && ok.events().length >= 1,
      5000,
      "ops=insert subscribers to flush",
    );
    // Give a mis-filtered extra event a chance to appear before asserting.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(insertOnly.events().map((event) => event.op)).toEqual(["insert"]);
    expect(ok.events().map((event) => event.op)).toEqual(["insert"]);
    expect(all.events().map((event) => event.op)).toEqual(["insert", "delete"]);
    expect(all.events()[0].position).toMatchObject({ ordinal: 1 });

    all.close();
    ok.close();
    insertOnly.close();
  }, 30_000);

  it("SSE is the sole v1 transport", async () => {
    const { app, feed } = await server();

    // One route, one grammar: no second protocol path.
    expect(REALTIME_ROUTE_PATH).toBe("/api/ns/:ns/changes");

    // Only GET subscribes — there is no POST/PUT/DELETE publishing surface,
    // and the legacy broadcast path is a different route that cannot publish
    // change records.
    const postStatus = await new Promise<number>((resolve, reject) => {
      const req = require("http").request(
        {
          host: "127.0.0.1",
          port: app.port,
          path: feed(""),
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (res: { statusCode: number; resume: () => void }) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(postStatus).toBe(404);

    // An HTTP Upgrade request is never answered with 101 Switching Protocols:
    // no WebSocket endpoint exists on the subscription route.
    const upgradeStatus = await new Promise<number | "closed">((resolve) => {
      let settled = false;
      const finish = (value: number | "closed") => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const req = require("http").request(
        {
          host: "127.0.0.1",
          port: app.port,
          path: feed(""),
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        },
        (res: { statusCode: number; resume: () => void }) => {
          res.resume();
          finish(res.statusCode);
        },
      );
      req.on("error", () => finish("closed"));
      req.on("upgrade", () => finish(101));
      req.setTimeout(2000, () => {
        req.destroy();
        finish("closed");
      });
      req.end();
    });
    expect(upgradeStatus).not.toBe(101);

    // Source-level proof: no WebSocket transport, dependency, or dual protocol
    // exists anywhere in the feed implementation. Comments are stripped first —
    // the modules *document* that v1 is SSE-only, which is not a transport.
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const realtimeModules = [
      path.join(__dirname, "realtime.ts"),
      path.join(__dirname, "..", "realtime", "hub.ts"),
      path.join(__dirname, "..", "realtime", "wire.ts"),
      path.join(__dirname, "..", "realtime", "cursor.ts"),
      path.join(__dirname, "..", "realtime", "replay.ts"),
    ];
    for (const file of realtimeModules) {
      const code = stripComments(fs.readFileSync(file, "utf-8"));
      expect(code, file).not.toMatch(
        /new WebSocket|WebSocketServer|from\s+["']ws["']|require\(["']ws["']\)|socket\.io|["']upgrade["']/,
      );
      expect(code, file).not.toMatch(/\bwss?:\/\//);
    }
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "package.json"), "utf-8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    expect(Object.keys(declared)).not.toContain("ws");
    expect(Object.keys(declared)).not.toContain("socket.io");
  }, 30_000);
});
