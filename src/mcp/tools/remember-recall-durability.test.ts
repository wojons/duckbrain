/**
 * SYNC-2026-09-28-001 — the durability contract: a 201 write is re-readable.
 *
 * Pins the read-after-write guarantee the fleet depends on: after a write is
 * acknowledged (rememberTool success == HTTP 201), an immediate recall at the
 * writer's limit must surface the just-written entry. Covers the
 * accumulator-append case explicitly — a key that already holds prior entries
 * and receives one more append must still show the newest entry at a limit
 * SMALLER than the entry count (newest-first ordering, not oldest-first).
 *
 * This is the end-to-end complement to the dedup-window unit test
 * (queries-dedup-mixed-timestamp.test.ts): that one proves the "latest wins"
 * pick is temporal, this one proves the whole write→recall path keeps the
 * newest entry visible through the serializer flush + manifest update.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { rememberTool } from "./remember";
import { recallTool } from "./recall";
import { resetSerializerStateForTests } from "../../serialization/namespaceWriter";
import { drainAsyncCommits } from "../../git/autocommit";

const NS = "sync-durability-repro";
const ACC = "/project/consensus/commits";

describe("SYNC-2026-09-28-001: write (201) -> immediate recall -> visible", () => {
  let root: string;
  let oldNs: string | undefined;
  let oldCfg: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-sync-dur-"));
    oldNs = process.env.DUCKBRAIN_NAMESPACES_PATH;
    oldCfg = process.env.DUCKBRAIN_CONFIG_PATH;
    process.env.DUCKBRAIN_NAMESPACES_PATH = root;
    process.env.DUCKBRAIN_CONFIG_PATH = path.join(
      root,
      "duckbrain.config.json",
    );
    resetSerializerStateForTests();
  });

  afterEach(async () => {
    resetSerializerStateForTests();
    await drainAsyncCommits();
    if (oldNs === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    else process.env.DUCKBRAIN_NAMESPACES_PATH = oldNs;
    if (oldCfg === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
    else process.env.DUCKBRAIN_CONFIG_PATH = oldCfg;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function write(key: string, text: string, domain = "event") {
    const r = await rememberTool({
      key,
      domain: domain as "event",
      attributes: {},
      embedding_text: text,
      namespace: NS,
    });
    expect(r.success).toBe(true);
    return r;
  }

  it("an appended accumulator entry is visible at a limit smaller than the entry count", async () => {
    // Prior entries (the accumulator already has history).
    for (let i = 1; i <= 12; i++) {
      await write(ACC, `prior entry ${i}`);
    }

    // The fresh append — this is the 201 that must be re-readable.
    const ack = await write(ACC, "NEWEST entry");

    // Immediate recall at a limit SMALLER than the 13 entries now on the key.
    const result = await recallTool({ key: ACC, limit: 10, namespace: NS });
    expect(result.error).toBeUndefined();

    const ids = result.memories.map((m) => m.id);
    // The just-written entry must be in the returned page (newest-first).
    expect(ids).toContain(ack.id);
    // And it must be the FIRST (newest) entry, not pushed past the window.
    expect(result.memories[0].id).toBe(ack.id);
    // The dedup did not collapse prior distinct-id appends into fewer rows:
    // the page is exactly the requested limit and the total reflects all 13.
    expect(result.memories).toHaveLength(10);
    expect(result.total).toBe(13);
  });

  it("the one write that verifies alongside three sibling keys: 4 writes, all re-readable", async () => {
    // Mirror the reported incident shape: an accumulator key with prior
    // entries, a status key with prior entries, and two event keys.
    for (let i = 1; i <= 3; i++) await write(ACC, `commits prior ${i}`);
    for (let i = 1; i <= 3; i++)
      await write("/project/consensus/status", `status prior ${i}`);

    const commitsAck = await write(ACC, "commits NEWEST");
    const statusAck = await write("/project/consensus/status", "status NEWEST");
    const qaAck = await write(
      "/project/consensus/event/2026-09-27-28-qa-wave",
      "qa wave",
    );
    const relengAck = await write(
      "/project/consensus/event/2026-09-28-releng-sweep",
      "releng sweep",
    );

    for (const [key, id] of [
      [ACC, commitsAck.id],
      ["/project/consensus/status", statusAck.id],
      ["/project/consensus/event/2026-09-27-28-qa-wave", qaAck.id],
      ["/project/consensus/event/2026-09-28-releng-sweep", relengAck.id],
    ] as const) {
      const result = await recallTool({ key, limit: 10, namespace: NS });
      expect(result.error, `recall error for ${key}`).toBeUndefined();
      expect(
        result.memories.map((m) => m.id),
        `recall must surface the just-written entry for ${key}`,
      ).toContain(id);
    }
  });
});
