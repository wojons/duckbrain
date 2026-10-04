import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterAll } from "vitest";
import { startDuckbrainHttp, killProcess } from "../tests/helpers";

/**
 * INT-CI-018 (judge rework): /health answering is NOT identity. A foreign
 * listener squatting the port must never be accepted as "our" daemon. This
 * file proves the startDuckbrainHttp identity path REJECTS a foreign
 * responder: startDuckbrainHttp on a port already owned by a plain
 * http.Server (which answers 200 to /health) must not return a child that
 * points at the squatter — the sentinel check fails (or the child dies
 * EADDRINUSE) and the bounded retry either lands on a fresh port or throws
 * after MAX_SPAWN_ATTEMPTS, never trusting the foreign /health.
 */

const spawned: import("child_process").ChildProcess[] = [];

afterAll(() => {
  for (const child of spawned) killProcess(child);
});

describe("startDuckbrainHttp identity verification (INT-CI-018 rework)", () => {
  it(
    "rejects a foreign /health responder squatting the port",
    async () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-idv-"));
      const nsRoot = path.join(scratch, "namespaces");
      fs.mkdirSync(path.join(nsRoot, "default"), { recursive: true });

      // Foreign listener: a bare HTTP server that answers /health 200. It
      // does NOT know the sentinel, so the identity probe must reject it.
      const squatter = http.createServer((_req, res) => {
        res.statusCode = 200;
        res.end("not-a-duckbrain");
      });
      await new Promise<void>((resolve) =>
        squatter.listen(0, "127.0.0.1", resolve),
      );
      const squatterPort = (squatter.address() as { port: number }).port;

      // The squatter holds the port for the whole window: every retry of
      // startDuckbrainHttp must see a foreign (or dead-child) port.
      try {
        const child = await startDuckbrainHttp({
          port: squatterPort,
          env: {
            DUCKBRAIN_DATA_DIR: scratch,
            DUCKBRAIN_NAMESPACES_PATH: nsRoot,
          },
        });
        spawned.push(child);
        // If a retry succeeded, it can ONLY be on a fresh port — the
        // identity check must never have blessed the squatter's port.
        expect(child.port).not.toBe(squatterPort);
      } catch (err) {
        // Exhausted attempts is equally acceptable: the point is that the
        // foreign listener was never accepted.
        expect(String((err as Error)?.message)).toMatch(/foreign|EADDRINUSE|exited|not serving this rig/i);
      } finally {
        squatter.close();
        await new Promise<void>((r) => {
          squatter.closeAllConnections?.();
          r();
        });
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
