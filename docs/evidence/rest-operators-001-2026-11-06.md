# REST-OPERATORS-001 — the table filter grammar, proven on a scratch daemon

**Status:** implemented and proven. Nothing here touches `:3000` or the
production namespaces; every HTTP line below is from a scratch daemon on
port **28741**, rooted in
`/home/kara/.hermes/cache/scratch/restops-proof-123652/namespaces`.

## What the row named, and what was done

1. The 25 PostgREST comparison operators now each carry a decision in
   `docs/api/http-api.md` (IMPLEMENTED / DELIBERATELY-ABSENT + reason / TODO).
2. `fts`, `plfts`, `isdistinct`, `is`, `ilike`, the `neq` synonym and the
   `not.` negation prefix are implemented in `src/duckdb/table-store.ts`, the
   single filter planner both the REST routes and the MCP `table_select` tool
   use.
3. An unknown operator is a `400 VALIDATION_ERROR` naming the operator, the
   closest supported operator and the full list — never a silent no-op.

## The falsifier: the same daemon binary BEFORE the change

`/home/kara/duckbrain` (= `origin/main` at 2471bf79) on port **28742**, same
scratch data directory, same requests:

```
PRE-FIX qty=gte.5                  500 {"code":"INTERNAL_ERROR","error":"Internal server error"}
PRE-FIX title=fts.hello            400 {"code":"VALIDATION_ERROR","error":"Unknown filter operator 'fts' (allowed: eq, ne, gt, gte, lt, lte, like, in)"}
PRE-FIX title=plfts.hello%20world  400 {"code":"VALIDATION_ERROR","error":"Unknown filter operator 'plfts' (allowed: eq, ne, gt, gte, lt, lte, like, in)"}
PRE-FIX qty=isdistinct.5           400 {"code":"VALIDATION_ERROR","error":"Unknown filter operator 'isdistinct' (allowed: eq, ne, gt, gte, lt, lte, like, in)"}
PRE-FIX qty=not.eq.5               400 {"code":"VALIDATION_ERROR","error":"Unknown filter operator 'not' (allowed: eq, ne, gt, gte, lt, lte, like, in)"}
PRE-FIX qty=gtq.5                  400 {"code":"VALIDATION_ERROR","error":"Unknown filter operator 'gtq' (allowed: eq, ne, gt, gte, lt, lte, like, in)"}
```

`gte.5` returning **500** is the finding behind the fix: a declared `int64`
column READS as canonical text (`readType`), so `"qty" >= ?::BIGINT` compared
VARCHAR with BIGINT and DuckDB refused the statement. `eq` hid the defect by
implicitly casting. The planner now casts the column to its DECLARED type
(`compareExpression`) for `eq`/`ne`/`neq`/`gt`/`gte`/`lt`/`lte`/`in`/`is`/
`isdistinct`, and to VARCHAR (`textExpression`) for `like`/`ilike`/`fts`/`plfts`.

## The scratch fixture

`opsproof` namespace, table `notes` (`id string, title string, qty int64,
flag boolean`):

```
r1 hello world       qty=5    flag=true
r2 world peace       qty=null flag=false
r3 goodbye moon      qty=5    flag=null
r4 helloworld        qty=9    flag=true      <- substring control for fts
r5 o'brien report    qty=1    flag=false     <- bound-parameter control
```

## The proof, pasted

```
scratch daemon: 200 health, data dir /home/kara/.hermes/cache/scratch/restops-proof-123652/namespaces
title=fts.hello              200 ["r1"]
title=like.%25hello%25       200 ["r1","r4"]
title=fts.hello,world        200 ["r1"]
title=fts.hello,moon         200 []
title=plfts.hello%20world    200 ["r1"]
title=plfts.moon%20world     200 []
qty=is.null                  200 ["r2"]
qty=isdistinct.5             200 ["r2","r4","r5"]
qty=eq.5                     200 ["r1","r3"]
qty=neq.5                    200 ["r4","r5"]
flag=is.true                 200 ["r1","r4"]
flag=is.false                200 ["r2","r5"]
flag=not.is.null             200 ["r1","r2","r4","r5"]
qty=not.eq.5                 200 ["r4","r5"]
qty=not.in.(5,9)             200 ["r5"]
qty=gte.5                    200 ["r1","r3","r4"]
qty=gt.5                     200 ["r4"]
qty=lt.5                     200 ["r5"]
qty=lte.5                    200 ["r1","r3","r5"]
qty=gte.10                   200 []
title=ilike.HELLO%25         200 ["r1","r4"]
-- unknown / malformed operators (400 must name operator + closest + list) --
qty=between.1                400 {"code":"VALIDATION_ERROR","error":"Unknown filter operator 'between' (closest supported: 'gte'); supported: eq, ne, neq, gt, gte, lt, lte, like, ilike, in, is, isdistinct, fts, plfts — prefix 'not.' negates any of them (e.g. not.eq.5)"}
qty=gtq.5                    400 {"code":"VALIDATION_ERROR","error":"Unknown filter operator 'gtq' (closest supported: 'gt'); supported: eq, ne, neq, gt, gte, lt, lte, like, ilike, in, is, isdistinct, fts, plfts — prefix 'not.' negates any of them (e.g. not.eq.5)"}
qty=is.maybe                 400 {"code":"VALIDATION_ERROR","error":"is. filter accepts null|true|false (PostgREST .is() values), got 'maybe'"}
title=fts.hello%26world      400 {"code":"VALIDATION_ERROR","error":"fts. terms are literal words on a JSONL store — boolean tsquery syntax ('&' in 'hello&world') is not interpreted; separate terms with commas and use 'not.' to negate the filter"}
title=fts.                   400 {"code":"VALIDATION_ERROR","error":"fts. filter requires at least one search term (e.g. fts.alpha,beta)"}
```

Every implemented operator appears with BOTH a matching and a non-matching
query. The two controls that matter:

- `fts.hello` → `["r1"]` while `like.%hello%` → `["r1","r4"]`: fts matches
  whole tokens, so the substring row is excluded (a `LIKE` shortcut would
  return it).
- `isdistinct.5` → `["r2","r4","r5"]` while `eq.5` → `["r1","r3"]`: a NULL
  column IS distinct from 5; equality can never express that.

## What is NOT proven here

- `fts`/`plfts` do **not** consult the namespace's `.search/fts.duckdb`
  memory index. That index is memory-record shaped (`id`, `content`, `key`,
  `attributes`), so a table column called `title` is not in it; routing a
  table filter into it would match rows by the wrong text. The filter is a
  predicate on the JSONL scan every table read already performs — no second
  index, no second scanner. Documented in `docs/api/http-api.md`.
- No stemmer: `report` does not match `reports`. A stemming index per table is
  a separate (unfiled) piece of work.
- The operator table covers PostgREST's 25 comparison operators; the
  `or=(...)` / `and=(...)` logical tree and embedded `select=table(*)` remain
  out of scope (SUPA-3 documents them as unsupported).
