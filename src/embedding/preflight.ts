/**
 * Embedding provider preflight (OPS-004).
 *
 * WHY THIS EXISTS
 *
 * The live daemon's /health reported `embedding.healthy=false` while a
 * `?q=` semantic query still returned HTTP 200, and the probe evidence pointed
 * two different ways: `/models` answered 200 with the deployment's own key
 * while a manual `/embeddings` call answered 401. Nothing in the repo could
 * answer "is the embedding path actually usable, and if not, WHICH class of
 * failure is it?" without a human decoding provider JSON by hand.
 *
 * The preflight answers exactly that, with three deliberate properties:
 *
 *  1. ASYMMETRY IS THE VERDICT. Reachability is probed on the SAME route the
 *     daemon's cheap gate probes (providers.ts `reachabilityUrl`), and usability
 *     with a REAL embed through the provider's own `build()` — the same code
 *     path recall uses (auth header, input key, request shape). A reachable
 *     endpoint that cannot embed is the OPS-004 condition and FAILS CLOSED:
 *     exit non-zero unless usability was positively proven.
 *
 *  2. FAILURE CLASSES, NOT PROVIDER PROSE. Every failure goes through
 *     `classifyEmbedFailure` (providers.ts), whose taxonomy was verified
 *     against the live provider — in particular that a 401 "Missing
 *     Authentication header" means the credential never ARRIVED (empty or
 *     malformed Authorization header) and never means "the key lacks embeddings
 *     scope". Distinguishing those two was the single most expensive part of
 *     the OPS-004 investigation.
 *
 *  3. SECRET-SAFE BY CONSTRUCTION. The report never contains the API key: the
 *     only thing recorded about it is `key_present`, the endpoint is
 *     credential-stripped, and every piece of provider text is passed through
 *     `redactSecrets`. The preflight is safe to run in CI, paste into a board
 *     row, or commit its output to a tick log.
 *
 * Config precedence is NOT re-implemented here: it is `resolveHealthConfig`
 * from ./health — env (DUCKBRAIN_EMBEDDING_*) > config file
 * (duckbrain.config.json `embedding`) > defaults, with an explicit override
 * beating all three. A second copy of that chain would be the very config
 * drift this row is about.
 *
 * provider=auto IS THE DOCUMENTED DEFAULT (resolveEmbeddingConfig) and a
 * runtime contract, not a concrete provider id: the preflight then probes the
 * registry in PRIORITY ORDER (lmstudio → ollama → openai), mirrors the
 * runtime's cheap gate EXACTLY — a candidate whose reachability route answers
 * non-2xx or throws is excluded WITHOUT its embeddings route ever being
 * called, the same isHealthy filter `createAutoProviders` (providers.ts)
 * applies before returning runtime candidates — continues past a
 * reachable-but-unusable candidate, and selects the first provider whose REAL
 * embed succeeds (the same fallback semantics as `probeEmbeddingHealth` in
 * health.ts). Auto fails closed ONLY when no runtime-eligible candidate
 * proves usability; reachability alone never counts.
 * An EXPLICIT provider remains a hard requirement: one candidate, no
 * fallback, and an unknown id fails immediately. It also keeps its
 * diagnostic real embed even after a gate failure — with no fallback, the
 * embed-path failure class IS the answer the operator needs.
 */

import {
  EMBEDDING_HEALTH_PROBE_TIMEOUT_MS,
  resolveHealthConfig,
} from "./health";
import {
  PROVIDERS,
  classifyEmbedFailure,
  embedUrl,
  reachabilityUrl,
  type EmbeddingConfig,
  type EmbedFailure,
  type EmbedFailureClass,
  type ProviderCtor,
} from "./providers";

/** Reachability probe budget — mirrors the providers' cheap-gate timeout. */
export const PREFLIGHT_REACH_TIMEOUT_MS = 2_000;

export type PreflightVerdict = "pass" | "warn" | "fail" | "skip";

export interface PreflightCheck {
  id:
    "provider" | "reachability" | "usability" | "dimensions" | "health_budget";
  /** Candidate provider this check belongs to (>1 only under provider=auto). */
  provider: string;
  verdict: PreflightVerdict;
  /** HTTP status when a response arrived, else null. */
  status: number | null;
  latency_ms: number | null;
  vector_len: number | null;
  failure_class: EmbedFailureClass | null;
  note: string;
}

export interface EmbeddingPreflightReport {
  /** True only when every check is pass/warn/skip — i.e. usability PROVEN. */
  ok: boolean;
  /**
   * The CONCRETE provider that was proven usable (or, for an explicit
   * provider, the one that failed). Only an all-failed provider=auto probe
   * reports the pseudo-id "auto" here.
   */
  provider: string;
  model: string;
  /** Credential-stripped embed endpoint actually exercised. */
  endpoint: string;
  /** Whether a credential was configured — never the credential itself. */
  key_present: boolean;
  /**
   * The OPS-004 asymmetric condition: the endpoint answered HTTP but could not
   * embed. This is the state a naive "/models is 200, we're fine" check misses.
   */
  asymmetric: boolean;
  checks: PreflightCheck[];
  summary: string;
}

export interface PreflightOptions {
  /** Explicit overrides, highest precedence (same shape as /health's probe). */
  config?: EmbeddingConfig;
  /**
   * Budget for the USABILITY embed. Defaults to the configured
   * `DUCKBRAIN_EMBEDDING_TIMEOUT_MS` — the preflight answers "can this path
   * embed at all", so it must not inherit the short /health probe budget,
   * which is the budget whose expiry caused the false-degraded reading.
   */
  timeoutMs?: number;
  /** Dimensions the operator declares as a contract (always strict). */
  expectDims?: number;
}

/** Strip any userinfo from a URL before it reaches a report. */
function sanitizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "<unparseable url>";
  }
}

/**
 * An operator-declared dimension count is a CONTRACT; a mere default is not.
 *
 * The live deployment declares `DUCKBRAIN_EMBEDDING_DIMENSIONS=4096` in its
 * systemd drop-in, so a live vector of any other length means the configured
 * model is not the model being served — fail closed. Without that declaration
 * the repo documents dimensions as metadata-only (docs/guide/embeddings.md:
 * the local alias `qwen3-embedding:0.6b` returns 1024 dims against the schema
 * default 384, and cosine ranking is over STORED vector lengths), so a
 * mismatch there is reported as a warning instead of a false alarm.
 */
function dimsAreContract(explicit: number | undefined): boolean {
  return (
    explicit !== undefined ||
    Boolean(process.env.DUCKBRAIN_EMBEDDING_DIMENSIONS)
  );
}

/** One candidate provider's probe outcome (auto mode probes several). */
interface CandidateProbe {
  id: string;
  checks: PreflightCheck[];
  vectorLen: number | null;
  embedMs: number | null;
  endpoint: string;
  /** True only when the REAL embed succeeded — usability, not reachability. */
  usable: boolean;
  /** Reachable but unusable — the OPS-004 asymmetric condition. */
  asymmetric: boolean;
  usabilityNote: string;
}

/**
 * Probe ONE candidate provider end to end: the daemon's cheap-gate
 * reachability route, then a REAL embed through the provider's own build(),
 * then dimensions and the /health budget comparison.
 *
 * Never throws for provider/transport failures — those become `fail` checks,
 * because "could not prove usability" IS the failing verdict (fail closed).
 */
async function probeCandidate(
  ctor: ProviderCtor,
  resolved: Required<EmbeddingConfig>,
  opts: PreflightOptions,
  secrets: readonly string[],
  /** True under provider=auto: the runtime cheap-gate contract applies. */
  auto: boolean,
): Promise<CandidateProbe> {
  const perCfg = { ...resolved, provider: ctor.id };
  const checks: PreflightCheck[] = [];

  // ---- 1. reachability (the daemon's own cheap-gate route) ----------------
  const reachUrl = reachabilityUrl(ctor.id, perCfg);
  let reachStatus: number | null = null;
  let reachMs: number | null = null;
  let reachFailure: EmbedFailureClass | null = null;
  let reachNote: string;
  const reachStart = Date.now();
  try {
    const res = await fetch(reachUrl, {
      headers:
        ctor.id === "openai"
          ? { Authorization: `Bearer ${resolved.apiKey}` }
          : {},
      signal: AbortSignal.timeout(PREFLIGHT_REACH_TIMEOUT_MS),
    });
    reachMs = Date.now() - reachStart;
    reachStatus = res.status;
    reachNote =
      `reachability ${res.status} in ${reachMs}ms (${sanitizeEndpoint(reachUrl)})` +
      // The daemon's cheap gate requires a 2xx (isHealthy → res.ok): a 404/5xx
      // on this route means the configured endpoint is wrong, and in `auto`
      // mode the provider would be dropped even if its embed route worked.
      (res.ok
        ? ""
        : " — the daemon's cheap gate requires 2xx here, so this provider is skipped by the auto path") +
      // Verified live 2026-09-12: OpenRouter's /v1/models answers 200 with NO
      // credential at all and lists zero embedding models, even with one. So a
      // 200 here is NOT evidence the credential works — only the embed probe
      // below can prove that.
      (ctor.id === "openai"
        ? " — NOTE: this route is public and lists no embedding models, so a 200 proves reachability ONLY, never credential or embedding usability"
        : "");
  } catch (e) {
    const failure = classifyEmbedFailure(e, secrets);
    reachFailure = failure.class;
    reachNote = `reachability failed (${failure.class}): ${failure.detail}`;
  }
  const gatePassed =
    reachStatus !== null && reachStatus >= 200 && reachStatus < 300;
  checks.push({
    id: "reachability",
    provider: ctor.id,
    verdict: gatePassed ? "pass" : "fail",
    status: reachStatus,
    latency_ms: reachMs,
    vector_len: null,
    failure_class: reachFailure,
    note: reachNote,
  });

  // ---- 2. usability (a REAL embed through the provider's own build) -------
  const budget = opts.timeoutMs ?? resolved.timeoutMs;
  const endpoint = sanitizeEndpoint(embedUrl(ctor.id, perCfg));

  // RUNTIME PARITY (OPS-004): under provider=auto the runtime's cheap gate
  // (createAutoProviders → isHealthy → res.ok on this same route) EXCLUDES a
  // provider whose gate failed — its embeddings route is never called. The
  // preflight mirrors that exactly: no embed attempt, an honest `skip`
  // usability check, and on to the next candidate in registry order. An
  // EXPLICIT provider keeps the diagnostic real embed even after a gate
  // failure: it is a hard requirement with no fallback, so its report must
  // name the embed-path failure class, not stop at the gate.
  const skipEmbed = auto && !gatePassed;

  let vectorLen: number | null = null;
  let embedMs: number | null = null;
  let embedFailure: EmbedFailure | null = null;
  let embedNote: string;
  if (skipEmbed) {
    embedNote =
      "skipped — the cheap reachability gate failed, and provider=auto excludes this provider at isHealthy (createAutoProviders) without ever calling its embeddings route; no embed was attempted";
  } else {
    const provider = ctor.build({
      baseUrl: resolved.baseUrl ?? "",
      model: resolved.model,
      dimensions: resolved.dimensions,
      timeoutMs: budget,
      apiKey: resolved.apiKey,
    });
    const embedStart = Date.now();
    try {
      const vector = await provider.embed("ping");
      embedMs = Date.now() - embedStart;
      vectorLen = vector.length;
      embedNote = `real embed OK: ${vectorLen}-dim vector in ${embedMs}ms (${endpoint}, budget ${budget}ms)`;
    } catch (e) {
      embedFailure = classifyEmbedFailure(e, secrets);
      embedNote = `real embed FAILED (${embedFailure.class}): ${embedFailure.detail}`;
    }
  }
  const usabilityVerdict: PreflightVerdict = skipEmbed
    ? "skip"
    : embedFailure === null
      ? "pass"
      : "fail";
  checks.push({
    id: "usability",
    provider: ctor.id,
    verdict: usabilityVerdict,
    status: embedFailure?.status ?? null,
    latency_ms: embedMs,
    vector_len: vectorLen,
    failure_class: embedFailure?.class ?? null,
    note: embedNote,
  });

  // ---- 3. dimensions (contract when declared, metadata otherwise) ---------
  const expected = opts.expectDims ?? resolved.dimensions;
  const strictDims = dimsAreContract(opts.expectDims);
  let dimsVerdict: PreflightVerdict;
  let dimsNote: string;
  if (vectorLen === null) {
    dimsVerdict = "skip";
    dimsNote = skipEmbed
      ? "not evaluated — no embed was attempted (the cheap gate failed)"
      : "not evaluated — the usability probe produced no vector";
  } else if (vectorLen === expected) {
    dimsVerdict = "pass";
    dimsNote = `live vector length ${vectorLen} matches the declared ${expected}`;
  } else if (strictDims) {
    dimsVerdict = "fail";
    dimsNote =
      `declared dimensions ${expected} do NOT match the live model's ${vectorLen}-dim output` +
      ` — the declared count is a contract (DUCKBRAIN_EMBEDDING_DIMENSIONS / --expect-dims), so the served model is not the configured one`;
  } else {
    dimsVerdict = "warn";
    dimsNote =
      `live vector length ${vectorLen} differs from the schema default ${expected}` +
      ` — documented metadata-only case (docs/guide/embeddings.md): cosine ranking uses stored vector lengths, so this is informational`;
  }
  checks.push({
    id: "dimensions",
    provider: ctor.id,
    verdict: dimsVerdict,
    status: null,
    latency_ms: null,
    vector_len: vectorLen,
    failure_class: null,
    note: dimsNote,
  });

  // ---- 4. /health probe budget (why healthy flapped while ?q= worked) -----
  let budgetVerdict: PreflightVerdict;
  let budgetNote: string;
  if (embedMs === null) {
    budgetVerdict = "skip";
    budgetNote = skipEmbed
      ? "not evaluated — no embed was attempted (the cheap gate failed)"
      : "not evaluated — no successful embed to time";
  } else if (embedMs > EMBEDDING_HEALTH_PROBE_TIMEOUT_MS) {
    budgetVerdict = "warn";
    budgetNote =
      `embed took ${embedMs}ms, longer than the ${EMBEDDING_HEALTH_PROBE_TIMEOUT_MS}ms /health embed-probe budget` +
      ` — /health can report embedding.healthy=false intermittently while ?q= queries still succeed (OPS-004 false-degraded)`;
  } else {
    budgetVerdict = "pass";
    budgetNote = `embed took ${embedMs}ms, inside the ${EMBEDDING_HEALTH_PROBE_TIMEOUT_MS}ms /health embed-probe budget`;
  }
  checks.push({
    id: "health_budget",
    provider: ctor.id,
    verdict: budgetVerdict,
    status: null,
    latency_ms: embedMs,
    vector_len: null,
    failure_class: null,
    note: budgetNote,
  });

  const usability = checks.find((c) => c.id === "usability")!;
  const reachability = checks.find((c) => c.id === "reachability")!;
  return {
    id: ctor.id,
    checks,
    vectorLen,
    embedMs,
    endpoint,
    // A `skip` usability (cheap-gate exclusion) is never usable and never
    // asymmetric: the asymmetric condition requires a PASSING gate.
    usable: usabilityVerdict === "pass",
    asymmetric: reachability.verdict === "pass" && usability.verdict === "fail",
    usabilityNote: usability.note,
  };
}

/**
 * Probe the effective embedding config end to end, secret-safely.
 *
 * provider=auto (the documented default) probes the registry in priority
 * order and selects the first candidate whose REAL embed succeeds; an
 * explicit provider is a single-candidate hard requirement. Either way the
 * verdict fails closed unless usability was positively proven.
 */
export async function preflightEmbedding(
  opts: PreflightOptions = {},
): Promise<EmbeddingPreflightReport> {
  const resolved = resolveHealthConfig(opts.config ?? {});
  const secrets = [resolved.apiKey];

  const auto = !resolved.provider || resolved.provider === "auto";
  const candidates = auto
    ? PROVIDERS // already priority order: lmstudio → ollama → openai
    : PROVIDERS.filter((p) => p.id === resolved.provider);

  if (candidates.length === 0) {
    const known = [...PROVIDERS.map((p) => p.id), "auto"].join(", ");
    return {
      ok: false,
      provider: resolved.provider,
      model: resolved.model,
      endpoint: "",
      key_present: Boolean(resolved.apiKey),
      asymmetric: false,
      checks: [
        {
          id: "provider",
          provider: resolved.provider,
          verdict: "fail",
          status: null,
          latency_ms: null,
          vector_len: null,
          failure_class: null,
          note: `unknown embedding provider '${resolved.provider}' — known providers: ${known}`,
        },
      ],
      summary: `FAIL (closed): unknown embedding provider '${resolved.provider}'`,
    };
  }

  // Probe candidates in priority order, stopping at the first whose real
  // embed succeeds. Under provider=auto a candidate whose cheap reachability
  // gate failed is excluded WITHOUT an embed attempt — the same isHealthy
  // filter createAutoProviders applies before returning runtime candidates —
  // and a reachable-but-unusable candidate is recorded with its classified
  // failure and skipped. Those skips ARE the auto fallback the runtime
  // applies at recall time. An explicit provider has exactly one candidate,
  // so nothing changes for it.
  const attempts: CandidateProbe[] = [];
  for (const ctor of candidates) {
    const attempt = await probeCandidate(ctor, resolved, opts, secrets, auto);
    attempts.push(attempt);
    if (attempt.usable) break;
  }

  const winner = attempts.find((a) => a.usable) ?? null;
  const selected = winner ?? attempts[attempts.length - 1];
  const checks = attempts.flatMap((a) => a.checks);
  const skipped = winner ? attempts.slice(0, attempts.indexOf(winner)) : [];
  // ok requires a PROVEN-usable winner whose own checks are otherwise clean
  // (a strict-dimensions failure on the winning embed still fails closed);
  // failures recorded for skipped auto candidates do not poison the verdict.
  const ok =
    winner !== null && winner.checks.every((c) => c.verdict !== "fail");
  const asymmetric = winner === null && attempts.some((a) => a.asymmetric);

  const summary = ok
    ? `PASS: ${selected.id}/${resolved.model} embedded a live vector (${selected.vectorLen} dims)` +
      (auto
        ? skipped.length > 0
          ? ` — provider=auto skipped unusable candidate(s) ${skipped.map((a) => a.id).join(", ")} in priority order (see checks[])`
          : " — provider=auto, first candidate in priority order"
        : "") +
      (selected.checks.some((c) => c.verdict === "warn")
        ? " with warnings — see checks[]"
        : "")
    : winner !== null
      ? // A real embed SUCCEEDED but a contract check failed (e.g. declared
        // dimensions, or a reachability gate in explicit mode) — never the
        // no-winner wording: usability WAS proven, something else failed.
        `FAIL (closed): ${winner.id}/${resolved.model} embedded a live ${winner.vectorLen}-dim vector, but failed check(s): ` +
        winner.checks
          .filter((c) => c.verdict === "fail")
          .map((c) => c.id)
          .join(", ") +
        " — see checks[]"
      : auto
        ? `FAIL (closed): provider=auto probed ${attempts.map((a) => a.id).join(" → ")} in priority order; no runtime-eligible candidate proved usability` +
          (asymmetric
            ? " [reachable-but-unusable: the OPS-004 asymmetric condition]"
            : "")
        : `FAIL (closed): ${selected.id}/${resolved.model} could not be proven usable — ` +
          selected.usabilityNote +
          (selected.asymmetric
            ? " [reachable-but-unusable: the OPS-004 asymmetric condition]"
            : "");

  return {
    ok,
    provider: winner ? winner.id : auto ? "auto" : resolved.provider,
    model: resolved.model,
    endpoint: selected.endpoint,
    key_present: Boolean(resolved.apiKey),
    asymmetric,
    checks,
    summary,
  };
}

/**
 * Render the report for humans (stdout). Every line is safe to paste into a
 * board row or a tick log: no credential value can reach it.
 */
export function renderPreflightReport(
  report: EmbeddingPreflightReport,
): string {
  const lines = [
    `embedding preflight: ${report.summary}`,
    `  provider: ${report.provider}   model: ${report.model}   key_present: ${report.key_present ? "yes" : "no"}`,
    `  endpoint: ${report.endpoint}`,
    `  asymmetric (reachable but unusable): ${report.asymmetric ? "yes" : "no"}`,
  ];
  for (const check of report.checks) {
    const bits = [
      `${check.verdict.toUpperCase().padEnd(4)} ${check.id}`,
      check.provider !== report.provider ? `[${check.provider}]` : null,
      check.status !== null ? `http=${check.status}` : null,
      check.latency_ms !== null ? `ms=${check.latency_ms}` : null,
      check.vector_len !== null ? `dims=${check.vector_len}` : null,
      check.failure_class ? `class=${check.failure_class}` : null,
    ].filter(Boolean);
    lines.push(`  ${bits.join(" ")}`);
    lines.push(`       ${check.note}`);
  }
  return lines.join("\n");
}
