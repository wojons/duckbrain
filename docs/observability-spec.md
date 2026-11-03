# DuckBrain — Observability Spec

Status: audit + specification only. No service code is changed by this document.
Audited tree: `/home/kara/duckbrain` @ `d88a2b8a` (+tolerated working-tree edits listed in §7).
Method: `grep`/`sed` over the source plus live `curl` against the running daemon on `127.0.0.1:3000` (2026-11-03).

---

## 0. Verdict today (measured, not guessed)

| Question | Answer | Evidence |
|---|---|---|
| Does DuckBrain expose a Prometheus `/metrics` endpoint? | **No.** | `src/cli/http.ts:573-576` registers `/health` and `/stats`; there is no `/metrics` route anywhere in `src/` (`grep -rn 'metrics' src --include=*.ts` matches only the recall-metrics CLI/JSONL module, see §1). |
| Does it use a Prometheus/OTel client library? | **No.** | `package.json` dependencies contain no `prom-client`, no `@opentelemetry/*`; `grep -n 'prom-client\|prometheus' package.json pnpm-lock.yaml` → 0 hits. |
| Does anything scrape it? | **No.** The fleet's Prometheus has no DuckBrain job. | The only external watchers are two systemd oneshot timers inside the repo (`ops/systemd/duckbrain-http-health.service:14`, `ops/systemd/duckbrain-http-recover.service:23`) that exit 0/1/3 — an exit code is not a metric. |
| Proof at runtime | `curl -o /dev/null -w '%{http_code}'` on the live daemon: `/health` → **503**, `/metrics` → **401**, `/stats` → **401**. | `/metrics` returning 401 is the auth middleware answering an unknown path (`src/cli/http.ts:532` mounts `authMiddleware` before all routes; the 404 handler is later, `src/cli/http.ts:942`) — i.e. there is no metrics route, not a protected one. |

**Verdict: BLIND.** DuckBrain emits *no* scrapable metric. It has durable JSONL ledgers and a rich `/health` body, but nothing converts that state into a time series. The fleet's ~20 application series do not include a single `duckbrain_*` name.

This is a hard blind spot, not a cosmetic one: the live daemon is serving while its `/health` says `status:"degraded"` because the embedding probe timed out (`embedding.providers[0].note:"timeout: the embed probe exceeded its 8000ms health budget"`). That fact is visible only if a human curls the body. Nothing pages, and nothing charts whether this is a 2-minute blip or the permanent state.

---

## 1. What DuckBrain is, and what "healthy" means

DuckBrain is a **long-running HTTP daemon** (Express 5, `src/cli/http.ts:427-428`) that also runs as a stdio MCP server and a CLI. Three surfaces matter:

1. **HTTP REST + MCP-over-HTTP daemon** on `:3000` (systemd user unit `duckbrain-http`, `Restart=always`; confirmed `active`, listening on `0.0.0.0:3000` via `ss -lntp`). This is the surface a monitoring stack must observe.
2. **Embedding provider path** — semantic recall depends on a remote embedder; `/health` probes it with an 8.5 s budget (`src/embedding/health.ts:44-57`) under a 9 s whole-handler deadline (`src/cli/http.ts:218`).
3. **Git-backed namespace storage** — every write schedules a debounced async `git add/commit/push` per namespace (`src/git/autocommit.ts:567-596`), with failures logged and swallowed as `console.warn` (`src/git/autocommit.ts:586-589`, `1034-1036`).

**Healthy** (as the code already defines it, `src/cli/http.ts:381-390`):

- `/health` answers **200** (not 503) within 9 s;
- `embedding.healthy === true` and `keys_error === null`;
- the daemon is accepting REST/MCP traffic.
- Separately (not currently expressed): the write path is landing commits and pushes, and namespace storage is not silently diverging.

Note the deliberate distinction already in the codebase: a **degraded** daemon is ALIVE for liveness (`src/cli/health-check.ts:27`, `ALIVE_STATUSES = {200,503}`), while **HUNG** is a different failure (`HUNG_EXIT_CODE = 3`). The metric design below preserves that three-way distinction instead of flattening it to up/down.

---

## 2. Blind spots that actually hurt (state exists, never emitted)

| # | 3am question | Where the state LIVES today | Why it is invisible |
|---|---|---|---|
| 1 | Is the daemon up and what is its degraded/alive/hung state, as a time series? | `/health` body `status`, `deadline_exceeded`, `embedding.healthy` (`src/cli/http.ts:381-390`) | It is a JSON body polled by a oneshot that discards it: `src/cli/health-check.ts:22` "Pure liveness: the response body is not parsed." Slow probe latency — the exact incident OPS-002 was written for (`src/cli/http.ts:291-295`: `/health` parked forever, "monitors were blind") — is never timed into a series. |
| 2 | Is the embedder quota/credentials still good, or are we burning retries? | `EmbeddingHealthResult.providers[].{healthy,note}` incl. classified 401/429/402 causes (`src/embedding/health.ts:180-249`) | Only the *current* boolean is shown. No history, no per-provider dimension, no request-level error counter. A `note` string is not queryable. |
| 3 | How much work is the daemon doing, and how fast? | Per-request `{ts, route, method, ns, status, dur_ms}` appended to `.duckbrain-audit/reads.jsonl` (`src/http/readLedger.ts:70-80`, writer `src/http/readLedger.ts:109-150`) | The *durable data already exists* — including duration — but the only consumer is a pull-only GET (`src/http/routes/reads.ts:75`) that aggregates counts and status codes only (`src/http/readLedger.ts:338-400`; **no durations**). Nothing exports it to a scraper, and readers other than `duckbrain` never query it. |
| 4 | Which routes are answering 5xx / 429 right now? | `status` field of the same ledger rows; 429 emitted at `src/auth/ratelimit.ts:159` | 429 is returned by the **rate-limit middleware**, which runs *before* the read-ledger middleware (`src/cli/http.ts:458` vs `:530`), so a throttled request is **never recorded at all**. Throttling is structurally invisible. Same for DNS-rebinding 403s (`src/cli/http.ts:447-451`). |
| 5 | Are writes landing? Is a namespace's commit/push failing repeatedly? | `asyncChains` per-namespace promise chain and `pushGateStateFor(namespace)` (`src/git/autocommit.ts:567-596`, `925-1040`) | Failures are `console.warn` + swallow (`src/git/autocommit.ts:586-589`, `1034`). Repeated push failure = silent data divergence from the remote. |
| 6 | Is the commit queue backing up? | Same chain map; `drainAsyncCommits` bounded by `timeoutMs` (`src/git/autocommit.ts:604`) | In-flight/pending depth is a Map size nobody reads. |
| 7 | Is recall actually useful (packs answering non-empty)? | `recordRecallMetric` → `metrics/recall-counter.jsonl`, rolled up only by a CLI (`src/metrics/recall.ts:107-136`, `179-260`) | Durable and correct, but pull-only via `duckbrain recall-metrics`. The alert file `recall-alerts.jsonl` is written by a human-run command (`src/metrics/recall.ts:224-273`), not by a cron in this repo. |
| 8 | Is data/storage growing? Will the disk fill? | `EmbeddingCache.sizeBytes()` (`src/embedding/cache.ts:263-271`), `namespaces/` (285 entries / 79 MB measured), sealed read-ledger segments (`src/http/readLedger.ts:40-60`) | `sizeBytes()` is called by nobody on a schedule; no gauge. |
| 9 | Is the embedding cache effective, or is every recall a cold provider call? | `EmbeddingCache` internals (`src/embedding/cache.ts:56`) | No hits/misses counters at all. |
| 10 | Is the S3 backup/sync path healthy and current? | `computeDeltas`/`acquireLock`/`namespaceDeadlineSeconds` (`src/s3/sync.ts:240`, `332`, `655`) | Sync is CLI-driven with no last-success timestamp emitted anywhere. |

Blind spots 1–5 are the ones an operator hits first; they are what the MVP row addresses.

---

## 3. Metric catalogue

Naming convention: `duckbrain_<subsystem>_<thing>_<unit>`.

**Label discipline (hard rules):**

- Allowed label values: `host`, `product`(= `duckbrain`), `service`(= `http`), `route` (normalized template only — the templates already exist at `src/http/readLedger.ts:243-280`), `method` (GET/HEAD/POST/PUT/DELETE), `status_class` (`2xx`/`3xx`/`4xx`/`5xx`), `provider` (embedder id, e.g. `openai`, `ollama`).
- **Never** a namespace name, memory key, memory id, user/principal, API-key id, prompt text, file path, ISO timestamp, or raw error string in a label. Namespace names are user-chosen and unbounded → cardinality and PII risk. Error text belongs in logs, not labels.
- `route` must be the normalized template, never the raw URL (`/api/memories/key/<key>` would leak content).

### 3.1 MVP — the five that answer "is it alive and working?" (row OBSDB-001)

| Name | Type | Unit | Labels | Answers |
|---|---|---|---|---|
| `duckbrain_http_up` | gauge | 1/0 | — | Is the process answering `/metrics` at all? (single most important) |
| `duckbrain_health_status` | gauge | enum | — | Current `/health` verdict: `2`=healthy, `1`=degraded, `0`=hung/unreachable. Preserves the ALIVE/DARK/HUNG split from `src/cli/health-check.ts:27-31`. |
| `duckbrain_health_probe_duration_seconds` | histogram | seconds | `probe` = `embedding` \| `keys` \| `total` | Is `/health` slow — the OPS-002 failure class? |
| `duckbrain_embedding_provider_healthy` | gauge | 1/0 | `provider` | Is the embedder usable right now? (live incident: currently 0) |
| `duckbrain_reads_total` | counter | requests | `route`, `method`, `status_class` | How much work, and how much of it is failing? Derived from the existing read ledger. |

### 3.2 Follow-on depth

| Name | Type | Unit | Labels | Answers | Row |
|---|---|---|---|---|---|
| `duckbrain_read_duration_seconds` | histogram | seconds | `route`, `method` | How long does a unit of work take? (p95/p99 per route) | OBSDB-002 |
| `duckbrain_reads_rejected_total` | counter | requests | `reason` (`rate_limit`\|`dns_rebind`) | Are we throttling or blocking clients? Covers the gap in blind spot #4 where the ledger sees nothing. | OBSDB-002 |
| `duckbrain_embedding_requests_total` | counter | requests | `provider`, `outcome` (`ok`\|`timeout`\|`auth`\|`quota`\|`error`) | How often does embedding fail and why? | OBSDB-003 |
| `duckbrain_embedding_cache_hits_total` / `..._misses_total` | counter | lookups | — | Is the cache working? (ratio) | OBSDB-003 |
| `duckbrain_git_commit_total` | counter | operations | `outcome` (`ok`\|`fail`) | Are writes landing? | OBSDB-004 |
| `duckbrain_git_push_total` | counter | operations | `outcome` (`ok`\|`fail`) | Is the remote diverging? | OBSDB-004 |
| `duckbrain_git_commit_queue_depth` | gauge | commits | — | Is the write queue backing up? | OBSDB-004 |
| `duckbrain_git_last_push_success_timestamp_seconds` | gauge | unix seconds | — | How stale is the last successful push? (alert: `time() - ... > 3600`) | OBSDB-004 |
| `duckbrain_storage_namespaces_bytes` | gauge | bytes | — | Is data growing / disk filling? | OBSDB-005 |
| `duckbrain_storage_embedding_cache_bytes` | gauge | bytes | — | Cache footprint. | OBSDB-005 |
| `duckbrain_read_ledger_rotation_total` | counter | rotations | — | Is the audit ledger churning (10 MB segments)? | OBSDB-005 |
| `duckbrain_recall_packs_total` / `..._nonempty_total` | counter | packs | — | Is recall returning anything? (non-empty-pack rate) | OBSDB-005 |
| `duckbrain_build_info` | gauge | 1 | `version`, `node` | What is deployed? (`process.version` already at `src/cli/http.ts:403`) | OBSDB-001 (folded in) |

Cardinality estimate at steady state: `route` ≈ 12 templates × 4 status classes × 2 methods ≈ 100 series; everything else < 20. Well inside a single scrape job.

---

## 4. Exposure mechanism

**Chosen: a native `/metrics` route on the existing Express app, using `prom-client` (the official Node.js Prometheus client) rendered in the text exposition format (0.0.4).**

- Mount `GET /metrics` in `createHttpServer` (`src/cli/http.ts:573-576`, next to `/health`).
- **Auth-exempt**, like `/health` (`src/cli/http.ts:572` comment) and rate-limit-exempt: a throttled scrape must still answer, and the pattern is already established by the dark-port watchdog reading `/health` with no credentials (`ops/systemd/duckbrain-http-health.service:9`).
- Bind to the metrics on **localhost/localhost-only access**. If the scrape comes over a network, gate by source IP or a static bearer in the scrape config — never by a per-user token (cardinality + secret handling).
- If a no-dependency route is preferred, the fallback is to hand-render the text format from an in-process registry; `prom-client` is explicitly allowed by the owning project because `package.json` already carries a small, curated dependency set and this is the official client.
- **Alternative rejected:** instrumenting through OpenTelemetry and an OTel-Prometheus bridge. Justified only if DuckBrain adopts tracing; today it has none, and the bridge adds a collector hop the fleet does not have.

**Short-lived lanes are NOT scraped.** The CLI (`duckbrain recall-metrics`, `duckbrain s3 sync`, one-shot maintenance) exits before any scrape could see it. For those the right answer is a **textfile collector** record written on completion (`node_exporter --collector.textfile.directory`, or a completion JSONL that a cron converts) — explicitly *not* a pushgateway, because pushgateway retains the last value forever and turns a dead cron into a green gauge. This is out of scope for the daemon rows and is called out here so nobody bolts metrics onto a CLI.

---

## 5. Collection path (fleet-monitor)

1. **Scrape job** (owner action, in `/root/fleet-monitoring/prometheus/prometheus.yml` — *not* modified by this spec):

   ```yaml
   - job_name: duckbrain
     metrics_path: /metrics
     scrape_interval: 30s
     static_configs:
       - targets: ['<duckbrain-host>:3000']
         labels:
           product: duckbrain
           service: http
   ```

   `host` is injected by the agent/relabel, not by the app.
2. **Push alternative** if the daemon host cannot be reached by fleet-monitor: the fleet agent already does `remote_write`, so a tiny sidecar (or the agent's existing textfile source) can push the same text exposition. Prefer the scrape job; Pushgateway is not appropriate for a long-running daemon.
3. **Fleet agent today**: nothing product-specific is required — it already pushes `fleet_*`/`bunker_*`, so the moment a scrape job or textfile source exists, the series land without further work.
4. **Alertmanager** rules live on fleet-monitor, not in this repo. The two rules this catalogue enables: `duckbrain:health_degraded` (`duckbrain_health_status < 2` for 10m) and `duckbrain:push_stale` (`time() - duckbrain_git_last_push_success_timestamp_seconds > 3600`).

---

## 6. Verification — what "done" looks like

A reviewer runs these, in order. All must succeed.

**MVP (OBSDB-001):**

```bash
# 1. The endpoint exists on the live daemon and needs no credentials
curl -fsS http://127.0.0.1:3000/metrics | head -1        # -> '# HELP duckbrain_http_up ...'

# 2. Each MVP metric is present with a value
for m in duckbrain_http_up duckbrain_health_status duckbrain_health_probe_duration_seconds \
         duckbrain_embedding_provider_healthy duckbrain_reads_total duckbrain_build_info; do
  curl -fsS http://127.0.0.1:3000/metrics | grep -q "^$m" && echo "OK $m" || echo "MISSING $m"
done

# 3. The health gauge agrees with /health (no split-brain)
curl -fsS http://127.0.0.1:3000/health | jq -r .status
curl -fsS http://127.0.0.1:3000/metrics | grep '^duckbrain_health_status '
# -> healthy:2  degraded (current live state) => 1

# 4. A read moves the counter (no frozen series)
before=$(curl -fsS http://127.0.0.1:3000/metrics | grep '^duckbrain_reads_total' | awk '{s+=$2} END{print s+0}')
curl -fsS -o /dev/null http://127.0.0.1:3000/api/namespaces -H "Authorization: Bearer $KEY"
sleep 1
after=$(curl -fsS http://127.0.0.1:3000/metrics | grep '^duckbrain_reads_total' | awk '{s+=$2} END{print s+0}')
[ "$after" -gt "$before" ] && echo PASS || echo FAIL
```

**From Prometheus (after the scrape job exists):**

```promql
# Is it up and what state is it in?
duckbrain_http_up
duckbrain_health_status{job="duckbrain"}

# Degraded right now? (current live daemon: embedding probe timing out)
duckbrain_embedding_provider_healthy == 0

# Request rate and error ratio per route
sum by (route) (rate(duckbrain_reads_total[5m]))
sum(rate(duckbrain_reads_total{status_class="5xx"}[5m])) / sum(rate(duckbrain_reads_total[5m]))

# p95 latency (needs OBSDB-002)
histogram_quantile(0.95, sum by (le, route) (rate(duckbrain_read_duration_seconds_bucket[5m])))

# Write path alive? (needs OBSDB-004)
time() - duckbrain_git_last_push_success_timestamp_seconds
rate(duckbrain_git_push_total{outcome="fail"}[15m]) > 0
```

**Done = all of:** `/metrics` answers 200 unauthenticated on the live daemon; all MVP metric families present; `duckbrain_health_status` matches `/health` on two consecutive probes; `duckbrain_reads_total` increments after a real read; the Prometheus target `duckbrain` is `UP` with ≥5 `duckbrain_*` families visible in the graph; and no metric carries a namespace, key, user, path, or timestamp label.

---

## 7. Deliberately NOT instrumented

- **Per-namespace request counts.** 285 namespace directories exist in `namespaces/` and the count grows with every test and user. As a label it is unbounded cardinality and leaks customer data. Aggregate only; use `/api/reads?ns=` for a bounded ad-hoc investigation.
- **Per-memory-key or per-memory-id counters.** Same reason, plus content risk.
- **Principals, API-key ids, user emails.** Secret-adjacent; the audit ledgers already cover denial attribution.
- **Raw error strings as labels.** `keys_error` / provider `note` are free text containing hostnames and timeouts (`src/cli/http.ts:340-365`). They belong in logs/the `/health` body; the metric carries an enum.
- **Timestamps in labels** (e.g. `day`). Use `_timestamp_seconds` gauges.
- **Memory content, prompts, query strings.** The read ledger already strips them by design (`src/http/readLedger.ts:167-175` `normalizeReadRoute` — "Query strings never reach this function's output"); the metrics must not undo that.
- **Uptime as a metric.** `process.uptime()` already appears in `/health` (`src/cli/http.ts:404`); process restart detection belongs to Prometheus itself, not to a hand-emitted gauge.
- **The CLI / one-shot lanes.** Not scraped at all (see §4) — textfile completion records only, and out of scope here.

---

## 8. Audit notes / caveats

- The starting hypothesis `endpoint_metrics=1, own_counter_or_gauge=0` was confirmed but understated: the single `metrics` hit is `src/metrics/recall.ts`, which is a **rollup CLI over JSONL**, not an exposition endpoint.
- `src/http/middleware/readLedger.ts` arrived in commit `d88a2b8a` and the working tree also carries unrelated edits (`src/auth/ratelimit.ts`, `tests/http-ratelimit.int.test.ts`, `.gitreins/tasks.yaml`) from a concurrent lane. Metric row ids were chosen fresh (`OBSDB-*`) so they cannot collide with `OBS-*`/`OBS-DUCKBRAIN-001` work in flight.
- Not verified: whether an external cron actually runs `duckbrain recall-metrics check` / `recall-alerts.jsonl` on this host — the file does not exist under `~/namespaces/metrics/` (directory absent) while `<namespacesPath>/.duckbrain-audit/reads.jsonl` (`~/namespaces/.duckbrain-audit/reads.jsonl` on this host, 47 namespace dirs) holds only **2 rows** (last `2026-10-13`), against a daemon up 216 914 s. So the read ledger is populated almost exclusively by tests, and **read traffic on the live daemon is not landing in the ledger at the rate the uptime implies** — worth a follow-on investigation, and a reason the `duckbrain_reads_total` acceptance check must assert a delta rather than an absolute.
