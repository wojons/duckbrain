import type { AuthPrincipal } from "../auth/middleware";

export type WriteOperation = "insert" | "update" | "delete";

export interface WriteRequest {
  ns: string;
  table: string;
  op: WriteOperation;
  record: unknown;
  principal: AuthPrincipal | undefined;
  seq: number;
  /** Namespace-relative JSONL target. Internal until SUPA-6 declares tables. */
  targetPath?: string;
  /** Namespace-relative partition registered in manifest.json. */
  partitionPath?: string;
}

export type WriteInput = Omit<WriteRequest, "seq">;

export type SerializerErrorCode =
  | "VALIDATION_ERROR"
  | "SERIALIZER_QUEUE_FULL"
  | "SERIALIZER_LOCKED"
  | "SERIALIZER_FENCED"
  | "SERVER_SHUTTING_DOWN"
  | "FORBIDDEN"
  | "NOT_FOUND";

export type WriteResult =
  | { seq: number; ok: true }
  | {
      seq: number;
      ok: false;
      code: SerializerErrorCode | string;
      message: string;
      fields?: Record<string, string>;
      retryAfter?: number;
    };

export type FencingToken = string;
export type AuthorizationPhase = "enqueue" | "flush";

export type AuthorizationDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      message?: string;
    };

/** SUPA-4 seam. The default hook allows today's deployments unchanged. */
export type AuthorizationHook = (
  request: Readonly<WriteRequest>,
  phase: AuthorizationPhase,
) => AuthorizationDecision | Promise<AuthorizationDecision>;
