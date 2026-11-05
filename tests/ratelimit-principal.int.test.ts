/**
 * HARDEN-DUCKBRAIN-003 (B) — one local caller must not be able to starve
 * another.
 *
 * The live failure: the daemon on :3000 runs a token bucket keyed on the peer
 * IP, and EVERY caller on this host (fleet agents, cron, MCP servers,
 * supervisors, probes) shares 127.0.0.1 — so one agent's burst throttled
 * everybody else, starting with /health (which flipped the Hermes memory
 * provider to "unavailable"), then ordinary reads.
 *
 * The fix keys the bucket on the PRINCIPAL when the credential store knows the
 * presented API key, and on the peer IP for everyone else. Two properties are
 * pinned here, and both matter:
 *
 *   1. ISOLATION — caller A can drain its own budget dry while caller B, on the
 *      same address, still reads. On the pre-fix daemon this test fails: B's
 *      request lands in A's bucket and comes back 429.
 *   2. NO FREE BUCKETS — an UNRECOGNIZED key does NOT get a bucket of its own.
 *      If it did, the limiter would stop bounding credential stuffing (each
 *      guess would arrive with a fresh budget); instead those requests share
 *      the peer-IP bucket and are refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getRandomPort,
  startDuckbrainHttp,
  stopProcess,
  waitForUrl,
  curl,
  DAEMON_READY_TIMEOUT_MS,
} from "./helpers";
import { removeTempDirSafely } from "../src/testing/race-safe-daemon";

const port = getRandomPort();
const RATE_LIMIT = 5;
const KEY_A = "harden003-caller-a-0123456789abcdef";
const KEY_B = "harden003-caller-b-0123456789abcdef";

let server: ChildProcess;
let scratchDir: string;

/** A read that answers 200 for a principal with an unrestricted key. */
const READ_URL = () =>
  `http://127.0.0.1:${port}/api/memories?namespace=default&limit=1`;

const read = (key?: string) =>
  curl(`-H "x-api-key: ${key}" "${READ_URL()}"`);

describe("HARDEN-DUCKBRAIN-003 (B) per-principal rate limiting", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-ratelimit-principal-"),
    );
    const authDir = path.join(scratchDir, "home", ".duckbrain");
    const namespacesPath = path.join(scratchDir, "namespaces");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(path.join(namespacesPath, "default"), { recursive: true });
    const authFile = path.join(authDir, "auth.json");
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        users: [],
        apiKeys: [
          { key: KEY_A, name: "caller-a", roles: ["writer"] },
          { key: KEY_B, name: "caller-b", roles: ["writer"] },
        ],
      }),
      "utf-8",
    );

    server = await startDuckbrainHttp({
      port,
      authType: "apikey",
      authFile,
      rateLimit: RATE_LIMIT,
      env: {
        HOME: path.join(scratchDir, "home"),
        DUCKBRAIN_DATA_DIR: scratchDir,
        DUCKBRAIN_NAMESPACES_PATH: namespacesPath,
      },
    });
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      DAEMON_READY_TIMEOUT_MS,
      server,
    );
  }, 120000);

  afterAll(async () => {
    await stopProcess(server);
    await removeTempDirSafely(scratchDir);
  });

  it("drains caller A's budget while caller B, on the same address, still reads", async () => {
    // A sanity read first: the route answers 200 for a known key before the drain.
    const before = await read(KEY_B);
    expect(before.status).toBe(200);

    // Caller A: 200 requests, as the row asks. It shares 127.0.0.1 with B.
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) {
      const res = await read(KEY_A);
      statuses.push(res.status);
      if (statuses.filter((s) => s === 429).length >= 3) break;
    }
    expect(statuses).toContain(200);
    expect(statuses).toContain(429);

    // B, same peer IP, is untouched by A's exhaustion.
    const b = await read(KEY_B);
    expect(b.status).toBe(200);
    expect(b.headers).toMatch(/HTTP\/\S+\s+200/);

    // ... and A stays refused: the limit was enforced, not disabled.
    const aAgain = await read(KEY_A);
    expect(aAgain.status).toBe(429);
    expect(aAgain.headers).toMatch(/Retry-After:/i);
  });

  it("does not mint a bucket for an unrecognized key (credential stuffing stays bounded)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMIT * 3; i++) {
      // A different, NONEXISTENT key per attempt: if each one got its own
      // bucket, none of these could ever be refused.
      const guess = `guess-${i}-`.padEnd(40, "x");
      const res = await read(guess);
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    // The refusals are the LIMITER's, not auth's: every non-429 answer is a 401.
    expect(statuses.filter((s) => s === 200)).toHaveLength(0);
  });
});
