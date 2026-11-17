#!/usr/bin/env python3
"""Append this tick's diagnostics section to docs/dogfood/diagnostics.md (append-only)."""
import pathlib

P = pathlib.Path("/home/kara/duckbrain/docs/dogfood/diagnostics.md")
TEXT = """
## Run 21 — 2026-11-17 scoped reads across three surfaces (and the one that lies)

This run asked a single question three ways: *"what do we know under a key prefix?"* The REST and MCP
answers were right, the CLI answer was the whole namespace, and the difference turned out to be one
field name — which is the useful lesson, because the CLI is the surface an agent is most likely to shell
out to and the least likely to double-check.

**How a CLI verb actually reaches the store, and where the filter is lost.** The `recall` verb does not
query DuckDB directly: it parses argv into a tool input, hands that object to the in-process `recall`
tool (the same implementation the MCP server exposes), and renders the tool's result. The tool's schema
names the prefix filter `keyPrefix`; the CLI builds `{mode:"prefix", prefix:"…"}`. An unknown field in
that object is not an error — it is dropped — so the tool runs its default query (everything) and the
CLI prints `Found 44 memories` for a namespace where the prefix matched 9. Two lessons:
1. **An argument that is silently ignored is worse than one that is rejected.** A 400 naming
   `keyPrefix` would have cost the user one call; the silent drop cost a wrong answer that looked like
   an answer.
2. **The CLI tells you the answer if you read stderr.** Every verb logs
   `Tool called with input: {…}` and `Validated input: {…}`; diffing those two objects is the fastest
   way to find a filter that never arrived. That diff is how this run attributed the defect in one
   step instead of guessing at the query layer.

**Why REST and MCP were right.** Both take the prefix under a name the tool validates
(`?prefix=` on the HTTP route is mapped into `keyPrefix` before the call; the MCP client sends
`keyPrefix` directly), so the same SQL path that returned 9 rows for them returned 44 for the CLI. The
storage layer was never the problem — do not start debugging DuckDB from a symptom like this one.

**`list-keys` hides leaves on purpose, but never says so.** The resolver forces `maxDepth: 3` and the
renderer prints directory nodes only once a level is deeper than that. A prefix that matches nine leaf
keys therefore renders as `Keys (9 total):` followed by two directory names. The count is honest; the
absence is silent. The CLI exposes no depth flag (the MCP tool does), and `list-keys --help` runs the
listing rather than printing usage — so a user has no way to discover either behaviour from the tool.
When you need the leaves today, use `GET /api/memories?prefix=…` (returns full rows) rather than
enumerating with the CLI.

**The validity window has two shapes and only one works.** `valid_until` / `valid_from` are top-level
record fields; the recall layer reads them there and hides expired/future facts from the current view
(`?historical=true` shows them). The same names stored inside `attributes` are ordinary attributes —
inert, never consulted, no warning. The controlled five-fact matrix (current / expired / future, each
in both shapes) is in `.coding-hermes/evidence/dogfood-2026-11-17/validity-probe.jsonl`; it reads
3 current vs 5 historical, with the attribute-carried rows visible in both views. If you are writing an
expiring fact, put the window at the top level of the record.

**Durability, verified the cheap way.** The whole corpus survived a daemon kill + relaunch on the same
store: 43 current rows, the tombstone still applied, `--as-of=<pre-forget commit>` still returned the
forgotten fact. `git -C <namespacesPath>/<ns> log` remains the fastest persistence check — one
`chore: auto-commit namespace data` commit per batching window, and the tombstone appended to the same
partition file rather than rewriting it.

**What this run did NOT prove.** `search` ran clean eight times in a row (398–656 ms, rc=0) on a 44-row
namespace, where the earlier aborts were observed on namespaces with tens of thousands of files. That is
a scoped non-reproduction, not a refutation of README-19-R3/R4: the abort is heap-related and
size-dependent, and this run deliberately did not rebuild a production namespace's index to chase it.
"""
with P.open("a", encoding="utf-8") as f:
    f.write(TEXT)
print(f"appended {len(TEXT)} chars; file now {P.stat().st_size} bytes")
print("heading count:", sum(1 for ln in P.read_text(encoding="utf-8").splitlines() if ln.startswith("## Run 21")))
