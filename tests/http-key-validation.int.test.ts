/**
 * DF-0926-06: key-path validation returns 400 instead of 500
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess } from "child_process";
import {
  getRandomPort,
  startDuckbrainHttp,
  killProcess,
  waitForUrl,
  curl,
  DAEMON_READY_TIMEOUT_MS,
} from "./helpers";

const port = getRandomPort();
let server: ChildProcess;

describe("DF-0926-06: key-path validation", () => {
  beforeAll(async () => {
    server = await startDuckbrainHttp({ port, authType: "none" });
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      DAEMON_READY_TIMEOUT_MS,
      server,
    );
  }, 120000);

  afterAll(() => {
    killProcess(server);
  });

  it("returns 400 for key missing leading slash", async () => {
    const res = await curl(
      `-X POST -H "Content-Type: application/json" -d '{"key":"examples/http/test","domain":"concept","content":"test content"}' http://127.0.0.1:${port}/api/memories`,
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("key must be a filesystem-style path");
  });

  it("returns 201 for key with leading slash", async () => {
    const res = await curl(
      `-X POST -H "Content-Type: application/json" -d '{"key":"/examples/http/test","domain":"concept","content":"test content"}' http://127.0.0.1:${port}/api/memories`,
    );
    expect(res.status).toBe(201);
  });
});
