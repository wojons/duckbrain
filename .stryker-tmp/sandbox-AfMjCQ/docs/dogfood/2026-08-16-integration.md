# DuckBrain Dogfood Integration Report — 2026-08-16

Real-use field test of DuckBrain as an AI-agent memory backend. This run used a
**real MCP client** (official `@modelcontextprotocol/sdk` 1.29.0, installed into
a scratch consumer project) plus REST/CLI/Web-UI exercises, all against an
isolated scratch instance. It re-verified the 2026-08-07 fixes and found a new
**P0 crash** in semantic search. Companion records: `diagnostics.md`
(how it works, what broke, the right way) and the 08-07 report.

## 1. Setup (the safe way)

```bash
mkdir -p /tmp/dogfood-duckbrain-0816/ns
# scratch config: same as production but isolated paths + S3 disabled
python3 - <<'EOF'
import json
c = json.load(open('/home/kara/duckbrain/duckbrain.config.json'))
c['namespacesPath'] = '/tmp/dogfood-duckbrain-0816/ns'
c['defaultNamespace'] = 'dogfood-0816'
c['namespaceMappings'] = {'default': '/tmp/dogfood-duckbrain-0816/ns/default'}
c['s3'] = {'enabled': False}
json.dump(c, open('/tmp/dogfood-duckbrain-0816/config.json', 'w'), indent=1)
EOF
DUCKBRAIN_CONFIG_PATH=/tmp/dogfood-duckbrain-0816/config.json \
  node bin/duckbrain.js http --port 3123
```

Health: `GET /health` → `{"status":"healthy",...}` (NOT `/api/health` — that 404s).

## 2. MCP stdio with a real SDK client (the headline integration)

Consumer project: `/tmp/dogfood-duckbrain-0816/consumer` with
`npm install @modelcontextprotocol/sdk@1.29.0`. Connect via `StdioClientTransport`
spawning `node bin/duckbrain.js stdio` with `DUCKBRAIN_CONFIG_PATH` in env.

**Tool list (12):** recall, remember, list_keys, forget, squash,
get_compaction_stats, create_namespace, list_namespaces, switch_namespace,
delete_namespace, server_status, server_http_start.

### The exact schemas that WORK (verified round 4, all isError=false)

```js
// WRITE — note: the content field is embedding_text, NOT content (MCP only;
// REST uses content). attributes is required ({} ok). If you omit namespace,
// the write goes to the STICKY active namespace (persisted across processes!).
remember({ key: '/clean/db', domain: 'concept',
           embedding_text: 'Redis cache in front of PostgreSQL',
           attributes: { tier: 'prod' }, namespace: 'clean-ns' })
// → { success: true, id, key, partition: 'concept/2026-08/', author }

// READ — exact key / prefix / semantic
recall({ key: '/clean/db', namespace: 'clean-ns' })
recall({ prefix: '/clean', namespace: 'clean-ns' })
recall({ query: 'caching database layer', namespace: 'clean-ns' })
// → memories[] with score on semantic results (0.74-0.77 for true matches)

// DELETE — forget takes the memory UUID (get it from recall), not the key
forget({ id: '<uuid>', reason: '...', namespace: 'clean-ns' })
// → { success: true, id, tombstoned: true }; recall then hides it

// NAMESPACES — delete requires explicit confirmation
create_namespace({ name: 'clean-ns' })            // git-inits the repo
delete_namespace({ name: 'clean-ns', confirm: true })  // files + git repo gone
```

### Errors I hit that were MY mistakes (docs were right)

- `remember` with `content:` → `-32602 ... expected string, received undefined at embedding_text` (hit 4/4 times before reading `docs/api/mcp-tools.md`).
- `forget({ key })` → `-32602 ... at id` (forget needs the UUID).
- `delete_namespace({ name })` → `-32602 ... at confirm` (needs `confirm: true`).
- Omitting `namespace` on remember after a previous session called
  `switch_namespace` → writes landed in that sticky namespace, silently.
  **Always pass `namespace` explicitly.**

## 3. What's fixed since 2026-08-07 (verified live)

| Finding | Status 2026-08-16 |
|---|---|
| DOGFOOD-001 `?q=` dropped → now forwards to semantic search | ⚠️ Forwards, but see P0 crash below (DOGFOOD-010) + no threshold (DOGFOOD-011) |
| DOGFOOD-002 silent semantic failure → isError=true + provider fallback | ✅ Error surfaced (`isError=true` with detail); fallback to ollama attempted (404s — no embedding model there) |
| DOGFOOD-003 CLI remember no content → `--content` works | ✅ Verified: content persisted, recall shows it |
| DOGFOOD-004 delete_namespace left data → now requires `confirm: true` and removes files + git repo | ✅ Verified (dir gone after delete) |
| DOGFOOD-005 implicit namespaces no git | ✅ Namespaces created via create_namespace get git + auto-commit (3 commits observed) |
| DOGFOOD-009 cryptic list-keys | ✅ Tree output (`Keys (5 total): /cli-test/ ...`) |
| GAP-029 s3 CLI usage | ✅ `s3 --help` prints usage, `s3 bogus` exits 1 |

## 4. New findings (task IDs on the board)

1. **DOGFOOD-010 (P0) — semantic search crashes the production daemon.**
   Every `GET /api/memories?q=` on the live :3000 daemon killed it:
   `terminate called after throwing an instance of 'duckdb::InvalidInputException'
   what(): {"exception_type":"Invalid Input","exception_message":"Map keys must be unique."}`
   → SIGABRT → systemd restart (5 restarts in ~2 min). Reproduced on two
   namespaces. Plain (no-q) requests fine. A scratch daemon with 155 memories
   doesn't crash but **hangs >60s** on `?q=`. Semantic search is effectively
   unusable with real data. Until fixed: **do NOT use `?q=` / `query=` on the
   live daemon.**
2. **DOGFOOD-011 (P1) — no relevance threshold.** `?q=zzznothing` returned all
   4/4 memories. Ranking works; filtering doesn't.
3. **DOGFOOD-012 (P1) — usage SKILL stale** (claims `?q=` works — it crashes;
   claims CLI remember is content-less — it isn't; missing `embedding_text`,
   forget-by-id, delete confirm).
4. **DOGFOOD-013 (P1) — `server_http_start` broken** in standard setup
   (spawns `/bin/duckbrain.ts` via cwd-relative root resolution; child dies
   silently; port never opens).
5. **DOGFOOD-014 (P2) — `get_compaction_stats` always zeros** (hardcodes
   legacy `cwd/.duckbrain/namespaces/default`, ignores config).
6. **DOGFOOD-015 (P2) — `server_status` instance-blind** (reports port 3000 /
   live pidfile from a scratch-config process).
7. **DOGFOOD-016 (P2) — temp-db files accumulate** on every spawn/crash;
   stale socket pidfiles left behind.
8. **DOGFOOD-017 (P2) — sticky active namespace + no namespace echo in
   remember response** → silent wrong-namespace writes.

## 5. Verified-good recipes (use these)

- **CLI write with content:** `duckbrain remember /notes/alpha --domain=raw_note --content='body' --namespace=my-ns`
- **Embeddings warm-up:** `duckbrain embeddings rebuild --namespace=my-ns` (cold semantic recall embeds on the fly and can be slow/fail on first hit).
- **Semantic search:** only after `embeddings rebuild`, and only on the scratch/small namespaces until DOGFOOD-010 lands.
- **Isolated testing:** `DUCKBRAIN_CONFIG_PATH` (config file) + `DUCKBRAIN_NAMESPACES_PATH` (runtime override) — never point tests at the live daemon's namespaces (80+ fleet namespaces in production use).
