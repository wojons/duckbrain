# DuckBrain dogfood — 2026-11-08 HTTP API compatibility

Target: origin/main at 43c22c81191a0a1661c9acc3fc9617946f45e262 for the product probe; closeout documentation and board commits landed at origin/main 9480f00b3e03de1f71f464d367e0e750e637828e.

## Real-user path

Used an isolated scratch daemon with `--auth=none`, an isolated HOME/config, a fresh namespace, and a unique port. The sequence was:

1. `POST /api/namespaces` created `dogfood-realuse` (201).
2. `POST /api/memories?namespace=dogfood-realuse` stored a concept memory (201).
3. Exact-key GET returned the same UUID and content (200).
4. List and key-tree endpoints returned the memory (200).
5. `GET /api/memories?q=real%20user&namespace=dogfood-realuse` returned the memory with a highlighted match (200).
6. An invalid non-absolute key returned a structured validation error (400), not a server error.

The legacy compatibility path was also exercised literally:

`GET /api/search?namespace=dogfood-realuse&contains=real%20user`

returned 301 with `Location: /api/memories?q=`. The redirect discarded both the search term and namespace. This is filed as DF-2026-21, distinct from the completed keyword-index freshness work.

## Performance

On a one-memory scratch namespace, five warm exact-key reads and five warm list requests each measured approximately 0.01 seconds wall time per request. A cold daemon health request also completed at approximately 0.01 seconds after readiness. No user-noticeable performance issue was found and no PERF row was filed. A first timing script had a shell-formatting failure after the functional probes; that failed timing arm is not used as evidence.

## Fresh install

The bunker leg used `bunker-qa.sh launch` then `collect` against `/home/kara/duckbrain`. Evidence recorded fresh-install OK in 6 seconds with pnpm 12.4.2, tests OK with rc=0, Docker build OK, and compose configuration OK. The selected bunker was usable but reported shared network isolation, so the result is install-proven / isolation-UNVERIFIED, not an isolation-qualified pass. Agent 34b4e7d3 was eventually destroyed with the explicit run-owned `--force` cleanup after the first destroy correctly refused because two operator processes remained; a fresh census omitted the agent and `bunker info` returned not_found.

Evidence bundle: `/home/kara/.hermes/cache/scratch/duckbrain-dogfood-20261108-040652-run.out`, `/home/kara/.hermes/cache/scratch/duckbrain-dogfood-20261108-040652/`, and `/home/kara/.hermes/cache/scratch/duckbrain-dogfood-20261108-040652-bunker/`.
