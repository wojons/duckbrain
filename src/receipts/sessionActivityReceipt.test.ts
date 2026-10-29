/**
 * DB-GAP-66 unit tests: session activity receipt store
 * (session_activity_receipt/v1).
 *
 * Covers every acceptance arm of the board row:
 *  - idempotent ingestion on receipt_id (identical duplicate records once;
 *    a different observation under the same id is quarantined, original kept);
 *  - closed shape with bounded arrays and opaque refs, with prompts,
 *    transcripts, tool arguments, tool results, filesystem paths and unsafe
 *    key names rejected by key name AND by shape;
 *  - counters carry availability (observed/heuristic/unavailable) and
 *    measurement (exact/floor); an unobserved counter is omitted or
 *    unavailable+null — never zero;
 *  - the in-band claim boundary (not execution/verification/review/merge
 *    evidence) is required;
 *  - both query surfaces: skill exposure vs activation, and per-session
 *    observed counters with coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createSessionReceiptStore,
  readReceiptRows,
  readQuarantineRows,
  querySkillExposure,
  querySessionCounters,
  observationHash,
  validateReceiptPayload,
  flushSessionReceiptsForTests,
  resetSessionReceiptStoresForTests,
  RECEIPTS_DIR,
  RECEIPTS_FILE,
  QUARANTINE_FILE,
  MAX_SKILLS_PER_RECEIPT,
  type SessionActivityReceipt,
} from "./sessionActivityReceipt";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-receipts-"));
  resetSessionReceiptStoresForTests();
});

afterEach(() => {
  resetSessionReceiptStoresForTests();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const nsRoot = (): string => scratch;

function validReceipt(overrides: Partial<SessionActivityReceipt> = {}): SessionActivityReceipt {
  return {
    receipt_kind: "session_activity_receipt/v1",
    receipt_id: "rcpt-0001",
    session_ref: "ses-alpha",
    interval: {
      started_at: "2026-10-29T03:00:00.000Z",
      ended_at: "2026-10-29T03:05:00.000Z",
    },
    skills: [
      {
        skill_ref: "skill.skill-a",
        exposure: "exposed",
        activation: "activated",
      },
    ],
    counters: {
      tool_calls: { availability: "observed", measurement: "exact", value: 7 },
      tokens_in: { availability: "heuristic", measurement: "floor", value: 12000 },
      wall_clock_ms: {
        availability: "unavailable",
        measurement: "exact",
        value: null,
      },
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

describe("ingest: happy path + durability", () => {
  it("records a valid receipt into .duckbrain-receipts/receipts.jsonl with 0600 mode", async () => {
    const store = createSessionReceiptStore(nsRoot());
    const result = await store.ingest(validReceipt());
    expect(result).toMatchObject({
      status: "recorded",
      receipt_id: "rcpt-0001",
    });

    const file = path.join(scratch, RECEIPTS_DIR, RECEIPTS_FILE);
    expect(fs.existsSync(file)).toBe(true);
    // umask can only narrow; the secret-relevant group/other bits never survive.
    expect(fs.statSync(file).mode & 0o077).toBe(0);

    const { rows, skippedMalformed } = readReceiptRows(nsRoot());
    expect(skippedMalformed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].receipt.receipt_id).toBe("rcpt-0001");
    expect(rows[0].observation_hash).toBe(observationHash(validReceipt()));
  });
});

describe("ingest: idempotency on receipt_id", () => {
  it("accepts the same receipt_id with an identical observation exactly once", async () => {
    const store = createSessionReceiptStore(nsRoot());
    const first = await store.ingest(validReceipt());
    const second = await store.ingest(validReceipt());
    expect(first.status).toBe("recorded");
    expect(second.status).toBe("duplicate");

    const { rows } = readReceiptRows(nsRoot());
    expect(rows).toHaveLength(1);
    expect(readQuarantineRows(nsRoot()).rows).toHaveLength(0);
  });

  it("quarantines the same receipt_id carrying a different observation and never overwrites the original", async () => {
    const store = createSessionReceiptStore(nsRoot());
    await store.ingest(validReceipt());
    const conflicting = validReceipt();
    conflicting.counters = {
      tool_calls: { availability: "observed", measurement: "exact", value: 99 },
    };
    const result = await store.ingest(conflicting);
    expect(result).toEqual({
      status: "quarantined",
      receipt_id: "rcpt-0001",
      reason: "conflicting_observation",
    });

    // Original untouched.
    const { rows } = readReceiptRows(nsRoot());
    expect(rows).toHaveLength(1);
    expect(rows[0].receipt.counters.tool_calls).toMatchObject({ value: 7 });

    // Quarantine carries identity + reason + hash but NEVER the payload.
    const quarantine = readQuarantineRows(nsRoot());
    expect(quarantine.rows).toHaveLength(1);
    expect(quarantine.rows[0]).toMatchObject({
      receipt_id: "rcpt-0001",
      reason: "conflicting_observation",
    });
    expect(quarantine.rows[0].payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    const rawLine = fs.readFileSync(
      path.join(scratch, RECEIPTS_DIR, QUARANTINE_FILE),
      "utf-8",
    );
    expect(rawLine).not.toContain('"value":99');
    expect(rawLine).not.toContain("tool_calls");
  });

  it("still detects duplicates after a process restart (index rebuilt from disk)", async () => {
    const store = createSessionReceiptStore(nsRoot());
    await store.ingest(validReceipt());

    // Simulate a restart: drop the in-memory index, new store instance.
    resetSessionReceiptStoresForTests();
    const restarted = createSessionReceiptStore(nsRoot());
    expect((await restarted.ingest(validReceipt())).status).toBe("duplicate");
    expect(
      (await restarted.ingest(validReceipt({ receipt_id: "rcpt-0001" })))
        .status,
    ).toBe("duplicate");
    const tampered = validReceipt();
    tampered.session_ref = "ses-beta";
    expect((await restarted.ingest(tampered)).status).toBe("quarantined");
    expect(readReceiptRows(nsRoot()).rows).toHaveLength(1);
  });
});

describe("ingest: forbidden content, by key name and by shape", () => {
  it.each([
    ["prompt", { prompt: "you are a helpful assistant" }],
    ["transcript", { transcript: "user: hi\nassistant: hello" }],
    ["tool arguments", { tool_arguments: { path: "/etc/passwd" } }],
    ["tool results", { tool_results: ["file contents..."] }],
    ["content", { content: "smuggled memory content" }],
  ])("rejects a receipt carrying %s by key name", async (_label, extra) => {
    const store = createSessionReceiptStore(nsRoot());
    const result = await store.ingest({ ...validReceipt(), ...extra });
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toBe("forbidden_key");
    // Nothing was stored as a receipt; the quarantine row carries no payload.
    expect(readReceiptRows(nsRoot()).rows).toHaveLength(0);
    const q = readQuarantineRows(nsRoot());
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].reason).toBe("forbidden_key");
  });

  it("rejects a forbidden key nested inside the skills array", async () => {
    const store = createSessionReceiptStore(nsRoot());
    const receipt = validReceipt();
    (receipt.skills as unknown as object[]).push({
      skill_ref: "skill.evil",
      exposure: "exposed",
      activation: "activated",
      transcript: "whole conversation here",
    });
    const result = await store.ingest(receipt);
    expect(result).toMatchObject({
      status: "rejected",
      reason: "forbidden_key",
    });
    expect(readReceiptRows(nsRoot()).rows).toHaveLength(0);
  });

  it.each([
    // Object literals can't carry an own `__proto__` key (it sets the
    // prototype) — JSON.parse produces the real own-property shape an
    // attacker would send over the wire.
    ["__proto__", JSON.parse('{"__proto__":{"polluted":true}}')],
    ["dotted", { "evil.key": 1 }],
    ["slashed", { "a/b": 1 }],
    ["spaced", { "not a key": 1 }],
    ["capitalized", { Prompt: "case variant" }],
  ])("rejects unsafe key name %s", async (_label, extra) => {
    const store = createSessionReceiptStore(nsRoot());
    const result = await store.ingest({ ...validReceipt(), ...extra });
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toBe("unsafe_key");
    expect(readReceiptRows(nsRoot()).rows).toHaveLength(0);
  });

  it.each([
    ["absolute POSIX path", "/etc/passwd"],
    ["home-relative path", "~/secrets/id_rsa"],
    ["parent-relative path", "../outside"],
    ["Windows drive path", "C:\\Windows\\system32"],
    ["backslash separator", "some\\path"],
    ["URL with scheme", "https://example.com/transcript"],
    ["multi-line text", "line one\nline two"],
  ])("rejects a receipt whose session_ref is a %s", async (_label, value) => {
    const store = createSessionReceiptStore(nsRoot());
    const result = await store.ingest(validReceipt({ session_ref: value }));
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toBe("forbidden_value");
    expect(readReceiptRows(nsRoot()).rows).toHaveLength(0);
  });

  it("rejects unknown top-level keys by shape (closed strict object)", async () => {
    const store = createSessionReceiptStore(nsRoot());
    const result = await store.ingest({
      ...validReceipt(),
      vendor_extension: { anything: 1 },
    });
    expect(result).toMatchObject({ status: "rejected", reason: "invalid_shape" });
    expect(readReceiptRows(nsRoot()).rows).toHaveLength(0);
  });

  it("rejects a payload over the byte bound before any other work", async () => {
    const store = createSessionReceiptStore(nsRoot(), { maxReceiptBytes: 200 });
    const result = await store.ingest(validReceipt());
    expect(result).toMatchObject({ status: "rejected", reason: "oversized" });
    expect(readReceiptRows(nsRoot()).rows).toHaveLength(0);
    expect(readQuarantineRows(nsRoot()).rows[0].reason).toBe("oversized");
  });

  it("rejects a skills array past the bound", async () => {
    const store = createSessionReceiptStore(nsRoot());
    const receipt = validReceipt();
    receipt.skills = Array.from(
      { length: MAX_SKILLS_PER_RECEIPT + 1 },
      (_, i) => ({
        skill_ref: `skill.s${i}`,
        exposure: "exposed" as const,
        activation: "unknown" as const,
      }),
    );
    const result = await store.ingest(receipt);
    expect(result).toMatchObject({ status: "rejected", reason: "invalid_shape" });
  });

  it("rejects an inverted interval", async () => {
    const store = createSessionReceiptStore(nsRoot());
    const result = await store.ingest(
      validReceipt({
        interval: {
          started_at: "2026-10-29T04:00:00.000Z",
          ended_at: "2026-10-29T03:00:00.000Z",
        },
      }),
    );
    expect(result).toMatchObject({ status: "rejected", reason: "invalid_shape" });
  });
});

describe("counters: availability + measurement arms", () => {
  it("accepts observed+exact, observed+floor, heuristic+floor, unavailable+null", async () => {
    const store = createSessionReceiptStore(nsRoot());
    const receipt = validReceipt();
    receipt.counters = {
      tool_calls: { availability: "observed", measurement: "exact", value: 3 },
      tool_errors: { availability: "observed", measurement: "floor", value: 1 },
      tokens_out: { availability: "heuristic", measurement: "floor", value: 900 },
      wall_clock_ms: {
        availability: "unavailable",
        measurement: "floor",
        value: null,
      },
    };
    expect((await store.ingest(receipt)).status).toBe("recorded");
  });

  it("rejects heuristic+exact (a heuristic can never be an exact measurement)", async () => {
    const receipt = validReceipt();
    receipt.counters = {
      tokens_in: { availability: "heuristic", measurement: "exact", value: 5 } as never,
    };
    expect(validateReceiptPayload(receipt).ok).toBe(false);
  });

  it("rejects unavailable with a numeric value (unavailable means null, never a number)", async () => {
    const receipt = validReceipt();
    receipt.counters = {
      tool_calls: { availability: "unavailable", measurement: "exact", value: 0 } as never,
    };
    const validated = validateReceiptPayload(receipt);
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.reason).toBe("invalid_shape");
  });

  it("rejects observed with a null value", async () => {
    const receipt = validReceipt();
    receipt.counters = {
      tool_calls: { availability: "observed", measurement: "exact", value: null } as never,
    };
    expect(validateReceiptPayload(receipt).ok).toBe(false);
  });

  it("an omitted counter is omitted in storage — never materialized as zero", async () => {
    const store = createSessionReceiptStore(nsRoot());
    const receipt = validReceipt();
    receipt.counters = {
      tool_calls: { availability: "observed", measurement: "exact", value: 0 },
    };
    await store.ingest(receipt);
    const raw = fs.readFileSync(
      path.join(scratch, RECEIPTS_DIR, RECEIPTS_FILE),
      "utf-8",
    );
    // tool_calls was OBSERVED at zero — legitimate. Everything else stays absent.
    expect(raw).toContain('"tool_calls"');
    for (const absent of [
      "tool_errors",
      "model_calls",
      "model_errors",
      "tokens_out",
      "context_peak_tokens",
    ]) {
      expect(raw).not.toContain(`"${absent}"`);
    }
  });
});

describe("claim boundary", () => {
  it("is required — a receipt without it fails shape validation", async () => {
    const receipt = validReceipt() as unknown as Record<string, unknown>;
    delete receipt.claim_boundary;
    expect(validateReceiptPayload(receipt).ok).toBe(false);
  });

  it.each([
    "not_execution_evidence",
    "not_verification_evidence",
    "not_review_evidence",
    "not_merge_evidence",
  ])("rejects a receipt claiming to be evidence (%s: false)", async (flag) => {
    const receipt = validReceipt();
    receipt.claim_boundary = {
      ...receipt.claim_boundary,
      [flag]: false,
    } as never;
    expect(validateReceiptPayload(receipt).ok).toBe(false);
  });
});

describe("queries", () => {
  async function seed(): Promise<void> {
    const store = createSessionReceiptStore(nsRoot());
    // ses-alpha: skill-a exposed+activated, full counters
    await store.ingest(validReceipt());
    // ses-alpha again (second interval): skill-a exposed, NOT activated
    await store.ingest(
      validReceipt({
        receipt_id: "rcpt-0002",
        interval: {
          started_at: "2026-10-29T04:00:00.000Z",
          ended_at: "2026-10-29T04:05:00.000Z",
        },
        skills: [
          {
            skill_ref: "skill.skill-a",
            exposure: "exposed",
            activation: "not_activated",
          },
        ],
        counters: {},
      }),
    );
    // ses-beta: skill-a exposure unknown, activation unknown
    await store.ingest(
      validReceipt({
        receipt_id: "rcpt-0003",
        session_ref: "ses-beta",
        skills: [
          {
            skill_ref: "skill.skill-a",
            exposure: "unknown",
            activation: "unknown",
          },
        ],
        counters: {
          model_calls: {
            availability: "observed",
            measurement: "exact",
            value: 2,
          },
        },
      }),
    );
    // ses-beta: does not mention skill-a at all
    await store.ingest(
      validReceipt({
        receipt_id: "rcpt-0004",
        session_ref: "ses-beta",
        skills: [],
        counters: {},
      }),
    );
  }

  it("answers exposure vs activation for skill X, keeping unknown distinct", async () => {
    await seed();
    const report = querySkillExposure(nsRoot(), "skill.skill-a");
    expect(report).toEqual({
      skill_ref: "skill.skill-a",
      receipts_mentioning: 3,
      sessions_observed: 2,
      exposed: 2,
      not_exposed: 0,
      exposure_unknown: 1,
      activated: 1,
      not_activated: 1,
      activation_unknown: 1,
    });
  });

  it("answers zero rows for a skill nobody ever mentioned", async () => {
    await seed();
    const report = querySkillExposure(nsRoot(), "skill.never-seen");
    expect(report.receipts_mentioning).toBe(0);
    expect(report.exposed).toBe(0);
    expect(report.activated).toBe(0);
  });

  it("answers the observed counters with coverage for session Y", async () => {
    await seed();
    const report = querySessionCounters(nsRoot(), "ses-alpha");
    expect(report.receipt_count).toBe(2);
    expect(report.receipts.map((r) => r.receipt_id)).toEqual([
      "rcpt-0001",
      "rcpt-0002",
    ]);
    // rcpt-0001: tool_calls observed, tokens_in heuristic, wall_clock_ms
    // unavailable, everything else omitted. rcpt-0002: all omitted.
    expect(report.coverage.tool_calls).toEqual({
      observed: 1,
      heuristic: 0,
      unavailable: 0,
      omitted: 1,
    });
    expect(report.coverage.tokens_in).toEqual({
      observed: 0,
      heuristic: 1,
      unavailable: 0,
      omitted: 1,
    });
    expect(report.coverage.wall_clock_ms).toEqual({
      observed: 0,
      heuristic: 0,
      unavailable: 1,
      omitted: 1,
    });
    expect(report.coverage.context_peak_tokens).toEqual({
      observed: 0,
      heuristic: 0,
      unavailable: 0,
      omitted: 2,
    });
    // The unavailable counter is null in the per-receipt payload, never zero.
    expect(report.receipts[0].counters.wall_clock_ms).toEqual({
      availability: "unavailable",
      measurement: "exact",
      value: null,
    });
  });

  it("returns an empty report for a session nobody observed", async () => {
    await seed();
    const report = querySessionCounters(nsRoot(), "ses-ghost");
    expect(report.receipt_count).toBe(0);
    expect(report.receipts).toEqual([]);
  });
});

describe("ledger robustness", () => {
  it("seals segments monotonically when the bound is exceeded; every row stays queryable", async () => {
    const store = createSessionReceiptStore(nsRoot(), { maxBytes: 1200 });
    for (let i = 0; i < 8; i++) {
      const result = await store.ingest(
        validReceipt({ receipt_id: `rcpt-rot-${String(i).padStart(2, "0")}` }),
      );
      expect(result.status).toBe("recorded");
    }
    const dir = path.join(scratch, RECEIPTS_DIR);
    const names = fs.readdirSync(dir);
    expect(names.filter((n) => /^receipts\.\d{4}\.jsonl$/.test(n)).length).toBeGreaterThan(0);
    expect(names).toContain(RECEIPTS_FILE);

    const { rows, skippedMalformed } = readReceiptRows(nsRoot());
    expect(skippedMalformed).toBe(0);
    expect(rows).toHaveLength(8);
    // Duplicates are still detected across sealed segments.
    expect(
      (await store.ingest(validReceipt({ receipt_id: "rcpt-rot-03" }))).status,
    ).toBe("duplicate");
  });

  it("a torn line never breaks a query — it is counted and skipped", async () => {
    const store = createSessionReceiptStore(nsRoot());
    await store.ingest(validReceipt());
    await flushSessionReceiptsForTests();
    fs.appendFileSync(
      path.join(scratch, RECEIPTS_DIR, RECEIPTS_FILE),
      '{"stored_at": "not-json\n',
    );
    const { rows, skippedMalformed } = readReceiptRows(nsRoot());
    expect(rows).toHaveLength(1);
    expect(skippedMalformed).toBe(1);
  });
});
