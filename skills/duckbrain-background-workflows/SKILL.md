---
name: duckbrain-background-workflows
description: Design asynchronous memory capture and maintenance jobs for DuckBrain.
version: 1.0.0
category: software-development
---

# DuckBrain Background Workflows

## Goal

Make durable, useful knowledge survive across conversations and agents without slowing replies, polluting memory with guesses, or pretending a backup is a memory update. Background jobs complement the agent's read-before-answer and write-after-meaningful-work behavior; they do not replace it.

Success means that material decisions, verified findings, completed work, and open follow-ups are discoverable in the right namespace with provenance; an agent can retrieve them before answering; writes are verified; failures are visible without spamming the user.

## When to Use

Use this skill when integrating DuckBrain into an agent harness, creating or reviewing a scheduled memory job, designing session capture, project-state sync, memory-health checks, synthesis, or backup/restore.

Don't use it to infer a live cron's enabled state or recent success from this document. Read the host's current scheduler registry and run evidence; job IDs, schedules, and status change independently of the product repo.

## Why the Jobs Are Separate

DuckBrain is the durable memory store. Different background jobs solve different failure modes; don't merge their success signals:

| Workflow | Why it exists | Writes to DuckBrain? | What it does not prove |
|---|---|---:|---|
| Session capture / summary | Preserve material conversation outcomes after the live context closes | Yes | That the summary is complete unless coverage is checked against the transcript window |
| Project context sync | Carry verified repo, board, decision, and next-step deltas across agents | Yes | That the project is healthy or that a cited live state is still current |
| Health check | Detect an unavailable or misrouted memory read/write path | Usually only an isolated probe, if needed | That project knowledge was captured |
| Dreaming / synthesis | Find possible links or hypotheses across existing memories | Yes, explicitly labeled `inferred` | That an inference is fact or an instruction to act |
| Cron-output archive | Retain scheduled-run output for later diagnosis and audit | Yes | That the output is a useful project summary |
| S3 / git backup | Preserve and restore the underlying files/history | Replicates data | That agents can retrieve, understand, or have current knowledge |
| Consolidation | Deduplicate or summarize a time-bounded set of existing records | Sometimes | That the source window was complete unless measured |

A green health check, successful archive, successful S3 upload, and a useful project-memory update are separate outcomes. Report each under its own criterion.

## Integration Contract

### 1. Establish identity and scope first

1. Configure a namespace for the user, agent, or project and a token scoped to only the namespaces the worker needs. Follow `docs/guide/ai-configure.md` and the Authentication section in `skills/duckbrain-usage/SKILL.md`.
2. Resolve the namespace from the actual session/project mapping. Never silently route writes to `default` because a lookup failed.
3. Use the documented MCP, HTTP, or CLI interface. Do not write JSONL files directly from a sidecar worker.

### 2. Read before asserting

For questions about prior decisions, preferences, project history, or earlier work, retrieve from the relevant namespace before answering. Check the source window and record timestamps; if DuckBrain is unavailable or stale, say so and use fresh source evidence where possible. Memory is evidence, not a substitute for live repo, scheduler, or service state.

### 3. Capture durable outcomes, not every token

On session completion or a meaningful project event, extract only durable items: decisions, verified findings, completed changes, constraints, and explicit open follow-ups. Keep the source session/run ID, time window, and source reference. Preserve uncertainty and label generated hypotheses. Exclude credentials, secrets, irrelevant tool chatter, and unsupported claims.

DuckBrain storage is append-oriented: a repeated POST is not automatically idempotent. Before retrying, check whether the exact source/key was already written. Use stable source references and deduplicate before posting.

### 4. Keep work asynchronous and recoverable

Do not run an LLM summarizer or a wide repo scan inline on the user's reply path. At a session-end or event hook, enqueue a small durable work item, then let a bounded worker read the actual completed transcript/event, perform the summary, and write it. A forked/subagent worker does not magically inherit the parent's full scope: pass the transcript or a retrievable session ID, namespace mapping, relevant project/board scope, skill references, time boundary, output schema, and write-verification requirement.

Persist the queue/checkpoint before acknowledging work to the scheduler. Retry reads/writes with bounded backoff; never replay an append whose prior POST may have succeeded. A worker failure must not erase the source transcript or block the user conversation.

### 5. Verify each write

Use the documented write path, then read back the exact key/UUID from the same namespace and confirm the persisted content and provenance. Treat HTTP success alone as routing evidence, not durable verification. Do not advance a "last synced" marker until all planned records were verified and the marker itself is verified last. See `skills/duckbrain-usage/SKILL.md` for API field shapes and `docs/api/http-api.md` for the contract.

### 6. Keep user-visible output quiet and meaningful

A routine background write should not send a chat message. Deliver only useful milestones, actionable failures, or a concise digest that the job's owner requested. Keep run details in logs/records and include a traceable source ID in the memory entry.

## Workflow Design Checklist

For each proposed job, write down:

1. **Purpose:** the data-loss or retrieval problem it prevents.
2. **Source of truth:** transcript, repository/board, health endpoint, prior memories, cron output, or object store.
3. **Trigger and window:** event or schedule, plus an explicit start/end cursor. Schedules are chosen from freshness needs and load, not copied blindly.
4. **Scope:** exact namespace(s), read/write token scopes, and excluded data.
5. **Output contract:** key/domain, source ID, timestamp/window, certainty, and what is intentionally omitted.
6. **Idempotency:** how a retry detects an already-written item before POSTing again.
7. **Verification:** exact read-back proving records and final marker landed.
8. **Failure behavior:** retry, dead-letter, stale-window warning, and who is alerted; never mark a failed or partial run successful.
9. **Success metric:** coverage and verified destination writes, not merely cron status or number of jobs run.
10. **User impact:** latency, cost, storage growth, and delivery noise.

## Pitfalls

- **Treating SOUL.md as a scheduler:** it can establish a durable agent rule, but it cannot guarantee that a background process ran or that a write landed. Implement and verify the worker/job separately.
- **Assuming a fork has the same context:** pass or retrieve the transcript and explicit project scope; otherwise the worker will guess or omit context.
- **Using an archive as a summary:** raw cron/session output aids audit, but agents still need a concise, keyed memory entry.
- **Using a health probe as capture proof:** prove a representative write and exact read-back if the job claims to validate writes.
- **Calling synthesis factual:** all generated links/scenarios remain `inferred` and advisory; never overwrite confirmed entries or trigger actions from them.
- **Using S3 success as freshness proof:** S3 answers durability/restore questions. Query the DuckBrain namespace to prove agent-facing content is present and current.
- **Hardcoding current cron IDs/status in a skill:** resolve the live registry when operating. Store stable rationale and verification behavior here, not a stale snapshot.
- **Appending the entire conversation on every run:** use a bounded time window, source IDs, and deduplication; measure coverage so missed windows are visible.

## Verification

A new integration is ready only when an isolated end-to-end test proves:

1. the intended namespace is selected and unauthorized namespaces are denied;
2. the worker receives the intended source window and preserves provenance;
3. a replay does not create duplicate logical entries;
4. exact-key read-back proves the memory landed;
5. a fresh agent/session can retrieve it before answering a question about that fact;
6. an unavailable API or failed read-back is surfaced as partial/failed, not success;
7. the user-facing turn completes without waiting for background summarization.

For current job inventory/status, inspect the live Hermes cron registry. For DuckBrain interfaces, load `skills/duckbrain-usage/SKILL.md`; for host-specific sync verification, use the relevant operational skill rather than copying its current job status into this repo.
