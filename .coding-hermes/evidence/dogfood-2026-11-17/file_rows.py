#!/usr/bin/env python3
"""File this tick's dogfood findings on the duckbrain JSONL board via boardctl.

Ids come from ~/.hermes/scripts/board_next_id.py (minted this tick, verified free).
Every field is passed as its own argv element: no shell, no quoting failure mode.
Never edits existing rows.
"""
import json, subprocess, sys, pathlib

BOARD = "/home/kara/duckbrain/.coding-hermes/board"
ROOT = "/home/kara/duckbrain"

ROWS = [
    {
        "id": "QA-DUCKBRAIN-042",
        "type": "bug",
        "priority": "P1",
        "complexity": "3",
        "title": ("P1 — CLI `recall --prefix=<p>` silently returns the WHOLE namespace: the prefix "
                  "never reaches the recall tool (44/44 rows vs 9 on REST and MCP)"),
        "reasoning": (
            "Dogfood 2026-11-17, scratch daemon :3391, 44-memory namespace `alpha` over 5 key prefixes.\n"
            "REPRO: `duckbrain recall --namespace=alpha --prefix=/team/roster/ --limit=100` prints\n"
            "`Found 44 memories:` and lists /handoffs/*, /infra/*, /sprint/*, /team/*. A prefix that cannot\n"
            "exist (`--prefix=/definitely/not/here/`) ALSO prints 44. Both are rc=0 with no warning.\n"
            "A/B on the same data: `GET /api/memories?namespace=alpha&prefix=/team/roster/` -> 9 items;\n"
            "REST with the nonexistent prefix -> 0 items; MCP `recall {keyPrefix:'/team/roster/'}` -> 9 items.\n"
            "MECHANISM (stderr from the CLI itself):\n"
            "  [recall] Tool called with input: {\"namespace\":\"alpha\",\"limit\":100,\"mode\":\"prefix\",\"prefix\":\"/team/roster/\"}\n"
            "  [recall] Validated input: { limit: 100, offset: 0, namespace: 'alpha' }\n"
            "The parsed prefix is dropped before the tool call; the recall tool's MCP schema names that field\n"
            "`keyPrefix` (verified via tools/list) and silently ignores an unknown `prefix`, so the query runs\n"
            "unfiltered instead of erroring. Fix point: the recall command's tool-input assembly in\n"
            "src/cli/human.ts (send keyPrefix for mode=prefix) AND the recall tool's arg parsing (reject or\n"
            "alias unknown fields rather than answering with the whole store).\n"
            "Why P1: an agent asking 'what do we know about /team/roster/' receives every memory in the\n"
            "namespace as if it were the answer — a silent wrong answer, not an error."
        ),
        "acceptance": (
            "On a scratch namespace holding 44 memories across 5 prefixes:\n"
            "1. `node bin/duckbrain.js recall --namespace=<ns> --prefix=/team/roster/ --limit=100` prints\n"
            "   `Found 9 memories` and every printed `key` starts with `/team/roster/`.\n"
            "2. `--prefix=/definitely/not/here/` prints `Found 0 memories`.\n"
            "3. Both keep returning 9/0 after a daemon restart, and in the space form too\n"
            "   (`--prefix /team/roster/`).\n"
            "4. A test asserts the object handed to the recall tool carries the prefix under the field name\n"
            "   the tool validates (`keyPrefix`), so a rename cannot silently unfilter the query again."
        ),
        "tags": "cli,recall,prefix,filter,silent-wrong-answer,dogfood-2026-11-17",
    },
    {
        "id": "QA-DUCKBRAIN-043",
        "type": "bug",
        "priority": "P2",
        "complexity": "2",
        "title": ("P2 — `list-keys --prefix=<p>` says `Keys (9 total)` but prints no key under that prefix, "
                  "and `list-keys --help` runs the listing instead of printing usage"),
        "reasoning": (
            "Dogfood 2026-11-17, scratch namespace `alpha` (44 keys).\n"
            "1) RENDERER: `duckbrain list-keys --namespace=alpha --prefix=/team/roster/` prints\n"
            "`Keys (9 total):` and then only the two directory nodes `/team/` and `/team/roster/`. The nine\n"
            "leaves the total counts are not printed, and nothing says deeper keys are hidden. The stderr\n"
            "line shows the resolver forcing `maxDepth: 3`, and the CLI exposes no depth/leaf flag\n"
            "(the MCP list_keys tool does take maxDepth/limit; the CLI has no equivalent).\n"
            "2) USAGE: `duckbrain list-keys --help` exits 0 and PRINTS THE 44-KEY LISTING (no usage block),\n"
            "the same missing-guard class as DB-GAP-029 (s3 --help), DB-GAP-034 (token --help) and\n"
            "HTTP-HELP-001 (http --help) — this verb is a new instance, not covered by them.\n"
            "Impact: an agent that enumerates memory structure cannot discover the keys under a prefix it\n"
            "already knows about; it gets a count that implies it did."
        ),
        "acceptance": (
            "1. `list-keys --prefix=/team/roster/` prints the nine leaf keys under that prefix (or, if it\n"
            "   keeps the tree view, an explicit `+9 keys under /team/roster/` line and a documented flag\n"
            "   that expands them).\n"
            "2. The depth/leaf control works in BOTH `--flag value` and `--flag=value` form and is listed in\n"
            "   the help output.\n"
            "3. `list-keys --help` exits 0, prints a usage block, and prints zero keys."
        ),
        "tags": "cli,list-keys,renderer,help,dogfood-2026-11-17",
    },
    {
        "id": "DOC-26",
        "type": "task",
        "priority": "P3",
        "complexity": "1",
        "title": ("P3 — agent-facing docs call the validity window 'attributes', but an attributes-carried "
                  "valid_until is inert: only top-level valid_from/valid_until filters recall"),
        "reasoning": (
            "Dogfood 2026-11-17, fresh namespace `beta`, five facts: current, expired, future, and the same\n"
            "expired/future pair written with the window INSIDE `attributes`.\n"
            "Measured: `GET /api/memories?namespace=beta` (current view) returned 3 rows — current,\n"
            "expired-attr, future-attr — i.e. both windowed facts stayed visible; the two rows carrying\n"
            "TOP-LEVEL valid_until/valid_from were correctly hidden. `?historical=true` returned all 5.\n"
            "So the mechanism works, but only for the top-level shape, while docs/agentic-memory-roadmap.md:50\n"
            "calls valid_from/valid_until 'write-side attributes', and skills/duckbrain-usage/SKILL.md:130\n"
            "(the primary guide per AGENTS.md) says 'Paired with valid_from/valid_until on writes' without\n"
            "saying they are top-level record fields. docs/api/http-api.md:571 is the only page that is\n"
            "explicit. An agent following the roadmap stores an inert attribute and its expired fact is\n"
            "recalled as current forever — the exact failure the window exists to prevent, with no warning\n"
            "on write.\n"
            "Fix direction: say TOP-LEVEL record fields in both docs, add a copy-paste write example, and\n"
            "(optionally) warn on write when valid_from/valid_until appear inside attributes."
        ),
        "acceptance": (
            "1. docs/agentic-memory-roadmap.md and skills/duckbrain-usage/SKILL.md state that\n"
            "   valid_from/valid_until are top-level fields of the memory record and show a write example\n"
            "   that does not nest them in attributes.\n"
            "2. The example in the docs is reproduced verbatim against a scratch daemon: the expired row is\n"
            "   absent from `GET /api/memories` and present with `?historical=true`.\n"
            "3. Neither doc contains a sentence that sends the reader to attributes for the validity window."
        ),
        "tags": "docs,validity-window,retr-011,dogfood-2026-11-17",
    },
]


def run(argv):
    p = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)
    print(f"$ {' '.join(argv[:4])} ... rc={p.returncode}")
    if p.stdout.strip():
        print("  out:", p.stdout.strip()[:400])
    if p.stderr.strip():
        print("  err:", p.stderr.strip()[:400])
    return p.returncode


for r in ROWS:
    rc = run(["boardctl", "-C", BOARD, "create",
              "--id", r["id"], "--title", r["title"], "--type", r["type"],
              "--priority", r["priority"], "--complexity", r["complexity"],
              "--reasoning", r["reasoning"], "--acceptance-criteria", r["acceptance"],
              "--capability-tags", r["tags"], "--status", "pending"])
    print(f"  -> {r['id']} rc={rc}")
