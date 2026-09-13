/**
 * CLI for the embedding provider preflight (OPS-004).
 *
 * Wraps `preflightEmbedding` (src/embedding/preflight.ts) with the argument
 * handling and exit-code contract that `scripts/embedding-preflight.js` and
 * the ops runbook depend on:
 *
 *   0  PASS       — a real embed succeeded through the configured provider
 *   1  FAIL       — FAIL CLOSED: usability was not proven (auth, timeout,
 *                   empty vector, wrong dimensions, unreachable, upstream).
 *                   This is the code a gate/alert must key on: the OPS-004
 *                   asymmetric condition ("/models is 200, /embeddings is
 *                   not") lands here.
 *   2  usage error
 *
 * SECRET SAFETY: this CLI deliberately has NO `--api-key` flag. A credential
 * on a command line is visible to every process on the box (`ps`) and lands in
 * shell history; the key is read only from the environment
 * (DUCKBRAIN_EMBEDDING_API_KEY) / the config file, exactly like the daemon.
 * The emitted report never contains the key — only `key_present`.
 */

import {
  preflightEmbedding,
  renderPreflightReport,
} from "../embedding/preflight";

/** Exit code contract (see the module docstring). */
export const PREFLIGHT_USAGE_EXIT_CODE = 2;

export interface ParsedPreflightArgs {
  provider?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  expectDims?: number;
  json: boolean;
  help: boolean;
  error?: string;
}

function positiveInt(raw: string | null, flag: string): number | string {
  const value = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    return `invalid ${flag} value: ${raw ?? "<missing>"} (expected a positive integer)`;
  }
  return value;
}

/**
 * Parse argv. Every value-taking flag accepts both `--flag=value` and
 * `--flag value` (the repo's CLI convention).
 */
export function parsePreflightArgs(argv: string[]): ParsedPreflightArgs {
  const parsed: ParsedPreflightArgs = { json: false, help: false };
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
    if (token === "--provider" || token.startsWith("--provider=")) {
      const raw = takesValue();
      if (!raw) {
        parsed.error = "invalid --provider value: <missing>";
        return parsed;
      }
      parsed.provider = raw;
      continue;
    }
    if (token === "--model" || token.startsWith("--model=")) {
      const raw = takesValue();
      if (!raw) {
        parsed.error = "invalid --model value: <missing>";
        return parsed;
      }
      parsed.model = raw;
      continue;
    }
    if (token === "--base-url" || token.startsWith("--base-url=")) {
      const raw = takesValue();
      if (raw === null || !/^https?:\/\//.test(raw)) {
        parsed.error = `invalid --base-url value: ${raw ?? "<missing>"} (expected http(s) URL)`;
        return parsed;
      }
      parsed.baseUrl = raw;
      continue;
    }
    if (token === "--timeout-ms" || token.startsWith("--timeout-ms=")) {
      const value = positiveInt(takesValue(), "--timeout-ms");
      if (typeof value === "string") {
        parsed.error = value;
        return parsed;
      }
      parsed.timeoutMs = value;
      continue;
    }
    if (token === "--expect-dims" || token.startsWith("--expect-dims=")) {
      const value = positiveInt(takesValue(), "--expect-dims");
      if (typeof value === "string") {
        parsed.error = value;
        return parsed;
      }
      parsed.expectDims = value;
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
      "Usage: node scripts/embedding-preflight.js [options]",
      "",
      "Prove (or fail closed on) whether the effective embedding provider can",
      "actually embed — not merely answer HTTP. Reports the reachability route",
      "and a REAL embed separately, so the OPS-004 asymmetric condition",
      "(/models 200 while /embeddings is unauthorized/timed out/empty/wrong-dim)",
      "is a named, machine-readable verdict.",
      "",
      "Options:",
      "  --provider=ID       override embedding.provider (lmstudio|ollama|openai|auto)",
      "  --model=ID          override embedding.model",
      "  --base-url=URL      override the provider base URL",
      "  --timeout-ms=N      budget for the real embed (default: configured timeout)",
      "  --expect-dims=N     dimensions declared as a contract (mismatch fails)",
      "  --json              emit the full report as JSON",
      "  --help              this text",
      "",
      "The API key is read from DUCKBRAIN_EMBEDDING_API_KEY / the config file and",
      "is NEVER accepted on the command line and NEVER printed.",
      "",
      `Exit codes: 0 usable (pass), 1 FAIL CLOSED (usability not proven), ${PREFLIGHT_USAGE_EXIT_CODE} usage error.`,
    ].join("\n"),
  );
}

/**
 * CLI entry used by `scripts/embedding-preflight.js`. Returns the exit code.
 *
 * The check runs for real (global fetch, same as the daemon): tests stub
 * `fetch` rather than injecting a runner, so the CLI's own arg handling and
 * exit-code mapping sit on the real probe path.
 */
export async function runEmbeddingPreflightCli(
  argv: string[],
): Promise<number> {
  const parsed = parsePreflightArgs(argv);
  if (parsed.error) {
    console.error(`embedding-preflight: ${parsed.error}`);
    return PREFLIGHT_USAGE_EXIT_CODE;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const report = await preflightEmbedding({
    config: {
      provider: parsed.provider,
      model: parsed.model,
      baseUrl: parsed.baseUrl,
    },
    timeoutMs: parsed.timeoutMs,
    expectDims: parsed.expectDims,
  });

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const text = renderPreflightReport(report);
    if (report.ok) console.log(text);
    else console.error(text);
  }
  return report.ok ? 0 : 1;
}
