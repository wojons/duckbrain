/**
 * SDK-PARITY-001: the ONE error type the client raises.
 *
 * The server answers refusals as `{error, code, fields}` (src/http/middleware/
 * errorHandler.ts). A client that re-worded those would hide exactly the
 * information a caller needs — `table_grant`, `VALIDATION_ERROR`, `policy`,
 * `INVALID_JSON` — so `reason` and `code` here are the server's strings,
 * unmodified, and the message puts the server's reason at the end of it.
 */
export interface DuckBrainApiErrorInit {
  operationId: string;
  method: string;
  url: string;
  status: number;
  /** The server's `error` string, verbatim (absent when the body had none). */
  reason: string;
  /** The server's `code` string, verbatim (absent when the body had none). */
  code?: string;
  /** VALIDATION_ERROR field map, verbatim. */
  fields?: Record<string, string>;
  /** The parsed body (or the raw text when it was not JSON). */
  body?: unknown;
}

export class DuckBrainApiError extends Error {
  readonly operationId: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly reason: string;
  readonly code?: string;
  readonly fields?: Record<string, string>;
  readonly body?: unknown;

  constructor(init: DuckBrainApiErrorInit) {
    super(
      `${init.method.toUpperCase()} ${init.url} → ${init.status} ${
        init.code ?? "HTTP_ERROR"
      }: ${init.reason}`,
    );
    this.name = "DuckBrainApiError";
    this.operationId = init.operationId;
    this.method = init.method;
    this.url = init.url;
    this.status = init.status;
    this.reason = init.reason;
    this.code = init.code;
    this.fields = init.fields;
    this.body = init.body;
  }
}
