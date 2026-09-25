# DuckBrain Integration — Native S3 Storage Tier, 2026-09-25

Run 11 of the dogfood series. Angle: the S3 flagship — every prior run probed
`s3 status` while the tier was disabled or absent; nobody had ever pushed,
restored, queried over the bucket, or shared memory between two hosts.

## Verdict: SHIPPABLE-ON-THIS-SURFACE for push/query/share; the DR promise fails at fresh-machine restore

What a user gets today, verified live against a real Hetzner bucket
(`duckbrain`, scratch prefix `duckbrain-dogfood-s3`, never prod data):

- **Autopush (manifest/JSONL tier)**: enable `s3.enabled` + `pushOnCommit`,
  write memories, and namespace JSONL partitions + `manifest.json` +
  `_audit/current.jsonl` land on S3 automatically after the 30s commit
  debounce. No cron, no manual push. Delta pushes are byte-exact: after
  writes 7–9, remote partitions grew to identical sizes (836/562/551/587 B)
  with local copies.
- **SQL over S3**: `duckbrain s3 query "SELECT … FROM read_json_auto('s3://…')"`
  returns real rows straight from the bucket, 3.6–3.9 s wall including DuckDB
  boot (~1 s user time; the rest is process start + httpfs GETs). No restore
  step. This is the killer feature and it just works on Hetzner.
- **Two-host shared memory, full round trip**: host A writes 9 → autopush →
  host B restores (create + pull) → B writes 11 more → push (uploaded=2,
  skipped=4) → A pulls (downloaded=2) → **A's already-running daemon served
  B's memories with no restart**. Shared memory over S3 is real.
- **Restore serves traffic**: booted a second daemon on the restored root;
  9/9 memories read back by id, prefix, and content; write-after-restore 201.
- **Safety commands**: `s3 clear --dry-run` lists exactly the 6 prefix
  objects without touching them; real `clear --yes --requested-by=… --reason=…`
  deleted 6/6 and left the bucket prefix empty. `s3 ghosts` lists state that
  outlives its namespace dir (read-only).

Where the promise breaks — **fresh-machine DR restore** (DF-0925-07, P1):

```
$ duckbrain s3 sync dfs3-journal pull        # on an EMPTY namespaces root
Error: Namespace not found: dfs3-journal
$ duckbrain s3 sync all pull                 # same empty root
[S3] pull complete: 0 namespaces, 0 files transferred   # exit 0 — silent!
$ duckbrain namespace create dfs3-journal    # the undocumented unlock
$ duckbrain s3 sync dfs3-journal pull        # now works (6 files, 4.6 s)
```

…and even then the namespace git repo is empty (`master` has no commits):
git history never travels through the pull path. Data survives; the
"version-controlled" half of multi-host memory does not.

## The working recipe (paste-ready, verified 2026-09-25)

```bash
# 0. one-time env: git-remote-s3 + awscli in a venv (see docs/guide/getting-started.md),
#    credentials via AWS_PROFILE — never in config.

# 1. enable the tier in duckbrain.config.json
#    "s3": { "enabled": true, "pushOnCommit": true, "intervalSec": 60,
#            "endpoint": "https://hel1.your-objectstorage.com",
#            "bucket": "duckbrain", "prefix": "<your-prefix>", "forcePathStyle": true }
#    → restart the daemon so autocommit picks up pushOnCommit.

# 2. write normally (REST/MCP/CLI). Commits + pushes happen on their own.
duckbrain s3 status                 # per-ns local/remote counts + lastSync

# 3. query the bucket without restoring (httpfs; s3_url_style=path + forcePathStyle for Hetzner)
duckbrain s3 query "SELECT key, domain FROM read_json_auto('s3://<bucket>/<prefix>/<ns>/concept/2026-09/current.jsonl')"

# 4. second host — data-only shared memory (NOT a full DR restore yet, see DF-0925-07)
duckbrain namespace create <ns>     # REQUIRED before first pull
duckbrain s3 sync <ns> pull
# ...boot a daemon on this root; writes need `s3 sync <ns> push` unless pushOnCommit is on
```

Isolation (scratch-on-real-bucket) that worked: dedicated `prefix`
(`duckbrain-dogfood-s3`) + `DUCKBRAIN_NAMESPACES_PATH`/`DUCKBRAIN_CONFIG_PATH`
to /tmp + `DUCKBRAIN_AUTH_FILE` scratch store + `AWS_PROFILE=duckbrain` only
in the scratch shells. Proven afterwards: prod auth md5 unchanged, 254 prod
namespaces untouched, scratch `s3 clear` emptied only its own prefix.

## Errors hit and what they taught

| Symptom | Cause | Lesson |
|---|---|---|
| 401 on every request with a "correct" token | mint output prints the full token once ABOVE a truncated `X-API-Key: be2bd2…0b2` example line | grep the `Generated API token:` line, not the example. A "token" CLI that doesn't re-print is fine; the example is the trap. |
| Auth store not seen by running daemon after second mint | auth store is read at boot (hot-reload only fires on change events per DF-0925-05) | mint all scratch tokens BEFORE starting the daemon. |
| `400 Invalid domain 'decision'` | domain enum is person\|event\|concept\|message\|config\|raw_note | the error message itself lists the values — good error design. |
| `s3 sync all pull` restoring nothing, exit 0 | pull enumerates LOCAL namespaces only | treat any DR restore with "0 namespaces" as a failure until proven otherwise. |
| Remote prefix had objects after first writes with no push run | `s3.enabled`+`pushOnCommit` autopushes JSONL/manifest from the daemon itself | autopush ≠ the git-mirror autopush (AUTOPUSH-001); the latter needs an `s3daily` remote per namespace (DF-0925-08). |

## Fresh-machine leg (ephemeral bunker, dedi-2 agent 8be0cc13, destroyed)

las-bunker-03 (the skill's default host) was down (ssh timeout) and las-02's
bunkerd was crash-looping (exit 1, auto-restart) — dedi-2 registered instead.
Bare Ubuntu 24.04 user, no node/pnpm, no git identity, no AWS creds:

- README quickstart verbatim: nvm node 22 → 7 s; corepack pnpm 12.4.2;
  clone from the README's public origin → 4 s; `pnpm install` → 10 s RC=0;
  health 503-degraded (expected), namespace create + write + read-back all
  green, stored content returned verbatim.
- Fresh-user S3 surface with no creds/config: `s3 status` → "S3 config:
  disabled", exit 0, no stack trace. Inert-by-default holds.
- Docs drift found on the fresh box: README says a global git identity is
  required; the daemon wrote fine without one (synthetic
  `duckbrain@localhost.localdomain` author — corroborates GIT-IDENTITY-001).
  See DF-0925-08.

Also noted for the foreman: on this HEAD, `DUCKBRAIN_AUTH_FILE=<fresh path>
token --name=x` CREATED the store (contradicts pending DF-0925-06 /
pitfall-20 note; possibly fixed or invocation-dependent).

## Measurements (Step 2b)

| Operation | Number | Conditions |
|---|---|---|
| REST POST write (warm) | 0.19 s mean (0.16–0.25, n=10) | :3797 restored-root daemon; includes embedding call — good |
| `s3 query` over bucket | 3.6 s cold / 3.9 s warm | incl. node+DuckDB boot ~2 s, rest httpfs GETs |
| First full pull (6 objects) | 4.6 s | empty root, after `namespace create` |
| Delta push | 1.6 s (uploaded=2 skipped=4) | single-ns sync |
| Autopush latency write→remote | ≤ ~60 s | 30 s debounce + interval gate (by design) |

Nothing here is slow enough to file a PERF row: user-visible latency is
either sub-second (writes) or bounded by documented debounce/interval
design. The heavyweight op (SQL over S3) is fast for its class.

## Cleanup performed

Scratch daemons stopped; scratch bucket prefix cleared via the product's own
`s3 clear` (6/6, failed=0); ephemeral bunker agent destroyed (note: destroy
needed a home-shrink first — bunkerd's destroy aborts when the pre-delete
home archive exceeds its own window; a >1 GB node_modules home is enough.
Infra-side, not a repo defect; TTL backstop unaffected).
