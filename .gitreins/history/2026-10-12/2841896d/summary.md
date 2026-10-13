# Verdict: DOC-16

**Task:** Document complete MCP recall input surface
**Evaluated:** 2026-10-12T01:33:07.417808
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ docs/api/mcp-tools.md documents every field in RecallInputSchema (src/mcp/tools/recall.ts:50-170): key, id, keyPrefix, domain, author, query, contains, limit, offset, namespace, allNamespaces, after, before, between, asOf, attr, historical — with defaults, mutual exclusions, examples: docs/api/mcp-tools.md (commit 066bfba3, +195 lines) contains a 'Field reference' table (lines 150-170) listing all 17 fields with Type/Default/Description: key, id, keyPrefix, domain, author, query, contains, limit (default 10), offset (default 0), namespace (default active namespace), allNamespaces (default false), after, before, between, asOf, attr, historical (default false). A mutual-exclusions table (lines ~183-189) documents between+after/before refused, asOf+query/contains refused, query+contains refused, allNamespaces without contains refused, allNamespaces+namespace refused, key→id→keyPrefix→domain precedence, and after>before refused. Examples (lines 195-350) cover keyPrefix, domain, key, id, author, namespace, query, contains, allNamespaces, combined, after/before, between, paging offset, limit:0 count-only, attr, historical, and asOf. Verified against src/mcp/tools/recall.ts:50-170 schema (defaults .default(10)/.default(0), optional booleans, exclusion logic at lines 532-538 and 601-607) — docs match code. Test suite (npx vitest run) timed out at 30s; this is a docs-only change with no code modified. [resolution 0.24; docs/api/mcp-tools.md, src/mcp/tools/recall.ts:50-170]
docs/api/mcp-tools.md fully documents all 17 RecallInputSchema fields with defaults, mutual exclusions, and examples, matching the source schema.

## Summary

Judge Result: DOC-16

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ docs/api/mcp-tools.md documents every field in RecallInputSchema (src/mcp/tools/recall.ts:50-170): key, id, keyPrefix, domain, author, query, contains, limit, offset, namespace, allNamespaces, after, before, between, asOf, attr, historical — with defaults, mutual exclusions, examples: docs/api/mcp-tools.md (commit 066bfba3, +195 lines) contains a 'Field reference' table (lines 150-170) listing all 17 fields with Type/Default/Description: key, id, keyPrefix, domain, author, query, contains, limit (default 10), offset (default 0), namespace (default active namespace), allNamespaces (default false), after, before, between, asOf, attr, historical (default false). A mutual-exclusions table (lines ~183-189) documents between+after/before refused, asOf+query/contains refused, query+contains refused, allNamespaces without contains refused, allNamespaces+namespace refused, key→id→keyPrefix→domain precedence, and after>before refused. Examples (lines 195-350) cover keyPrefix, domain, key, id, author, namespace, query, contains, allNamespaces, combined, after/before, between, paging offset, limit:0 count-only, attr, historical, and asOf. Verified against src/mcp/tools/recall.ts:50-170 schema (defaults .default(10)/.default(0), optional booleans, exclusion logic at lines 532-538 and 601-607) — docs match code. Test suite (npx vitest run) timed out at 30s; this is a docs-only change with no code modified. [resolution 0.24; docs/api/mcp-tools.md, src/mcp/tools/recall.ts:50-170]
docs/api/mcp-tools.md fully documents all 17 RecallInputSchema fields with defaults, mutual exclusions, and examples, matching the source schema.

Overall: PASS ✓
