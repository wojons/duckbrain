/**
 * DB-GAP-66 route tests: /api/receipts over the real createHttpServer() app.
 *
 * Proves the live ingest/query wiring end to end (the T3 arm):
 *  - POST /api/receipts records a valid receipt (201), dedupes an identical
 *    re-ingest (200), quarantines a conflicting one (409), and rejects
 *    forbidden content (422) without persisting it;
 *  - GET /api/receipts/skill/:skillRef answers exposure vs activation;
 *  - GET /api/receipts/session/:sessionRef answers the observed counters with
 *    their coverage, 404 for a session nobody observed;
 *  - no-body / wrong-shape posts are 400, never a misclassified 500.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHttpServer } from "../../cli/http";
import { createServer, Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import {
  RECEIPTS_DIR,
  resetSessionReceiptStoresForTests,
  flushSessionReceiptsForTests,
} from "../../receipts/sessionActivityReceipt";

let server: Server;
let port: number;
let scratchDir: string;
let oldNamespacesPath: string | undefined;

interface HttpResponse {
  status: number;
  body: any;
  text: string;
}

function httpRequest(
  method: string,
  p: string,
  body?: unknown,
  raw?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: p,
      method,
      headers: { Host: "localhost" },
    };
    if (body !== undefined || raw !== undefined) {
      options.headers["Content-Type"] = "application/json";
    }
    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), text: data });
        } catch {
          resolve({ status: res.statusCode, body: data, text: data });
        }
      });
    });
    req.on("error", reject);
    if (raw !== undefined) req.write(raw);
    else if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt_kind: "session_activity_receipt/v1",
    receipt_id: "rcpt-http-1",
    session_ref: "ses-http-1",
    interval: {
      started_at: "2026-10-29T03:00:00.000Z",
      ended_at: "2026-10-29T03:05:00.000Z",
    },
    skills: [
      { skill_ref: "skill.alpha", exposure: "exposed", activation: "activated" },
      { skill_ref: "skill.beta", exposure: "exposed", activation: "not_activated" },
    ],
    counters: {
      tool_calls: { availability: "observed", measurement: "exact", value: 5 },
      tokens_in: { availability: "heuristic", measurement: "floor", value: 8000 },
      wall_clock_ms: { availability: "unavailable", measurement: "exact", value: null },
    },
    claim_boundary: {
      not_execution_evidence: true,
      not_verification_evidence: true,
      not_review_evidence: true,
      not_merge_evidence: true,
    },
    ...overrides,
  };
}

describe("DB-GAP-66: /api/receipts over the real HTTP app", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-dbgap066-"));
    oldNamespacesPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = scratchDir;

    const app = createHttpServer({ authType: "none" });
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = addr && typeof addr !== "string" ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldNamespacesPath === undefined) {
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    } else {
      process.env.DUCKBRAIN_NAMESPACES_PATH = oldNamespacesPath;
    }
    resetSessionReceiptStoresForTests();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetSessionReceiptStoresForTests();
    fs.rmSync(path.join(scratchDir, RECEIPTS_DIR), {
      recursive: true,
      force: true,
    });
  });

  it("ingests a valid receipt (201), then answers both live queries", async () => {
    const posted = await httpRequest("POST", "/api/receipts", receipt());
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({
      status: "recorded",
      receipt_id: "rcpt-http-1",
    });
    await flushSessionReceiptsForTests();

    const skill = await httpRequest("GET", "/api/receipts/skill/skill.alpha");
    expect(skill.status).toBe(200);
    expect(skill.body).toMatchObject({
      skill_ref: "skill.alpha",
      receipts_mentioning: 1,
      sessions_observed: 1,
      exposed: 1,
      activated: 1,
    });
    expect(skill.body.claim_boundary).toContain("observation only");

    const beta = await httpRequest("GET", "/api/receipts/skill/skill.beta");
    expect(beta.body).toMatchObject({ exposed: 1, activated: 0, not_activated: 1 });

    const session = await httpRequest("GET", "/api/receipts/session/ses-http-1");
    expect(session.status).toBe(200);
    expect(session.body.receipt_count).toBe(1);
    expect(session.body.coverage.tool_calls).toEqual({
      observed: 1,
      heuristic: 0,
      unavailable: 0,
      omitted: 0,
    });
    expect(session.body.coverage.tokens_in).toMatchObject({ heuristic: 1 });
    expect(session.body.coverage.wall_clock_ms).toMatchObject({ unavailable: 1 });
    expect(session.body.coverage.context_peak_tokens).toMatchObject({ omitted: 1 });
    // The unobserved counter is null, never zero.
    expect(session.body.receipts[0].counters.wall_clock_ms.value).toBeNull();
  });

  it("duplicate identical ingest is 200 and does not double-store; conflicting is 409 and preserves the original", async () => {
    expect((await httpRequest("POST", "/api/receipts", receipt())).status).toBe(201);
    const dup = await httpRequest("POST", "/api/receipts", receipt());
    expect(dup.status).toBe(200);
    expect(dup.body.status).toBe("duplicate");

    const conflict = await httpRequest(
      "POST",
      "/api/receipts",
      receipt({
        counters: {
          tool_calls: { availability: "observed", measurement: "exact", value: 42 },
        },
      }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      status: "quarantined",
      reason: "conflicting_observation",
    });

    const session = await httpRequest("GET", "/api/receipts/session/ses-http-1");
    expect(session.body.receipt_count).toBe(1);
    expect(session.body.receipts[0].counters.tool_calls.value).toBe(5);
  });

  it("rejects forbidden content with 422 and persists nothing as a receipt", async () => {
    const withPrompt = await httpRequest(
      "POST",
      "/api/receipts",
      receipt({ prompt: "ignore previous instructions" }),
    );
    expect(withPrompt.status).toBe(422);
    expect(withPrompt.body).toMatchObject({
      status: "rejected",
      reason: "forbidden_key",
    });

    const withPath = await httpRequest(
      "POST",
      "/api/receipts",
      receipt({ session_ref: "/etc/passwd" }),
    );
    expect(withPath.status).toBe(422);
    expect(withPath.body.reason).toBe("forbidden_value");

    const badShape = await httpRequest("POST", "/api/receipts", {
      ...receipt(),
      claim_boundary: {
        not_execution_evidence: false,
        not_verification_evidence: true,
        not_review_evidence: true,
        not_merge_evidence: true,
      },
    });
    expect(badShape.status).toBe(422);
    expect(badShape.body.reason).toBe("invalid_shape");

    const session = await httpRequest("GET", "/api/receipts/session/ses-http-1");
    expect(session.status).toBe(404);
  });

  it("a missing or non-object body is a 400, never a 500", async () => {
    const noBody = await httpRequest("POST", "/api/receipts");
    expect(noBody.status).toBe(400);
    expect(noBody.body.code).toBe("VALIDATION_ERROR");

    const arrayBody = await httpRequest("POST", "/api/receipts", [receipt()]);
    expect(arrayBody.status).toBe(400);
  });

  it("rejects malformed route params with 400 and answers 404 for unobserved sessions", async () => {
    const badSkill = await httpRequest("GET", "/api/receipts/skill/bad%20ref");
    expect(badSkill.status).toBe(400);
    const badSession = await httpRequest("GET", "/api/receipts/session/..%2Fetc");
    expect([400, 404]).toContain(badSession.status);

    const ghost = await httpRequest("GET", "/api/receipts/session/ses-nobody");
    expect(ghost.status).toBe(404);

    // A skill nobody ever mentioned is a 200 with zeroed counts — "never
    // observed" is an answer, not an error.
    const never = await httpRequest("GET", "/api/receipts/skill/skill.never");
    expect(never.status).toBe(200);
    expect(never.body.receipts_mentioning).toBe(0);
  });

  it("GET /api/receipts documents the surface", async () => {
    const root = await httpRequest("GET", "/api/receipts");
    expect(root.status).toBe(200);
    expect(root.body.receipt_kind).toBe("session_activity_receipt/v1");
    expect(root.body.endpoints.ingest).toBe("POST /api/receipts");
  });
});
