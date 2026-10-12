# Traceability Doctrine

**Version:** 2.0.0 — repository-local doctrine for the `ch:trace` marker system.
**Effective:** 2026-10-12.
**Supersedes:** v1.0.0 (which invented evidence tiers, a close-out footer format, and example verdicts that exist nowhere in the repo); this version documents only observable practice. Every example below is quoted byte-for-byte from a real repo artifact, with its source named.

## Purpose

Every meaningful change carries a `ch:trace` marker that lets a reader reconstruct: **what** was done (row + spec anchor), **how** it was verified (test/evidence/witness), and **what was judged** (verdict + commit). A change without a marker has no auditable provenance and is treated as orphaned work.

This doctrine DESCRIBES existing practice; it does not define new conventions.

## The marker

A marker is a single line of space-separated `key=value` fields:

```
ch:trace row=<ID> [spec=<loc>] [wave=<manifest#step>] [test=<loc>] [doc=<path>] [prompt=<path>] [evidence=<loc>] [witness=<locator>|none:<reason>] [verdict=<id>|none:<reason>] [commit=<sha>|THIS] [memory=<key>|none]
```

Field grammar (all observed in repo markers):

- `row=` is the only mandatory field.
- Bracketed fields are optional; real markers include whichever apply. A minimal real marker from this repo carries just `row`, `evidence`, `witness`, `commit` (source: close event for row CI-2026-10-06-RED in `.coding-hermes/board/events.jsonl`).
- Values containing spaces are written unquoted (e.g. `witness=none:ephemeral host destroyed`) — markers are read by humans and by ad-hoc grep, not by a strict parser. Multi-part values are joined with `+` (e.g. `evidence=/tmp/intci028_sim.py+guard-20261007T231315`), and two checks in one field with `::` pairs (e.g. `test=resolve-links.py::broken-links+derive-surface.py::doc_hits`).
- A field may repeat: the wave-manifest form `"ch:trace": "row=DF-0924-10 row=DF-0926-05"` (`.coding-hermes/waves/duckbrain-foreman-2026-10-03-00-46-49.json`) marks one dispatch covering two rows.
- `ch:trace` and field names are lowercase; absence is signaled as `none:<reason>` (or bare `none:` where the reason follows as prose in the same value).

## Field definitions and rules

| Field | Carries | Rules | Real example (source) |
|---|---|---|---|
| `row` | Board task ID | Mandatory. Exactly one row per claim; repeat the field when one artifact closes several rows. | `row=DOC-14` (docs/audits/2026-10-11-doc14-rerun.md:172) |
| `spec` | What we promised: repo file + anchor, or `none:<context>` when the promised artifact does not exist yet | Anchor with `#`. The `none:` form is how a doctrine-gap row names its own missing target. | `spec=README.md#mcp-tools` (board row README-3, events.jsonl); `spec=none:target-repo-has-no-traceability-doctrine` (DOC-14 audit footer) |
| `wave` | Which dispatch produced this: wave/tick manifest + step | `<wave-name>#<step>`; step may be a re-evaluation suffix. | `wave=duckbrain-docs-2026-10-11-00-23-08#reevaluation` (DOC-14 audit footer) |
| `test` | The verification procedure: test file, `script::check` pairs, or a procedural description when nothing executable exists | Join multiple checks with `+`. `none::<reason>` when no procedure ran. | `test=src/cli/http.test.ts` (board row INT-CI-027, tasks.jsonl); `test=none::curl-timing` (docs/dogfood/2026-10-03-asof-integration.md:118) |
| `doc` | The repo document the work produced or updated | Repo-relative path. | `doc=README.md` (board row DF-0924-08, tasks.jsonl); `doc=docs/audits/2026-10-11-doc14-rerun.md` (DOC-14 audit footer) |
| `prompt` | The skill or prompt that guided the work, so it can be reproduced | Usually a `~/.hermes/skills/...` path. | `prompt=~/.hermes/skills/coding-hermes/coding-hermes-docs-audit/SKILL.md` (DOC-14 audit footer) |
| `evidence` | The artifact produced by the work: file, command output, or CI run id | Must be a concrete artifact, never another row/verdict/report by reference alone. May live outside the repo (`/tmp/...`) — say where it is. | `evidence=/tmp/intci028_sim.py+guard-20261007T231315` (board row INT-CI-028, tasks.jsonl); `evidence=CI-run-37503065734` (events.jsonl close event) |
| `witness` | An independent surface that confirms the evidence: a live endpoint, CI/origin state, or `none:<reason>` | See witness kinds below. Never leave bare `witness=` with no value. | `witness=live:curl-localhost:3987` (board row DF-0924-08, tasks.jsonl); `witness=none:static-source-help-parity` (DOC-14 audit footer) |
| `verdict` | What an independent judge ruled — or the finding id itself when the marker's own report is the judgement, or `none:<reason>` / `pending` when no judgement exists | Observed value forms: gitreins verdict id (`11227f2f-tier1`), row id (self-verdict: `verdict=DF-1003-01`), `none:<reason>` (`none:no-independent-judgement`, `none:tier2-evaluator-unavailable`), `pending`. | `verdict=11227f2f-tier1` (board row INT-CI-028, tasks.jsonl); `verdict=none:no-independent-judgement` (DOC-14 audit footer); `verdict=DF-1003-01` (docs/dogfood/2026-10-03-asof-integration.md:117) |
| `commit` | The commit that carries the traced work | Short or full sha; `THIS` when the marker sits inside the very commit/document it describes. Bind verdict to commit: a verdict about a commit that is not reachable from the published tip is not evidence of shipped state. | `commit=615c5f6` (board row INT-CI-028); `commit=THIS` (DOC-14 audit footer) |
| `memory` | Optional DuckBrain key for the narration record | `memory=none` is the common honest value; a real key accompanies — never replaces — the repo-local references above. | `memory=none` (board row INT-CI-028, tasks.jsonl) |

### Evidence vs witness

- **Evidence** is what the work produced: a file, a captured output, a run id. It lives somewhere pointable (repo, /tmp with the path spelled out, CI). Evidence is never another row, verdict, or report by reference alone — closing by reference is how claims outrun artifacts.
- **Witness** is an independent surface that confirms a claim about the world, not about our own output: `live:<endpoint>` (a probe answered), `http:<code>+<origin-run-ref>` (CI/origin state), a pushed commit id, or `tag:`/`path@origin:` forms.
- A claim about our own output cites `evidence=`; a claim about a running/shipped system cites `witness=`. When nothing verifiable exists, say so explicitly: `witness=none:<reason>` — e.g. `witness=none:ephemeral host destroyed, log content summarized here` (docs/dogfood/2026-10-03-asof-integration.md:119). Stated reason fine, silence not.

### Verdict binding

- `verdict=` cites a gitreins verdict id (short sha, optionally tier-suffixed: `verdict=11227f2f-tier1`) or `none:<reason>`.
- A verdict must bind to `commit=`. Citing a verdict whose evaluated commit is not on the published branch is a claim about a dead tree.
- Partial judgement is recorded as partial: `verdict=none:tier2-evaluator-unavailable` with the tier-1 id carried elsewhere in the record — tiers are never collapsed into a bare PASS.

## Close-out footer format

Markers appear in three observed placements:

1. **Bare last-line footer** of an audit/report doc (source: docs/audits/2026-10-11-doc14-rerun.md:172) — one full marker line as the document's final line.
2. **`## Traceability` section** at the end of a dogfood report (source: docs/dogfood/2026-10-03-asof-integration.md:115-120) — a heading followed by one `- ch:trace ...` list item per finding/row the report filed.
3. **Commit-message trailer** (source: `git log -1 --format=%B 881ef049`): the marker appears as the last trailer block before `Co-authored-by:`, e.g. `ch:trace row=DOC-6 spec=docs/guide/configuration.md#environment-variables evidence=/tmp/doc6-audit-after.txt verdict=pending memory=none:docs-only-change`.

There is no observed structured close-out footer (no STATUS/TIER/EVIDENCE block exists in any commit message or doc in this repo). Closing records live where they are observable: the marker (wherever placed) plus the board close event on `.coding-hermes/board/events.jsonl` — e.g. `{"event": "...-close", ..., "detail": "... ch:trace row=CI-2026-10-06-RED evidence=CI-run-37503065734 witness=http:200+github-wojons-duckbrain-runs-37503065734"}`.

## Maintenance rules

1. Markers travel with the work: same commit, or the immediately following close-out commit. A marker floating alone in an unrelated commit traces nothing.
2. If a file named in a marker moves, the marker moves with it.
3. `witness=` and `verdict=` are never left blank — `none:<reason>` is always available.
4. `memory=` never replaces repo-local references; cite only DuckBrain keys that resolve.
5. Multi-row work repeats `row=` rather than inventing a composite id.

## Conformance audit

Verify the repo's live markers against this doctrine with:

```
grep -RInE --exclude-dir=.git --exclude-dir=node_modules --exclude='*.db' --exclude='*.jsonl' 'traceability-doctrine|ch:trace' docs README.md AGENTS.md
```

(Note the `-E`: without it, plain `grep` treats `|` as a literal pipe and matches nothing — GNU BRE has no alternation.)

The acceptance criterion quotes the command without `-E`; with plain grep it silently scans nothing. Any audit that reports "0 markers found" from the plain form has audited an empty set, not a conforming one.
