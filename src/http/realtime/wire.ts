/**
 * DB-SUPA-5 wire contract: the versioned change event, control events, and the
 * SSE frame builders.
 *
 * Version 1 is SSE only. There is no WebSocket route, dependency, or dual
 * protocol: the stated requirements are server-to-client ordered
 * notifications plus resumable replay, both served by SSE with ordinary HTTP
 * auth, proxy behaviour, and `Last-Event-ID` support.
 */

import type { ChangeOperation } from "../../serialization/changeRecord";

/** Committed position of a change: the namespace commit plus its derived ordinal. */
export interface ChangePosition {
  /** 40-hex SHA of the namespace commit that published this change. */
  commit: string;
  /**
   * One-based index of this accepted change record among the records newly
   * added by that commit, in canonical audit-ledger segment+line order.
   */
  ordinal: number;
}

/**
 * `duckbrain.change.v1` data payload. Every required field is always present;
 * unknown fields must be ignored by v1 consumers.
 */
export interface ChangeEventV1 {
  version: 1;
  /** Opaque restart-safe cursor; also sent as the SSE `id`. */
  cursor: string;
  namespace: string;
  table: string;
  op: ChangeOperation;
  /** Post-operation row image (insert/update) or the appended tombstone (delete). */
  row: unknown;
  position: ChangePosition;
  /** ISO-8601 time the containing namespace commit was created. */
  committedAt: string;
  /** True only for `delete`. A delete is never `row: null`. */
  tombstone: boolean;
  /** Declared table schema version (`1` for the `memories` compatibility entry). */
  schemaVersion: number;
  /** Every declared key column and value. */
  key: Record<string, unknown>;
}

export const CHANGE_EVENT_NAME = "duckbrain.change.v1";
export const READY_EVENT_NAME = "duckbrain.ready.v1";
export const OVERFLOW_EVENT_NAME = "duckbrain.overflow.v1";
export const REVOKED_EVENT_NAME = "duckbrain.revoked.v1";

/** Required v1 change-event field names (schema conformance checks). */
export const CHANGE_EVENT_REQUIRED_FIELDS = [
  "version",
  "cursor",
  "namespace",
  "table",
  "op",
  "row",
  "position",
  "committedAt",
  "tombstone",
  "schemaVersion",
  "key",
] as const;

export interface ReadyEventV1 {
  version: 1;
  namespace: string;
  /** Latest committed cursor, or null when the namespace has no committed change. */
  head: string | null;
}

/** `data: <JSON>` on a single line; `id:` carries the cursor (never on control events). */
export function changeFrame(event: ChangeEventV1): string {
  return (
    `event: ${CHANGE_EVENT_NAME}\n` +
    `id: ${event.cursor}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  );
}

export function readyFrame(namespace: string, head: string | null): string {
  const payload: ReadyEventV1 = { version: 1, namespace, head };
  return `event: ${READY_EVENT_NAME}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function overflowFrame(
  namespace: string,
  cursor: string | null,
): string {
  return (
    `event: ${OVERFLOW_EVENT_NAME}\n` +
    `data: ${JSON.stringify({ version: 1, namespace, cursor })}\n\n`
  );
}

export function revokedFrame(namespace: string): string {
  return (
    `event: ${REVOKED_EVENT_NAME}\n` +
    `data: ${JSON.stringify({ version: 1, namespace })}\n\n`
  );
}

/** Comment heartbeat — keeps proxies from idling the connection out. */
export const HEARTBEAT_FRAME = ": heartbeat\n\n";
