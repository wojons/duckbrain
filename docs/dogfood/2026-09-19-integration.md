# DuckBrain Integration Report — Dogfood 2026-09-19

Real-use run on an isolated scratch deployment + ephemeral-bunker fresh
install. This report documents what works, what bit, and the exact recipes
that were verified live. Board rows from this run: DF-0919-01 … DF-0919-06.

## What was tested (and passed)

Environment: repo @ fa21811 (feat/native-s3), scratch daemon on :3999 with
DUCKBRAIN_NAMESPACES_PATH, DUCKBRAIN_CONFIG_PATH, and DUCKBRAIN_AUTH_FILE
all pointed at /tmp (zero contact with production data). Token dogfood0919
granted to two namespaces only.

- Namespace create POST /api/namespaces — 201, data dir + git repo created
- Write memory (REST) — 201 with UUID, author stamped from token name
- Exact-key read — 200, content round-trips
- Prefix list + key tree GET /api/keys — 200, readable JSON tree
- Semantic search ?q= (lmstudio qwen3-embedding) — 200, ~7s cold incl.
  provider probe, keyword-leg highlightedSnippet fallback works
- Token scoping — write to ungranted ns = 403 Forbidden; missing key = 401
- MCP over HTTP — tools/list requires Accept: application/json,
  text/event-stream (else empty); remember needs embedding_text + attributes;
  forget by UUID works
- CLI remember/recall/forget — work; forget --namespace=<non-default> NOW
  WORKS (DOGFOOD-0904-01 fix verified in source at human.ts:668)
- SSE change feed (SUPA-5) — duckbrain.ready.v1, heartbeats, then
  duckbrain.change.v1 with dbch1 cursor after the git commit lands (~30s)
- Validity windows — valid_until honored: hidden from current view, visible
  via ?historical=true (camelCase trap: DF-0919-05)
- Git-backed durability — auto-commit lands within ~30-40s of writes

## Verified pitfalls (new this run)

1. /health 503 with all active providers healthy — a keyless (never
   configured) openai provider counts as unhealthy and drags the aggregate
   to degraded. Writes and recall all work. DF-0919-04.
2. validUntil camelCase silently dropped — only valid_until reaches the
   schema; a memory written with the wrong spelling is silently kept
   forever. DF-0919-05.
3. Outside-default warning noise — "Memory written outside default
   namespace" fires even on explicit ?namespace= writes. DF-0919-06.

## Fresh-install truth (ephemeral bunker, las-bunker-03)

Verified 2026-09-19 on a clean Debian user (agent 7649b92c, destroyed after):
node 22.23.2, git 2.47.3, nothing else preinstalled.

Working recipe (what the README should say):

    # node 22 present; get pnpm WITHOUT sudo:
    mkdir -p ~/.local/bin && corepack enable pnpm --install-directory ~/.local/bin
    export PATH="$HOME/.local/bin:$PATH"     # pnpm 12.4.2 via corepack

    git clone https://github.com/wojons/duckbrain.git ~/app && cd ~/app

    pnpm install --frozen-lockfile           # DF-0919-01: on a fresh store this
                                             # leaves express unlinked, boot fails.
                                             # Known-good workaround:
    pnpm add express@5.2.1                   # relinks; boot then succeeds

    # pnpm build is BROKEN on fresh clones (DF-0919-02): packages/ui/tsconfig.json
    # has baseUrl, removed in TS7 (TS5102). Skip the UI build; the backend runs
    # from src via tsx.

    node bin/duckbrain.js http --port 3000 &
    curl -s localhost:3000/health            # 503 degraded is EXPECTED fresh (DF-0919-04)

    # README quickstart (verbatim, works):
    curl -s -X POST localhost:3000/api/namespaces -H 'Content-Type: application/json' \
      -d '{"name":"quickstart"}'
    curl -s -X POST 'localhost:3000/api/memories?namespace=quickstart' \
      -H 'Content-Type: application/json' \
      -d '{"key":"/quickstart/hello","domain":"concept","content":"first memory from the quickstart"}'
    curl -s 'localhost:3000/api/memories/key/quickstart/hello?namespace=quickstart'
    # -> 201 / 201 / 200 with stored content (verified on the bunker)

Timings: install 60s, express relink <1s, daemon boot <5s, quickstart
end-to-end ~10s after the workaround.

## Verdict

PROMISING-BUT-ROUGH. The memory engine itself (write/read/forget/streams/git
history) is solid and pleasant to integrate — every API contract in the usage
skill held. The fresh-machine path is the weak leg: two install breakers
(DF-0919-01/02) stand between a new user and a running daemon, and the health
signal lies to fresh users (DF-0919-04). All are small, named fixes.
