/**
 * DF-2026-21 Regression Tests: the legacy GET /api/search 301 alias must
 * preserve the documented search query parameters.
 *
 * Root cause (dogfood run 2026-11-08): the redirect forwarded only `q` via
 * raw string concatenation — a request carrying
 * `contains=real%20user&namespace=dogfood-realuse` came back as
 * `Location: /api/memories?q=`, silently dropping both inputs. A value with
 * a reserved character (&, =, #, space) additionally corrupted the
 * Location itself, and could smuggle parameters into the target.
 *
 * Against a hermetic scratch daemon (unique port, temp data dir +
 * namespaces path, degraded offline embedding provider, auth=none like the
 * existing legacy-redirect legs in http-e2e.int.test.ts), this file proves:
 *   1. every documented search query name (q, contains, namespace, limit,
 *      allNamespaces) survives the redirect, percent-encoded — the test
 *      PRINTS the preserved values;
 *   2. a value carrying reserved characters round-trips exactly and
 *      following the redirect answers 200 (no parameter smuggling);
 *   3. following a namespace+contains redirect answers HTTP 200 with the
 *      written memory;
 *   4. limit and allNamespaces survive a followed redirect (the target
 *      echoes the forwarded limit and unions namespaces);
 *   5. the bare legacy request keeps the historical /api/memories?q=
 *      shape, so existing clients do not break.
 *
 * Teardown kills ONLY this suite's child pid (stopProcess). No production
 * namespace; no network beyond 127.0.0.1.
 *
 * ch:trace row=DF-2026-21 spec=.coding-hermes/board/tasks.jsonl#DF-2026-21 wave=none:serial test=tests/http-legacy-search-redirect-df202621.int.test.ts doc=docs/api/http-api.md#legacy-api-redirects prompt=/home/kara/.hermes/cache/scratch/duckbrain-foreman-2026-11-09-06-11-07/DF-2026-21-brief.txt evidence=tests/http-legacy-search-redirect-df202621.int.test.ts witness=none:ephemeral-scratch-daemon-captured-in-test-output verdict=none:foreman-runs-gitreins commit=none:worker-commit memory=none:foreman-closeout
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  startDuckbrainHttp,
  stopProcess,
  waitForUrl,
  getRandomPort,
  curl,
  DAEMON_READY_TIMEOUT_MS,
} from "../../../tests/helpers";

const port = getRandomPort();
let server: ChildProcess;
let scratchDir: string;

const NS = "legacy-df-redirect";
const KEY_NS = "/df2026-21/legacy-redirect";
const CONTENT_NS = "DF2026-21 legacy redirect marker alpha";
const KEY_ALL = "/df2026-21/all-namespaces";
const CONTENT_ALL = "DF2026-21 crossns marker beta";

/** Extract the `location:` header value from a raw curl header dump. */
function parseLocation(headers: string): string {
  const match = headers.match(/^location:\s*(\S+)/im);
  expect(match, `no Location header in:\n${headers}`).toBeTruthy();
  return match![1];
}

/** Parse a redirect target's query string the way the daemon will. */
function parseTargetQuery(location: string): URLSearchParams {
  const url = new URL(location, `http://127.0.0.1:${port}`);
  expect(url.pathname).toBe("/api/memories");
  return url.searchParams;
}

async function writeMemory(payload: Record<string, unknown>): Promise<void> {
  const res = await curl(
    `-X POST -H 'Content-Type: application/json' ` +
      `-d '${JSON.stringify(payload)}' ` +
      `http://127.0.0.1:${port}/api/memories`,
  );
  expect(
    [200, 201].includes(res.status),
    `write failed (${res.status}): ${res.body}`,
  ).toBe(true);
}

describe("DF-2026-21: legacy /api/search redirect preserves search queries", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-legacy-search-df-"),
    );
    fs.mkdirSync(path.join(scratchDir, "namespaces", "default"), {
      recursive: true,
    });
    server = await startDuckbrainHttp({
      port,
      // Unauthenticated surface, same opt-out as the http-e2e legacy legs.
      authType: "none",
      env: {
        DUCKBRAIN_DATA_DIR: scratchDir,
        DUCKBRAIN_NAMESPACES_PATH: path.join(scratchDir, "namespaces"),
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
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("redirect preserves every documented search parameter (prints preserved values)", async () => {
    const res = await curl(
      `'http://127.0.0.1:${port}/api/search?q=semantic%20term&contains=marker&namespace=${NS}&limit=25&allNamespaces=true'`,
    );
    expect(res.status).toBe(301);
    const location = parseLocation(res.headers);
    const params = parseTargetQuery(location);

    const preserved = {
      q: params.get("q"),
      contains: params.get("contains"),
      namespace: params.get("namespace"),
      limit: params.get("limit"),
      allNamespaces: params.get("allNamespaces"),
    };
    // THE PRINT the row asks for: the preserved values, by name.
    console.log(
      `PRESERVED q=${preserved.q} contains=${preserved.contains} ` +
        `namespace=${preserved.namespace} limit=${preserved.limit} ` +
        `allNamespaces=${preserved.allNamespaces}`,
    );
    console.log(`LOCATION ${location}`);

    expect(preserved.q).toBe("semantic term");
    expect(preserved.contains).toBe("marker");
    expect(preserved.namespace).toBe(NS);
    expect(preserved.limit).toBe("25");
    expect(preserved.allNamespaces).toBe("true");
    // Exactly the forwarded names — no split/spurious parameter may appear.
    expect([...params.keys()].sort()).toEqual([
      "allNamespaces",
      "contains",
      "limit",
      "namespace",
      "q",
    ]);
  });

  it("reserved characters in a value survive encoded and the followed redirect answers 200", async () => {
    // Value decodes to `real user & co=x` — the & and = MUST stay inside the
    // contains value. If they split, `co` reaches GET /api/memories as an
    // unknown parameter and the DF-0926-02 guard answers 400.
    const res = await curl(
      `'http://127.0.0.1:${port}/api/search?contains=real%20user%20%26%20co%3Dx'`,
    );
    expect(res.status).toBe(301);
    const location = parseLocation(res.headers);
    expect(location).toContain("contains=real%20user%20%26%20co%3Dx");
    const params = parseTargetQuery(location);
    expect(params.get("contains")).toBe("real user & co=x");
    expect([...params.keys()].sort()).toEqual(["contains", "q"]);

    const followed = await curl(
      `'http://127.0.0.1:${port}${location}'`,
    );
    console.log(
      `FOLLOWED (encoded value) HTTP ${followed.status} — contains decoded intact`,
    );
    expect(followed.status).toBe(200);
    const body = JSON.parse(followed.body);
    expect(body.code).toBeUndefined();
  });

  it("following a namespace+contains redirect prints the memory with HTTP 200", async () => {
    await writeMemory({
      key: KEY_NS,
      domain: "raw_note",
      content: CONTENT_NS,
      namespace: NS,
    });

    const res = await curl(
      `'http://127.0.0.1:${port}/api/search?namespace=${NS}&contains=alpha'`,
    );
    expect(res.status).toBe(301);
    const location = parseLocation(res.headers);
    const params = parseTargetQuery(location);
    expect(params.get("namespace")).toBe(NS);
    expect(params.get("contains")).toBe("alpha");
    console.log(`PRESERVED namespace=${NS} contains=alpha`);

    const followed = await curl(`'http://127.0.0.1:${port}${location}'`);
    console.log(`FOLLOWED namespace+contains redirect → HTTP ${followed.status}`);
    expect(followed.status).toBe(200);
    const body = JSON.parse(followed.body);
    expect(body.total).toBeGreaterThanOrEqual(1);
    const hit = body.items.find((item: any) => item.key === KEY_NS);
    expect(hit, `expected ${KEY_NS} in ${JSON.stringify(body.items)}`).toBeTruthy();
    expect(hit.content).toBe(CONTENT_NS);
    console.log(`WRITTEN MEMORY key=${hit.key} content=${hit.content}`);
  });

  it("limit and allNamespaces survive a followed redirect", async () => {
    await writeMemory({
      key: KEY_ALL,
      domain: "raw_note",
      content: CONTENT_ALL,
      namespace: NS,
    });

    // The allNamespaces union deliberately does NOT auto-build missing FTS
    // sidecars (src/search/query.ts RETR-007 contract: index-less namespaces
    // are skipped and reported). One single-namespace contains search warms
    // NS's index via the read-path auto-build so the union can see the row.
    await curl(
      `'http://127.0.0.1:${port}/api/memories?namespace=${NS}&contains=crossns'`,
    );

    const res = await curl(
      `'http://127.0.0.1:${port}/api/search?contains=crossns&limit=1&allNamespaces=true'`,
    );
    expect(res.status).toBe(301);
    const location = parseLocation(res.headers);
    const params = parseTargetQuery(location);
    expect(params.get("contains")).toBe("crossns");
    expect(params.get("limit")).toBe("1");
    expect(params.get("allNamespaces")).toBe("true");

    const followed = await curl(`'http://127.0.0.1:${port}${location}'`);
    expect(followed.status).toBe(200);
    const body = JSON.parse(followed.body);
    // The forwarded limit is honored by the target route, and the union
    // search still reaches the memory.
    expect(body.limit).toBe(1);
    expect(
      body.items.some((item: any) => item.key === KEY_ALL),
      `expected ${KEY_ALL} in ${JSON.stringify(body.items)}`,
    ).toBe(true);
    console.log(
      `FOLLOWED allNamespaces+limit redirect → HTTP ${followed.status}, limit=${body.limit}`,
    );
  });

  it("bare legacy request keeps the historical /api/memories?q= shape", async () => {
    const res = await curl(`'http://127.0.0.1:${port}/api/search'`);
    expect(res.status).toBe(301);
    const location = parseLocation(res.headers);
    expect(location).toBe("/api/memories?q=");
  });
});
