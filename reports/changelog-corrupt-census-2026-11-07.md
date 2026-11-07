# CHANGELOG_CORRUPT census — production namespace root (2026-11-07)

HARDEN-DUCKBRAIN-007 AC-1/AC-2. Read-only scan of every git-backed namespace
under `/home/kara/duckbrain/namespaces` using the shipped replay derivation
(`deriveCommitChanges`, `src/http/realtime/replay.ts`) over each namespace's full
first-parent history, oldest commit first. No commit, checkout, index write or file
write inside any namespace: the tool reads git objects only.

## Totals

- namespaces scanned: **196** (skipped: 0)
- commits derived: **96086**
- namespaces that cannot replay their full history: **135**
- commits that fail derivation: **17403**
- namespaces fully clean: **61**
- derivation errors (non-corrupt): **0**

## Failure classes

| class | commits | meaning |
|---|---|---|
| `malformed-change-record` | 17346 | accepted audit line matches a change-record marker but fails `ChangeRecordSchema` — in this census every instance is a **pre-2026-10-06 legacy row-image record** (`row` present, no `contentHash`/`targetPath`/`tombstone`/`schemaVersion`) |
| `unresolvable-row-image` | 56 | hash-format record whose `contentHash` matches no line in the committed target at child **or** parent — the orphan change-record class HARDEN-DUCKBRAIN-006 stops for NEW records |
| `malformed-ledger-line` | 1 | an added `_audit` line is not valid JSON |

## Orphan change records (the HARDEN-DUCKBRAIN-007 decision)

- **ci** — 56 corrupt commit(s), all `unresolvable-row-image`;
  first offender commit `31c2a249a4a2` at 2026-11-03T15:50:30-05:00, ledger `_audit/current.jsonl` line 282,
  target `tables/trigger.jsonl`; namespace HEAD `af5be4321918`. Every offending commit predates the
  HARDEN-DUCKBRAIN-006 fix (6021185b, 2026-11-06): the records are committed history, so 006 cannot heal them.

## Legacy row-image records (filed as HARDEN-DUCKBRAIN-008)

134 namespaces, 17346 commits.
cb55f40c (SCHED-GAP-1574, 2026-10-06) replaced the record's `row` image with `contentHash` and stated
that "pre-existing ledgers replay without migration"; `ChangeRecordSchema` has required `contentHash`
since, so every accepted record written before that commit fails derivation.

## Per-namespace counts (corrupt only)

| namespace | corrupt commits | commits | classes | first offender |
|---|---|---|---|---|
| scheduler | 5707 | 20223 | malformed-change-record:5707 | 2026-09-16 _audit/10001.jsonl:1 |
| pokemon-global | 3193 | 3231 | malformed-change-record:3193 | 2026-09-19 _audit/current.jsonl:1 |
| coding-hermes | 842 | 7020 | malformed-change-record:842 | 2026-09-16 _audit/current.jsonl:117 |
| fleet-quality | 826 | 2900 | malformed-change-record:826 | 2026-09-16 _audit/1102.jsonl:2 |
| infra | 562 | 1464 | malformed-change-record:562 | 2026-09-17 _audit/current.jsonl:91 |
| bunker | 425 | 1631 | malformed-change-record:425 | 2026-09-16 _audit/current.jsonl:100 |
| crier | 326 | 1446 | malformed-change-record:325, malformed-ledger-line:1 | 2026-09-16 _audit/current.jsonl:161 |
| axiom | 284 | 666 | malformed-change-record:284 | 2026-09-17 _audit/current.jsonl:59 |
| default | 273 | 3481 | malformed-change-record:273 | 2026-09-17 _audit/current.jsonl:79 |
| h3 | 255 | 1582 | malformed-change-record:255 | 2026-09-18 _audit/current.jsonl:1 |
| hermes-canopy | 248 | 1285 | malformed-change-record:248 | 2026-09-16 _audit/current.jsonl:142 |
| hermes-telemetry | 242 | 879 | malformed-change-record:242 | 2026-09-16 _audit/0746.jsonl:2 |
| duckbrain | 200 | 951 | malformed-change-record:200 | 2026-09-16 _audit/current.jsonl:113 |
| off-by-one | 198 | 1366 | malformed-change-record:198 | 2026-09-16 _audit/current.jsonl:119 |
| qa | 195 | 1094 | malformed-change-record:195 | 2026-09-17 _audit/current.jsonl:24 |
| chimera-v2 | 176 | 1087 | malformed-change-record:176 | 2026-09-17 _audit/current.jsonl:100 |
| terminal-jail | 171 | 1070 | malformed-change-record:171 | 2026-09-16 _audit/current.jsonl:89 |
| 9router | 149 | 810 | malformed-change-record:149 | 2026-09-17 _audit/current.jsonl:20 |
| heading | 140 | 922 | malformed-change-record:140 | 2026-09-16 _audit/current.jsonl:9 |
| warpfs | 140 | 881 | malformed-change-record:140 | 2026-09-16 _audit/current.jsonl:100 |
| task-router | 129 | 688 | malformed-change-record:129 | 2026-09-16 _audit/current.jsonl:94 |
| trouble | 128 | 292 | malformed-change-record:128 | 2026-09-16 _audit/current.jsonl:1 |
| eduos | 110 | 787 | malformed-change-record:110 | 2026-09-16 _audit/current.jsonl:126 |
| hermes-memory | 107 | 3343 | malformed-change-record:107 | 2026-09-16 _audit/current.jsonl:571 |
| gitreins | 104 | 696 | malformed-change-record:104 | 2026-09-16 _audit/current.jsonl:110 |
| auger | 103 | 254 | malformed-change-record:103 | 2026-09-20 _audit/current.jsonl:1 |
| consensus | 98 | 938 | malformed-change-record:98 | 2026-09-23 _audit/current.jsonl:1 |
| ai-plays-poke | 88 | 651 | malformed-change-record:88 | 2026-09-23 _audit/current.jsonl:1 |
| dexdat-core | 85 | 1179 | malformed-change-record:85 | 2026-09-24 _audit/current.jsonl:1 |
| mafia-benchmark | 83 | 664 | malformed-change-record:83 | 2026-09-24 _audit/current.jsonl:1 |
| deepseek-payg | 80 | 248 | malformed-change-record:80 | 2026-09-16 _audit/current.jsonl:53 |
| hermes-dagger | 77 | 2774 | malformed-change-record:77 | 2026-09-16 _audit/current.jsonl:5 |
| reports | 76 | 279 | malformed-change-record:76 | 2026-09-17 _audit/current.jsonl:58 |
| apocalyptic | 74 | 450 | malformed-change-record:74 | 2026-09-18 _audit/current.jsonl:18 |
| boardctl | 72 | 224 | malformed-change-record:72 | 2026-09-16 _audit/current.jsonl:61 |
| dexdat-memory | 68 | 883 | malformed-change-record:68 | 2026-09-23 _audit/current.jsonl:1 |
| hivemind-work | 67 | 734 | malformed-change-record:67 | 2026-09-23 _audit/current.jsonl:1 |
| muster | 67 | 1090 | malformed-change-record:67 | 2026-09-24 _audit/current.jsonl:1 |
| hermes-agent | 66 | 230 | malformed-change-record:66 | 2026-09-17 _audit/current.jsonl:50 |
| ci | 56 | 121 | unresolvable-row-image:56 | 2026-11-03 _audit/current.jsonl:282 |
| lore | 55 | 148 | malformed-change-record:55 | 2026-09-23 _audit/current.jsonl:1 |
| logsey | 54 | 141 | malformed-change-record:54 | 2026-09-23 _audit/current.jsonl:1 |
| asce | 52 | 733 | malformed-change-record:52 | 2026-09-21 _audit/current.jsonl:1 |
| blog | 52 | 257 | malformed-change-record:52 | 2026-09-17 _audit/current.jsonl:55 |
| digest | 49 | 152 | malformed-change-record:49 | 2026-09-23 _audit/current.jsonl:1 |
| pulse | 49 | 167 | malformed-change-record:49 | 2026-09-23 _audit/current.jsonl:1 |
| frontiers-ghost | 46 | 477 | malformed-change-record:46 | 2026-09-16 _audit/current.jsonl:54 |
| Hermes DAGger | 45 | 175 | malformed-change-record:45 | 2026-09-16 _audit/current.jsonl:55 |
| jnsq | 42 | 101 | malformed-change-record:42 | 2026-09-17 _audit/current.jsonl:25 |
| temporal-vector-index | 40 | 276 | malformed-change-record:40 | 2026-09-18 _audit/current.jsonl:57 |
| obsidian | 37 | 855 | malformed-change-record:37 | 2026-09-17 _audit/current.jsonl:67 |
| tatara | 35 | 137 | malformed-change-record:35 | 2026-09-25 _audit/current.jsonl:1 |
| python-audit-security | 33 | 33 | malformed-change-record:33 | 2026-09-27 _audit/current.jsonl:1 |
| coding-hermes-scheduler | 30 | 427 | malformed-change-record:30 | 2026-09-18 _audit/current.jsonl:1 |
| python-audit-deadcode | 30 | 30 | malformed-change-record:30 | 2026-09-27 _audit/current.jsonl:1 |
| python-audit-lint | 30 | 30 | malformed-change-record:30 | 2026-09-27 _audit/current.jsonl:1 |
| h3-sdk-typescript | 29 | 533 | malformed-change-record:29 | 2026-09-18 _audit/current.jsonl:1 |
| monitoring | 29 | 161 | malformed-change-record:29 | 2026-09-28 _audit/current.jsonl:1 |
| python-audit-typing | 29 | 29 | malformed-change-record:29 | 2026-09-27 _audit/current.jsonl:1 |
| python-audit-complexity | 28 | 28 | malformed-change-record:28 | 2026-09-27 _audit/current.jsonl:1 |
| sdk-python | 26 | 430 | malformed-change-record:26 | 2026-09-18 _audit/current.jsonl:1 |
| sdk-go | 22 | 358 | malformed-change-record:22 | 2026-09-18 _audit/current.jsonl:1 |
| h3-umbrella | 19 | 55 | malformed-change-record:19 | 2026-09-18 _audit/current.jsonl:1 |
| qa-audit | 19 | 105 | malformed-change-record:19 | 2026-10-01 _audit/current.jsonl:1 |
| chat-archive | 17 | 92 | malformed-change-record:17 | 2026-09-17 _audit/current.jsonl:30 |
| chat-summaries | 17 | 86 | malformed-change-record:17 | 2026-09-17 _audit/current.jsonl:7 |
| coding-hermes-tools | 16 | 100 | malformed-change-record:16 | 2026-09-17 _audit/current.jsonl:1 |
| mischief | 16 | 134 | malformed-change-record:16 | 2026-09-28 _audit/current.jsonl:1 |
| guard | 11 | 84 | malformed-change-record:11 | 2026-10-01 _audit/current.jsonl:1 |
| mccli | 10 | 10 | malformed-change-record:10 | 2026-09-22 _audit/current.jsonl:1 |
| skills | 8 | 1248 | malformed-change-record:8 | 2026-09-17 _audit/current.jsonl:358 |
| x6printer | 7 | 8 | malformed-change-record:7 | 2026-10-06 _audit/current.jsonl:1 |
| fleet-monitoring | 6 | 24 | malformed-change-record:6 | 2026-09-27 _audit/current.jsonl:1 |
| helix | 5 | 539 | malformed-change-record:5 | 2026-10-02 _audit/current.jsonl:1 |
| wojons-mythos | 5 | 770 | malformed-change-record:5 | 2026-09-19 _audit/current.jsonl:3 |
| auger-df-registers | 4 | 4 | malformed-change-record:4 | 2026-09-23 _audit/current.jsonl:1 |
| auger-df7-scale | 4 | 4 | malformed-change-record:4 | 2026-09-24 _audit/current.jsonl:1 |
| df5-real | 4 | 4 | malformed-change-record:4 | 2026-09-23 _audit/current.jsonl:1 |
| dogfood8 | 4 | 4 | malformed-change-record:4 | 2026-09-24 _audit/current.jsonl:1 |
| gitreins-poc | 4 | 241 | malformed-change-record:4 | 2026-09-18 _audit/current.jsonl:1 |
| test-isolation | 4 | 4 | malformed-change-record:4 | 2026-09-16 _audit/current.jsonl:1 |
| deepseek-dashboard | 3 | 427 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| df6-regress | 3 | 3 | malformed-change-record:3 | 2026-09-24 _audit/current.jsonl:1 |
| duckbrain-sync | 3 | 3 | malformed-change-record:3 | 2026-09-17 _audit/current.jsonl:1 |
| escalation-doctrine | 3 | 381 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| hermes4friends-infra | 3 | 336 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| imhotep | 3 | 1392 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| kobayashi-maru | 3 | 1729 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| musterflow | 3 | 553 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| rabbit-hole | 3 | 657 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| ratelimit-probe | 3 | 3 | malformed-change-record:3 | 2026-09-24 _audit/current.jsonl:1 |
| rethinkdb | 3 | 374 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| speclang | 3 | 674 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| stand-in-pm | 3 | 124 | malformed-change-record:3 | 2026-09-16 _audit/current.jsonl:70 |
| temple-runner | 3 | 76 | malformed-change-record:3 | 2026-10-02 _audit/current.jsonl:1 |
| aug074wprobe | 2 | 2 | malformed-change-record:2 | 2026-09-26 _audit/current.jsonl:1 |
| df9 | 2 | 2 | malformed-change-record:2 | 2026-09-25 _audit/current.jsonl:1 |
| eduos.dexdat.com.co | 2 | 751 | malformed-change-record:2 | 2026-09-20 _audit/current.jsonl:5 |
| foreman | 2 | 2 | malformed-change-record:2 | 2026-09-28 _audit/current.jsonl:1 |
| hivemind | 2 | 496 | malformed-change-record:2 | 2026-09-27 _audit/current.jsonl:1 |
| mcview | 2 | 2 | malformed-change-record:2 | 2026-09-22 _audit/current.jsonl:1 |
| sch1669-proof-verify | 2 | 2 | malformed-change-record:2 | 2026-09-28 _audit/current.jsonl:1 |
| scratch-a | 2 | 2 | malformed-change-record:2 | 2026-09-24 _audit/current.jsonl:1 |
| watson-ent | 2 | 18 | malformed-change-record:2 | 2026-09-30 _audit/current.jsonl:1 |
| Hermes Dagger | 1 | 2 | malformed-change-record:1 | 2026-09-27 _audit/current.jsonl:1 |
| anime | 1 | 1 | malformed-change-record:1 | 2026-09-20 _audit/current.jsonl:1 |
| aug030-repro-a079ab1142 | 1 | 1 | malformed-change-record:1 | 2026-09-23 _audit/current.jsonl:1 |
| aug030-verify-480a769e6b | 1 | 1 | malformed-change-record:1 | 2026-09-24 _audit/current.jsonl:1 |
| aug030-verify-none-cfad153a | 1 | 1 | malformed-change-record:1 | 2026-09-24 _audit/current.jsonl:1 |
| aug036-ctl2-d01bd9ffce1d | 1 | 1 | malformed-change-record:1 | 2026-09-23 _audit/current.jsonl:1 |
| auger-092-probe | 1 | 1 | malformed-change-record:1 | 2026-09-30 _audit/current.jsonl:1 |
| auger-aug059-710b2b4d | 1 | 1 | malformed-change-record:1 | 2026-09-29 _audit/current.jsonl:1 |
| auger-df9-w1a | 1 | 1 | malformed-change-record:1 | 2026-09-25 _audit/current.jsonl:1 |
| auger-df9-w1phase | 1 | 1 | malformed-change-record:1 | 2026-09-25 _audit/current.jsonl:1 |
| auger-doccheck-a7465f0f | 1 | 1 | malformed-change-record:1 | 2026-09-26 _audit/current.jsonl:1 |
| auger-docnote-fa89a817 | 1 | 1 | malformed-change-record:1 | 2026-09-26 _audit/current.jsonl:1 |
| auger-probe-1790205758 | 1 | 1 | malformed-change-record:1 | 2026-09-23 _audit/current.jsonl:1 |
| auger-probe-1790287737 | 1 | 1 | malformed-change-record:1 | 2026-09-24 _audit/current.jsonl:1 |
| auger-review-20260927 | 1 | 1 | malformed-change-record:1 | 2026-09-27 _audit/current.jsonl:1 |
| auger_uxprobe | 1 | 1 | malformed-change-record:1 | 2026-09-27 _audit/current.jsonl:1 |
| cache-eviction-choice | 1 | 1 | malformed-change-record:1 | 2026-09-24 _audit/current.jsonl:1 |
| df5-smoke2 | 1 | 1 | malformed-change-record:1 | 2026-09-23 _audit/current.jsonl:1 |
| df7-dur | 1 | 1 | malformed-change-record:1 | 2026-09-24 _audit/current.jsonl:1 |
| eval-aug004-1790112886 | 1 | 1 | malformed-change-record:1 | 2026-09-22 _audit/current.jsonl:1 |
| eval-aug004-absent-1790112891 | 1 | 1 | malformed-change-record:1 | 2026-09-22 _audit/current.jsonl:1 |
| foreman-status | 1 | 1 | malformed-change-record:1 | 2026-09-28 _audit/current.jsonl:1 |
| mafia-ai-benchmark | 1 | 213 | malformed-change-record:1 | 2026-09-29 _audit/current.jsonl:1 |
| quickstart | 1 | 2 | malformed-change-record:1 | 2026-09-17 _audit/current.jsonl:1 |
| quickstart-readme | 1 | 1 | malformed-change-record:1 | 2026-10-04 _audit/current.jsonl:1 |
| readme-audit-tick | 1 | 1 | malformed-change-record:1 | 2026-10-03 _audit/current.jsonl:1 |
| releng-smoke-0929 | 1 | 1 | malformed-change-record:1 | 2026-09-29 _audit/current.jsonl:1 |
| rm-audit-1003 | 1 | 1 | malformed-change-record:1 | 2026-10-03 _audit/current.jsonl:1 |
| test-aug092 | 1 | 1 | malformed-change-record:1 | 2026-09-30 _audit/current.jsonl:1 |
| test-workflow | 1 | 1 | malformed-change-record:1 | 2026-09-26 _audit/current.jsonl:1 |
| workflowtest | 1 | 1 | malformed-change-record:1 | 2026-09-26 _audit/current.jsonl:1 |

## Reproduce

```bash
pnpm exec tsx scripts/changelog-corrupt-census.ts --root ./namespaces \
  --jobs 14 --commit-shards 10 --samples 5 --json /tmp/census.json
```

`--jobs` shards namespaces across processes, `--commit-shards` splits one namespace's
history into concurrent ranges (needed for `scheduler`: 20,223 commits, ~0.5 s/commit on
its recent half). The merged report is identical to a serial whole-history run; two runs
over a quiescent tree are byte-identical.
