/**
 * REST-PK-UNIQUENESS-001 AC2 — durable Idempotency-Key bindings for table
 * writes.
 *
 * A client that retries an insert (timeout, reconnect, at-least-once queue)
 * must not append twice. When a write carries an `Idempotency-Key` header,
 * the FIRST result is bound to (namespace, scope, key) and an identical
 * replay returns that stored result instead of executing again; the same key
 * with a DIFFERENT body is a 409 `IDEMPOTENCY_CONFLICT`.
 *
 * Storage mirrors the session-activity receipt ledger
 * (src/receipts/sessionActivityReceipt.ts): one append-only JSONL ledger per
 * namespace, 0o600, module-level per-root state with a lazily-loaded index,
 * a serialized append tail so concurrent writes never interleave, and a
 * resetXForTests() seam that simulates a daemon restart. The ledger lives at
 * the namespaces ROOT (not inside the namespace dir) so it stays out of the
 * per-namespace data/git surfaces, exactly like `.duckbrain-receipts`.
 *
 * Durability: each binding is appended with a real fsync BEFORE the HTTP ack
 * is written, so a daemon restart (or crash between write and response)
 * keeps honouring the key.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

import { canonicalStringify } from "../receipts/sessionActivityReceipt";
import { resolveNamespacesPath } from "../config";

/** Hidden dir at the namespaces root holding one ledger per namespace. */
export const IDEMPOTENCY_DIR = ".duckbrain-table-idempotency";

/** Ledger filename, one per namespace: <dir>/<ns>.jsonl. */
export const IDEMPOTENCY_LEDGER = "bindings.jsonl";

/** One stored binding: the first result of a keyed write. */
export interface IdempotencyBinding {
  /** Route scope ("insert:<table>" or "transaction"). */
  scope: string;
  /** The Idempotency-Key header exactly as sent. */
  key: string;
  /** sha256 of the canonicalized request body — replay-equality check. */
  body_hash: string;
  /** HTTP status of the stored first result. */
  status: number;
  /** JSON response body of the stored first result. */
  body: unknown;
  recorded_at: string;
}

interface StoreState {
  loaded: boolean;
  /** `${scope}\n${key}` → stored first result. */
  index: Map<string, IdempotencyBinding>;
}

/**
 * Module-level per-namespace-dir state, mirroring the receipt store: the
 * index is loaded lazily from disk exactly once per root per process and
 * every append goes through ONE serialized promise chain.
 */
const storeStates = new Map<string, StoreState>();
let appendTail: Promise<void> = Promise.resolve();

function stateFor(root: string): StoreState {
  let state = storeStates.get(root);
  if (!state) {
    state = { loaded: false, index: new Map() };
    storeStates.set(root, state);
  }
  return state;
}

/** Test seam: drop the cached bindings (simulates a daemon restart). */
export function resetTableIdempotencyStoresForTests(): void {
  storeStates.clear();
}

function ledgerPath(ns: string): string {
  return path.join(resolveNamespacesPath(), IDEMPOTENCY_DIR, `${ns}.jsonl`);
}

function indexKey(scope: string, key: string): string {
  return `${scope}\n${key}`;
}

/** Canonical hash of a request body — the replay-equality token. */
export function idempotencyBodyHash(body: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalStringify(body), "utf-8")
    .digest("hex");
}

/** Load the index from disk once per namespace dir per process. */
function loadState(ns: string): StoreState {
  const root = path.dirname(ledgerPath(ns));
  const state = stateFor(root);
  if (state.loaded) return state;
  let text = "";
  try {
    text = fs.readFileSync(ledgerPath(ns), "utf-8");
  } catch {
    // First use for this namespace: an empty ledger.
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: IdempotencyBinding;
    try {
      row = JSON.parse(line) as IdempotencyBinding;
    } catch {
      continue; // torn tail line: append ledgers tolerate a partial write
    }
    if (typeof row?.scope === "string" && typeof row?.key === "string") {
      state.index.set(indexKey(row.scope, row.key), row);
    }
  }
  state.loaded = true;
  return state;
}

/** The stored first result for (ns, scope, key), or null. */
export function lookupIdempotentResult(
  ns: string,
  scope: string,
  key: string,
): IdempotencyBinding | null {
  const state = loadState(ns);
  return state.index.get(indexKey(scope, key)) ?? null;
}

/**
 * Durable-record the FIRST result of a keyed write. fsync-before-ack: the
 * caller awaits this before writing its HTTP response. First-writer-wins:
 * a concurrent duplicate response is discarded so the replayed answer is
 * always the first one the server produced.
 */
export async function recordIdempotentResult(
  ns: string,
  scope: string,
  key: string,
  bodyHash: string,
  status: number,
  body: unknown,
): Promise<void> {
  const run = async (): Promise<void> => {
    const state = loadState(ns);
    const k = indexKey(scope, key);
    if (state.index.has(k)) return;
    const row: IdempotencyBinding = {
      scope,
      key,
      body_hash: bodyHash,
      status,
      body,
      recorded_at: new Date().toISOString(),
    };
    const file = ledgerPath(ns);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    state.index.set(k, row);
  };
  const tail = appendTail.then(run, run);
  appendTail = tail.then(
    () => undefined,
    () => undefined,
  );
  await tail;
}
