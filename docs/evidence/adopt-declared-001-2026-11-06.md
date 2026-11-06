# ADOPT-DECLARED-001 — declaration over HTTP, proven on a scratch daemon

**Date:** 2026-11-06 · **Checkout:** `d0264bd4` (+ this proof) · **Script:**
`scripts/proofs/adopt-declared-001.sh` (re-runnable; every failure is a FAIL
line and a nonzero exit).

The claim under test is not "a route exists" — it is that an **agent** with an
API key can create the table it wants to write to, without a shell on the box,
and that the declaration lands through the same core the CLI and MCP use. An
in-process route test cannot show that (it never boots the binary), and a route
that works only in a test harness has proven nothing about the daemon, so the
proof drives `node bin/duckbrain.js http` on scratch ports 28771-28773 with
scratch namespaces roots under `~/.hermes/cache/scratch/`. Port 3000 and the
production data directory are never touched.

## Transcript

```
$ ADOPT_SCRATCH=~/.hermes/cache/scratch/adopt-proof bash scripts/proofs/adopt-declared-001.sh
ADOPT-DECLARED-001 proof — 2026-11-06T08:07:05Z
checkout : /home/kara/proj-wt-adopt-declared-001 (d0264bd4)
scratch  : /home/kara/.hermes/cache/scratch/adopt-proof

== 1. FIXED TREE: declare, insert, read ==
    daemon up: /home/kara/proj-wt-adopt-declared-001 on :28771
    POST /api/ns/agent-e2e/tables/readings/declare → HTTP 201
    {"namespace":"agent-e2e","table":"readings","path":"…/namespaces-28771/agent-e2e/schema.json","format":"schema.json","replacedExisting":false,"declaration":{"name":"readings","format":"jsonl-objects","columns":[{"name":"id","type":"double","declaredType":"float64","nullable":false,"hasDefault":false},{"name":"device","type":"varchar","declaredType":"string","nullable":true,"hasDefault":false},{"name":"temp","type":"double","declaredType":"float64","nullable":true,"hasDefault":false}],"primary":"id","glob":"tables/readings/current.jsonl","declaredKeyColumns":["id"],"schemaVersion":1,"source":"schema.json"}}
PASS: declare answered 201 and wrote schema.json
    POST /api/ns/agent-e2e/tables/readings → HTTP 201 {"inserted":1}
PASS: row insert accepted
    GET  /api/ns/agent-e2e/tables/readings → HTTP 200 [{"id":1,"device":"probe-a","temp":21.5}]
PASS: the row declared over HTTP is readable over the REST data verbs
    GET  /metrics →
      duckbrain_table_declaration_namespaces{format="schema.json"} 1
      duckbrain_table_declaration_namespaces{format="legacy"} 0
      duckbrain_table_declarations{format="schema.json"} 1
      duckbrain_table_declarations{format="legacy"} 0
PASS: adoption gauge moved with the HTTP declaration (schema.json 1 / legacy 0)

== 2. AUTHZ: no key 401, ungranted table 403, granted table 201 ==
    daemon up: /home/kara/proj-wt-adopt-declared-001 on :28772 (--auth=apikey)
    no api key, declare draft → HTTP 401 {"error":"Unauthorized: API key required"}
PASS: unauthenticated declare refused (401)
    proof-writer (tableGrants: draft) declares sneaky → HTTP 403 {"error":"Forbidden: principal 'proof-writer' has no write grant for table 'sneaky'","code":"FORBIDDEN"}
PASS: per-table write grant enforced on declaration (403, names the table)
    proof-writer declares draft (granted) → HTTP 201 {"namespace":"agent-e2e","table":"draft",…,"format":"schema.json",…}
PASS: granted token can declare its table
PASS: the refused declaration left nothing on disk

== 3. PRE-FIX CONTROL: same request against d0264bd4^ ==
    pre-fix tree: d630aa05
    daemon up: /home/kara/.hermes/cache/scratch/adopt-proof/pre-fix on :28773
    POST declare on the pre-fix daemon → HTTP 404 {"error":"Route POST /api/ns/agent-e2e/tables/readings/declare not found","code":"ROUTE_NOT_FOUND"}
PASS: control: the route does not exist before this change (404 ROUTE_NOT_FOUND)

RESULT: PASS — declare-over-HTTP works end to end on a real daemon, is grant-gated, and the control 404s.
```

## What each half rules out

| Observation | What it rules out |
|---|---|
| declare 201 with `"format":"schema.json"`, then insert 201, then GET 200 returning the row | the route is not a stub: the declaration is loadable and immediately servable by the data verbs on a real daemon |
| unauthenticated declare → 401 | the verb is not an auth bypass |
| token with `tableGrants: {draft}` declaring `sneaky` → 403 naming the table, and `sneaky` absent from `schema.json` | declaring is a WRITE and honours the per-table grant model rather than only the namespace grant |
| the same token declaring `draft` → 201 | the 403 above is not an artefact of the token being unusable |
| `/metrics` adoption gauges `schema.json 1 / legacy 0` after the HTTP declaration | the new adoption counter tracks reality (it was 0/0 before the declare on the same daemon) |
| pre-fix daemon (commit `d630aa05`) answers 404 `ROUTE_NOT_FOUND` | the proof is not passing on something the tree already had — the falsifier is executable |

## Not proven here

- **No production token was minted.** The authz run uses a scratch auth file;
  the live daemon's token population was out of scope (and SEC-AUTHZ-001 owns
  the live grant migration).
- **`GET /api/ns/:ns/openapi.json` does not list the new route yet** — the
  generated document still describes only the data verbs. Filed as a gap in the
  row note; it is a documentation surface, not a behaviour.
- **The legacy population is unmigrated by design.** The shape decision and the
  per-table recipe live in `docs/decisions/ADOPT-DECLARED-001-declaration-shape.md`;
  the migration is owner-gated and filed as DECLARE-MIGRATE-001.
