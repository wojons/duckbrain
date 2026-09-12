/**
 * Dark-port health check for ONE DuckBrain HTTP daemon (OPS-001, OPS-002).
 *
 * The Restart=always unit in `ops/systemd/` covers crash-loop recovery; this
 * helper is the alert path for the remaining dark state: the unit disabled,
 * masked, or the port squatted by something else. Contract (fixed by the
 * embedding-health design, GAP-030; HUNG split out by OPS-002):
 *
 *   - HTTP 200  → ALIVE (fully healthy)
 *   - HTTP 503  → ALIVE for liveness purposes (the daemon intentionally
 *                 reports degraded when the embedding provider or keys store
 *                 is down; a degraded DuckBrain still serves MCP/REST and
 *                 must NOT page as dark)
 *   - our own timeout elapsed with no answer → HUNG (the port was reachable
 *                 but /health never completed: a stuck handler — NOT a dead
 *                 daemon. Distinct exit code so a restart-on-dark escalation
 *                 can never restart-loop a daemon that is serving traffic)
 *   - connection refused/reset, or ANY other status (e.g. a 404 from a
 *                 non-DuckBrain squatter, 401 from a misconfigured proxy) →
 *                 DARK
 *
 * /health is auth-exempt, so this check never needs or exposes API keys.
 * Pure liveness: the response body is not parsed.
 */

/** The only HTTP statuses accepted as proof the daemon is alive. */
export const ALIVE_STATUSES: ReadonlySet<number> = new Set([200, 503]);

/** Exit code for HUNG — distinct from DARK (1) so escalations can tell them apart. */
export const HUNG_EXIT_CODE = 3;

export type HealthStatus = "alive" | "dark" | "hung";

export interface HealthCheckResult {
  status: HealthStatus;
  /** HTTP status when a response arrived, null on connection failure. */
  httpStatus: number | null;
  /** Short human-readable detail for logs/alert text. */
  detail: string;
}

/**
 * Is this error our own timeout elapsing (the daemon accepted the connection
 * and never answered), as opposed to the port being unreachable?
 *
 * `AbortSignal.timeout()` rejects with a `TimeoutError` DOMException
 * ("The operation was aborted due to timeout"); a caller-supplied abort
 * surfaces as `AbortError`. Connection failures (ECONNREFUSED, ECONNRESET,
 * ENOTFOUND, ETIMEDOUT from the TCP handshake) are NOT timeouts of the
 * REQUEST — they mean unreachable, i.e. dark.
 */
export function isRequestTimeout(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return typeof error === "string" && /aborted due to timeout/i.test(error);
  }
  const e = error as {
    name?: string;
    code?: string;
    message?: string;
    cause?: unknown;
  };
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  if (/aborted due to timeout/i.test(e.message ?? "")) return true;
  // Node wraps fetch failures; a nested timeout cause counts too.
  if (e.cause && e.cause !== error) return isRequestTimeout(e.cause);
  return false;
}

/** Injectable transport seam — tests never open sockets. */
export type HealthFetcher = (
  url: string,
  timeoutMs: number,
) => Promise<{ status: number }>;

/** Production fetch: real HTTP with an abort-based timeout. */
export const httpFetcher: HealthFetcher = async (url, timeoutMs) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    // /health is auth-exempt — deliberately no credentials, no API keys.
    headers: { accept: "application/json" },
  });
  return { status: response.status };
};

/**
 * Probe `url` (normally http://127.0.0.1:<port>/health) and classify it.
 * Any error (refused, DNS, timeout, TLS) is classified — never throws.
 */
export async function checkHttpHealth(
  url: string,
  fetcher: HealthFetcher = httpFetcher,
  timeoutMs = 5_000,
): Promise<HealthCheckResult> {
  try {
    const { status } = await fetcher(url, timeoutMs);
    if (ALIVE_STATUSES.has(status)) {
      return {
        status: "alive",
        httpStatus: status,
        detail:
          status === 200
            ? "daemon alive (HTTP 200)"
            : "daemon alive (HTTP 503 — degraded is an intentional embedding-health state, not dark)",
      };
    }
    return {
      status: "dark",
      httpStatus: status,
      detail: `unexpected HTTP ${status} from ${url} — port answered but not with the DuckBrain /health contract (200 or 503); possible squatter or proxy misroute`,
    };
  } catch (error) {
    if (isRequestTimeout(error)) {
      return {
        status: "hung",
        httpStatus: null,
        detail: `reachable but /health did not answer within ${timeoutMs}ms (hung — the port accepted the connection and the handler never completed; the daemon may still be serving other routes)`,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "dark",
      httpStatus: null,
      detail: `connection failed to ${url}: ${detail}`,
    };
  }
}

export interface ParsedHealthCheckArgs {
  url: string;
  timeoutMs: number;
  json: boolean;
  help: boolean;
  error?: string;
}

/** Parse `--url=...`, `--timeout-ms=N`, `--json`, `--help`. */
export function parseHealthCheckArgs(argv: string[]): ParsedHealthCheckArgs {
  const parsed: ParsedHealthCheckArgs = {
    url: "http://127.0.0.1:3000/health",
    timeoutMs: 5_000,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const takesValue = (): string | null => {
      if (token.includes("=")) return token.slice(token.indexOf("=") + 1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        i += 1;
        return next;
      }
      return null;
    };
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--url" || token.startsWith("--url=")) {
      const raw = takesValue();
      if (raw === null || !/^https?:\/\//.test(raw)) {
        parsed.error = `invalid --url value: ${raw ?? "<missing>"} (expected http(s) URL)`;
        return parsed;
      }
      parsed.url = raw;
      continue;
    }
    if (token === "--timeout-ms" || token.startsWith("--timeout-ms=")) {
      const raw = takesValue();
      const value = raw === null ? NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(value) || value <= 0) {
        parsed.error = `invalid --timeout-ms value: ${raw ?? "<missing>"}`;
        return parsed;
      }
      parsed.timeoutMs = value;
      continue;
    }
    parsed.error = `unknown argument: ${token}`;
    return parsed;
  }
  return parsed;
}

function printUsage(): void {
  console.log(
    [
      "Usage: node scripts/health-check.js [--url=URL] [--timeout-ms=N] [--json]",
      "",
      "Report whether a DuckBrain HTTP daemon's port is ALIVE, DARK, or HUNG.",
      "ALIVE: /health answers 200 or 503 (degraded is intentional, not dark).",
      "HUNG:  reachable but /health did not answer within --timeout-ms (the",
      "       handler is stuck; the daemon may still serve other routes).",
      "DARK:  connection failure, or any other HTTP status.",
      "",
      "No API keys needed or accepted — /health is auth-exempt.",
      `Exit codes: 0 alive, 1 dark, ${HUNG_EXIT_CODE} hung, 2 usage error.`,
    ].join("\n"),
  );
}

/** CLI entry used by `scripts/health-check.js`. Returns the exit code. */
export async function runHealthCheckCli(
  argv: string[],
  fetcher: HealthFetcher = httpFetcher,
): Promise<number> {
  const parsed = parseHealthCheckArgs(argv);
  if (parsed.error) {
    console.error(`health-check: ${parsed.error}`);
    return 2;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const result = await checkHttpHealth(parsed.url, fetcher, parsed.timeoutMs);
  if (parsed.json) {
    console.log(JSON.stringify(result));
  } else {
    const line = `health-check: ${result.status.toUpperCase()} — ${result.detail}`;
    if (result.status === "alive") console.log(line);
    else console.error(line);
  }
  if (result.status === "alive") return 0;
  if (result.status === "hung") return HUNG_EXIT_CODE;
  return 1;
}
