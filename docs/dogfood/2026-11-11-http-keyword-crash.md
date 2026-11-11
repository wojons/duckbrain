# DuckBrain dogfood — 2026-11-11 HTTP keyword search

Target: `fa6bb86f7abca3869ee51f310fc8e76b62709f0a` (`origin/main`, parity 0/0).
Canonical checkout: `/home/kara/duckbrain`. The supplied dogfood stand-in is not a Git root; the scheduler row resolves to the canonical checkout.

## Real-use path

A clean no-auth scratch daemon was built from a no-hardlinks clone with isolated HOME/config, port 3198, and namespace `dogfood`. The sequence was:

1. `POST /api/namespaces` — HTTP 201.
2. `POST /api/memories?namespace=dogfood` — HTTP 201, UUID returned, anonymous author applied.
3. Exact-key read — HTTP 200 with identical UUID/content.
4. Plain list and key-tree reads — HTTP 200.
5. Documented offline keyword fallback: `GET /api/memories?namespace=dogfood&contains=dogfood`.

The keyword request returned curl rc 52 with no HTTP response. The daemon log printed `*** stack smashing detected ***: terminated` and the process died. The same daemon had answered the plain list request successfully immediately before it. This is a fresh reproduction of the existing `README-19` mechanism at the newer published HEAD, so the recurrence was filed as `README-19-R2`, not as a bare sibling.

Evidence: `/home/kara/.hermes/cache/scratch/duckbrain-dogfood-20261111-045853/artifacts/http-probes.txt` and `run/daemon.log`.

## CLI path

With a separate isolated HOME, `remember /cli/dogfood --namespace=dogfood --domain=concept --content='CLI dogfood memory'` returned rc 0. `recall --namespace=dogfood --prefix=/cli/` returned rc 0 but printed both the `/cli/dogfood` row and the unrelated `/dogfood/real-use` row; the output says `Found 2 memories`. The source path shows `normalizeSpaceFormFlags` only normalizes `--namespace` and `--as-of`, while the CLI input construction does not add `prefix` to the request after selecting prefix mode. This overlaps the existing pending `DB-8` API-ergonomics row, so no duplicate was filed.

## Performance

Successful user-visible timing on the scratch daemon, `hyperfine --warmup 3 --runs 10`:

- Warm `GET /health`: mean 8.93 ms, σ 1.14 ms, range 7.60–10.94 ms, all 10 exit 0.
- Warm exact-key read: mean 15.51 ms, σ 1.44 ms, range 12.83–17.86 ms, all 10 exit 0.
- Cold daemon start until health success: mean 445.47 ms, σ 64.70 ms, range 369.67–539.35 ms, all 5 exit 0.

Nothing in the successful local path was user-noticeably slow, so no PERF row was filed and no profile was justified. The keyword crash is a correctness/availability finding, not a timing result.

## Fresh-machine install leg

`bunker-mvp` was directly reachable and `bunkerd` was active. `bunker-qa.sh launch` started agent `20808aa1`; collection was attempted repeatedly with the same explicit server/evidence path. The battery remained RUNNING at closeout and the agent was left intact because destroying a running battery would erase evidence. Harvested cells: toolchain bootstrap OK, fresh-install OK (pnpm 12.4.2, 5.9s), tests OK (rc 0), docker build OK, compose config OK, and lint N/A because the repo declares no lint trigger. The host reports shared network mode, so isolation is unverified. This is not `SKIPPED-install-bunker`; the host and install path were usable, but the battery was incomplete at closeout.

Raw evidence: `/home/kara/.hermes/cache/scratch/duckbrain-dogfood-20261111-045853/bunker/evidence.jsonl`; launch/collect transcripts are beside it. Agent `20808aa1` remains running on `bunker-mvp` for later collection/teardown by the owning lane.

No product code, visibility, permissions, credentials, or scheduler state were changed.
