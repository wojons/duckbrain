# hermes-memory-provider — DuckBrain as Hermes' memory channel

Makes the DuckBrain ledger an **automatic** memory channel for Hermes instead of a
toolbox the model has to remember to open.

## Why

The ledger held the fleet's durable facts, but `~/.hermes/config.yaml` had
`memory.provider: ''`, so the only automatic channel was the injected
`MEMORY.md` file (19,945 / 20,000 chars). Every fact the agent "remembered"
came from that file; DuckBrain was reached only when the model chose to call an
MCP tool, which in practice meant it was written by cron and read by nobody.

## What it does

| Hook | Behaviour |
|---|---|
| `is_available()` | token file present + `GET /health` answers within 1.5 s |
| `initialize()` | resolves the namespace (`DUCKBRAIN_NAMESPACE`, else `agent_workspace`, else `hermes-memory`) |
| `system_prompt_block()` | one line telling the model the ledger is live and must be checked before asserting durable facts |
| `queue_prefetch()` | background thread → `GET /api/memories?namespace=…&q=…&limit=6`, cached per query (90 s TTL) |
| `prefetch()` | returns the cached pack, never blocks the turn |
| `on_pre_compress()` | hands the compressor a compact digest so the ledger state survives context compaction |
| `sync_turn()` | deliberately a **no-op** — durable writes stay with the foreman/cron sync (a per-turn writer is what produced 16k junk namespaces) |
| `get_tool_schemas()` | empty — the duckbrain MCP server already exposes the tool surface |

## Invariants

- **Fail open.** Every call is bounded (`DUCKBRAIN_TIMEOUT`, default 6 s) and every
  exception returns `""`. A dead DuckBrain must never block or break a turn.
- **Bounded pack.** 1,200 chars (`DUCKBRAIN_PACK_BUDGET`), 6 records, prefix
  guarantee — a pack that spills its cap silently loses the middle records.
- **Additive.** Hermes keeps the built-in provider active; this adds a second
  channel. `MEMORY.md` is not replaced.

## Install

```bash
cp -r plugins/hermes-memory-provider ~/.hermes/plugins/duckbrain
hermes config set memory.provider duckbrain
hermes memory status          # expect: Provider: duckbrain / available ✓
```

Takes effect for sessions started after the change (a running gateway picks it
up when it next constructs an agent). Cron sessions pass `skip_memory=True` by
design, so fleet ticks do not use the provider.

## Smoke test

```bash
/home/kara/.hermes/hermes-agent/venv/bin/python plugins/hermes-memory-provider/smoke_test.py
```

Expected: `available: True`, a `<duckbrain-recall>` pack of ~1,200 chars, a
`on_pre_compress` block of similar size, a fail-open empty string against a dead
port, and `stats()` with `failures: 0`.

## Known limits

- **Recall quality is unmeasured** (board row DF-2026-17): `q=cooldown` returns
  sync-status noise rather than doctrine, and `q=zzzznothinglikethis` returns
  three records. Until that gate exists, treat the pack as pointers to verify,
  not as truth.
- **Namespace drift** (DF-2026-15): 16,251 registry entries vs 955 directories,
  98.3 % of them `auger-pytest-*` residue. Recall is only as good as the
  namespace it is pointed at.
