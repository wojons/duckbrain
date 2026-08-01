/**
 * Tests for HTTP server Unix socket support
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpServer, listenOnSocket } from "./http";
import http from "http";
import os from "os";
import path from "path";
import fs from "fs";

describe("HTTP server Unix socket support", () => {
  let socketDir: string;
  let socketPath: string;

  // Fresh temp dir per test so afterEach cleanup never breaks the next test
  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-sock-"));
    socketPath = path.join(socketDir, "duckbrain.sock");
  });

  afterEach(() => {
    try {
      fs.rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("serves requests over a Unix socket", async () => {
    const app = createHttpServer({ port: 0, socket: socketPath });
    const server = await listenOnSocket(app, socketPath);

    try {
      // HTTP over Unix socket via Node http client with socketPath
      const res = await new Promise<{ status: number; body: any }>(
        (resolve, reject) => {
          const req = http.request(
            { socketPath, path: "/health", method: "GET" },
            (res) => {
              let data = "";
              res.on("data", (c) => (data += c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: JSON.parse(data),
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("socket file is created with the requested permissions", async () => {
    const app = createHttpServer({
      port: 0,
      socket: socketPath,
      socketMode: "0660",
    });
    const server = await listenOnSocket(app, socketPath, {
      socketMode: "0660",
    });

    try {
      const stat = fs.statSync(socketPath);
      expect(stat.isSocket()).toBe(true);
      // mode 0660 → 0o660 & 0o7777
      expect(stat.mode & 0o7777).toBe(0o660);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("removes a stale socket file before binding", async () => {
    // Create a stale (non-socket) file at the path
    fs.writeFileSync(socketPath, "stale");

    const app = createHttpServer({ port: 0, socket: socketPath });
    const server = await listenOnSocket(app, socketPath);

    try {
      const stat = fs.statSync(socketPath);
      expect(stat.isSocket()).toBe(true);
      expect(stat.size).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("health endpoint responds via socketPath-based client", async () => {
    const app = createHttpServer({ port: 0, socket: socketPath });
    const server = await listenOnSocket(app, socketPath);

    try {
      const viaNode = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { socketPath, path: "/health", method: "GET" },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });

      expect(viaNode).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
