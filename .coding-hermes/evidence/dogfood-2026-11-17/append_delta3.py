#!/usr/bin/env python3
"""Append the delivery-3 (records-only) DELTA to .coding-hermes/dogfood-log.md."""
import pathlib

P = pathlib.Path("/home/kara/duckbrain/.coding-hermes/dogfood-log.md")
TEXT = """
### DELTA — third delivery of tick `duckbrain-dogfood-2026-11-17-11-52-37` (records only)

**One tick id, three dispatches.** `grep -c 'duckbrain-dogfood-2026-11-17-11-52-37'
~/.hermes/logs/gateway.log` -> **3**, one inbound line each, all on the same chat
(`api_server`, chat 99efeca7): **06:52:40**, **07:46:41**, **07:53:40**. Delivery 2's record commit
`ba735b46` landed at **07:51:17**, so this delivery arrived **2 min 23 s after the record it
duplicates was already on `origin/main`** — the same re-dispatch pattern delivery 2 measured, not a
new product signal. Per the duplicate-fire rule this fire re-walked nothing: no product invocation,
no battery, no board write.

**Provenance re-graded at the remote tip, not from the earlier prose.** `git fetch origin` then
`git rev-list --left-right --count HEAD...origin/main` -> `0  0` at `ba735b46` (Tue Nov 17 07:51:17
2026 -0500), so the tip delivery 2 graded is still the tip:

- Rows read from `git show origin/main:.coding-hermes/board/tasks.jsonl`: `QA-DUCKBRAIN-042`
  (pending), `QA-DUCKBRAIN-043` (pending), `DOC-26` (pending), `QA-DUCKBRAIN-036` (pending, annotated),
  `DOGFOOD-033` (pending, annotated). Nothing was closed or re-opened since the record commit.
- Paired creation events re-read from `origin/main:.coding-hermes/board/events.jsonl`:
  `8729 -> QA-DUCKBRAIN-042`, `8730 -> QA-DUCKBRAIN-043`, `8731 -> DOC-26`, all `task_created`.
- **No product file has moved since the record commit**:
  `git diff --stat ba735b46 HEAD -- src bin dist package.json` is EMPTY. The P1's liveness therefore
  stands at the same SHA delivery 2 proved it at (`src/cli/human.ts:577`, `input.prefix =
  flags.prefix`), and there is no product delta for a third fire to grade.

**Residue re-checked on the host, not inherited.** `bunker info faf390f4 --server bunker-mvp` ->
`not_found: agent "faf390f4" not found`: this tick still owns no install agent. `bunker list --server
bunker-mvp` shows every agent on a **shared** host network namespace (no tenant isolation by host
contract), unchanged from delivery 2. The foreign agent `c3a0807b` is **still running and now active**
— 3.9 GB, created `2026-11-17T12:46:21Z`, where delivery 2 measured it at 0 B; it is named in **no**
row on this board (`.coding-hermes/board/tasks.jsonl | grep -c c3a0807b` -> `0`) and appears only
inside this log's own delivery-2 prose. Left alone by rule: not this lane's, not destroyed.

**The two legs still UNVERIFIED, and why this fire did NOT re-attempt them** (unchanged verdicts, now
with the reason a worker can act on rather than a third deferral):

1. `search` at production scale — the honest arm is a query against a populated namespace, and the
   populated namespace here is the live production one; `DOGFOOD-010` (complete, P0) records that
   `?q=` over a real-data namespace aborts the daemon (`Map keys must be unique` -> SIGABRT). Probing
   production to prove a known crash class is a destructive arm, so it stays unmeasured at scale and
   the scoped 44-row non-reproduction (delivery 1: 8/8 clean, 398-656 ms) remains the only evidence.
2. auth / token / role surfaces — owned on THIS board by `SEC-AUTHZ-001` (pending, P1: "17/37 live
   tokens ADMIN via optional roles"). Grepped the committed board and it owns the surface, so a
   scratch-token walk by this lane would duplicate an existing row's ground; the run's `--auth=none`
   loopback scratch daemon was the correct scoping, not a withheld pass.

**PERF (Step 2b): no re-measure, and that is the honest outcome.** With `src/`, `bin/`, `dist/` and
`package.json` byte-identical between the measurement tip and HEAD, re-timing would reproduce delivery
1's numbers (warm medians 7.7 / 8.6 / 68.8 / 297 ms; 3546 ms first semantic query cold, the documented
AUG-096 warm-up) and no user would feel a difference. Delivery 1's `perf=no-finding` stands.

**writes made by this delivery:** this DELTA section and the appender script that wrote it
(`.coding-hermes/evidence/dogfood-2026-11-17/append_delta3.py`). No board row, no product file, no
config, no visibility or permission change. No id was minted this fire, so no id is reserved.
ch:trace tick=duckbrain-dogfood-2026-11-17-11-52-37 delivery=3 mode=duplicate-fire rows_filed=0 dispatches=3 provenance=verified@ba735b46 product-delta=none residue=faf390f4-destroyed foreign=c3a0807b-running-3.9GB withheld=search-at-scale,SEC-AUTHZ-001-ground perf=no-remeasure
"""

with P.open("a", encoding="utf-8") as fh:
    fh.write(TEXT)
print("appended", len(TEXT), "chars to", P)
