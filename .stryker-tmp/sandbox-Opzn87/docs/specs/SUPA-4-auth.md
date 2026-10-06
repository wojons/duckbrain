# SUPA-4 — Roles + Auth Types: Multi-Role Grants × Pluggable Auth Backends

- **Board row:** DB-SUPA-4 (P1, complexity 2)
- **Spec row:** DB-SUPA-9 (SPEC SET A)
- **Status:** pending implementation — contract for the build
- **Reference:** owner directive 2026-09-03 (multi-user, multi-role, different auth types); DB-GAP-031 per-token namespace grants
- **Companion specs:** `docs/specs/SUPA-2-serialization.md` (audit + role checks before enqueue), `docs/specs/SUPA-3-rest.md` (per-table grants on table routes)

## Problem Statement

DuckBrain's auth model has identities but no roles. `AuthConfig` (`src/auth/middleware.ts:31-38`) supports three types — `none`, `basic`, `apikey` — and `ApiKeyEntry` (`src/auth/middleware.ts:17-26`) carries a name and optional namespace grants (DB-GAP-031). Every token with a namespace grant is all-powerful *inside* that namespace: there is no distinction between a reader and a writer, no per-table restriction, no expiry, and no revocation path short of editing the store and restarting (the store is read once at server startup, `src/cli/http.ts:270-298`). API keys are stored **plaintext** in the auth store. Raw SQL, when it exists, would be available to anyone with a token, with no role opt-in and no caps. Denials are not audited.

SUPA-4 generalizes the model: four roles (`admin`/`writer`/`analyst`/`uploader`) with a pinned grant matrix over resources (tables/files/sql), per-table grants within a namespace, token lifecycle (hash-at-rest, expiry, revocation), a pluggable auth-backend interface (the three shipped types today; OIDC behind the same interface under its own board row), and a raw-SQL per-role opt-in flag behind timeout/memory/row caps. Every denial is audited.

## Acceptance Criteria

### Contract: roles and the grant matrix

`export type Role = "admin" | "writer" | "analyst" | "uploader";` (lowercase only; unknown role strings fail store validation at load).

Resources and actions: `tables.read`, `tables.write`, `files.read`, `files.upload`, `sql.read` (raw SELECT), `sql.write` (mutating raw SQL). `sql.read`/`sql.write` are **flag-gated for every role** — a role grant alone never opens raw SQL; the per-principal `sql` flags below must also be set. Defaults:

| Role | tables.read | tables.write | files.read | files.upload | sql.read flag (default) | sql.write flag (default) |
|---|---|---|---|---|---|---|
| `admin` | ✓ | ✓ | ✓ | ✓ | on | off |
| `writer` | ✓ | ✓ | ✗ | ✗ | off | off |
| `analyst` | ✓ | ✗ | ✓ | ✗ | on | off |
| `uploader` | ✓ (registry/metadata rows) | ✗ | ✓ | ✓ | off | off |
| unauthenticated | — | — | — | — | — | — |

The unauthenticated row: when an auth type other than `none` is active, a request without valid credentials is rejected `401` before any grant evaluation — there is no anonymous role. When `config.type === "none"` (local single-user mode), no principal is attached and no grant check runs (`requireNamespaceGrant` pass-through at `src/auth/middleware.ts:229`); that mode is unchanged.

**Precedence rules:** (1) `admin` bypasses per-table grants (full access within its namespace scope). (2) For non-admin roles, an explicit `tableGrants` map on the principal **restricts** the role default: when `tableGrants` is present, a table missing from it is denied (`403`) even if the role default allows `tables.write`. (3) A principal with multiple roles holds the union of their grants. (4) Namespace scope is orthogonal and unchanged from DB-GAP-031: `namespaces` undefined = unrestricted, present = only listed namespaces.

### Contract: token lifecycle and store shape

Auth store: `~/.duckbrain/auth.json` by default (`defaultAuthStorePath`, `src/cli/http.ts:92`), redirected by `--auth-file` / `DUCKBRAIN_AUTH_FILE` (`resolveAuthStorePath`, `src/cli/http.ts:111`). The store gains a Zod schema (`AuthStoreSchema`, new export in `src/auth/storeSchema.ts`); a store file failing validation fails server startup loudly.

```ts
ApiKeyEntry {
  keyHash: string;            // "$sha256$" + 64 hex chars of sha256(key); never the plaintext
  name: string;               // identity stamped on writes (principalAuthorEmail mapping unchanged)
  namespaces?: string[];      // DB-GAP-031 semantics unchanged
  roles?: Role[];             // absent = legacy token, see AC-9
  tableGrants?: Record<string, "read" | "write" | "rw">;   // per-table restriction within ns scope
  expiresAt?: string;         // ISO-8601; absent = never expires
  sql?: { read?: boolean; write?: boolean; maxRows?: number; maxMemoryBytes?: number; timeoutMs?: number };
}

UserEntry { username: string; passwordHash: string; roles?: Role[]; namespaces?: string[]; expiresAt?: string; }
```

**Hash-at-rest:** every key is stored as `$sha256$<hex>`. Lookup hashes the presented `X-API-Key` header and compares digests (constant-time compare). Keys are high-entropy by construction (provisioning generates ≥ 32 hex chars, 128 bits), so an unsalted sha256 digest is the pinned scheme. **Legacy migration:** on store load, an entry whose `key` lacks the `$sha256$` prefix is a legacy plaintext entry: it is matched in plaintext for the request that presents it, then rewritten to `keyHash` in the store file (one-time, atomic write) — plaintext never persists past the first successful use, and the migration is itself logged.

**Expiry:** `expiresAt` is compared to the server clock after a successful credential match; expired → `401` with `code: "TOKEN_EXPIRED"`. The server clock is authoritative; no client-supplied time is trusted.

**Revocation:** removing an entry from the store revokes it. The apikey/basic backends stat the store file's mtime on every request and reload when it changed, so revocation takes effect on the next request — no restart, no revocation list artifact.

### Contract: auth backend interface

`export interface AuthBackend { readonly type: "none" | "basic" | "apikey"; authenticate(req: Request): Promise<AuthPrincipal | null>; }`

`authMiddleware` (`src/auth/middleware.ts:94`) is refactored internally to select the backend for `config.type` and delegate; the public behavior of the three shipped types is unchanged except for the enriched principal and the hash-at-rest lookup. `AuthPrincipal` (`src/auth/middleware.ts:46`) gains: `roles?: Role[]`, `tableGrants?: Record<string, "read"|"write"|"rw">`, `tokenType?: "basic" | "apikey"`, `expiresAt?: string`. New grant middlewares, exported from `src/auth/middleware.ts`:

```ts
requireRole(...roles: Role[]): RequestHandler;                                   // 403 when principal lacks every listed role
requireTableGrant(getNs: (req) => string, getTable: (req) => string, op: "read" | "write"): RequestHandler;
```

Both audit every denial (below). `requireNamespaceGrant` (`src/auth/middleware.ts:224`) is unchanged.

**Raw-SQL role flag contract:** a raw-SQL endpoint (separate route, owned by the raw-SQL work) authorizes a request only when ALL of: (a) principal role grants `sql.read` or `sql.write` per the matrix, (b) the principal's `sql` flags enable the corresponding direction (`read` default on for admin/analyst, `write` default off for every role), and (c) the principal's namespace scope includes the target namespace. The executor enforces the caps: `timeoutMs` (default 10_000) via statement timeout; `maxRows` (default 10_000) stops result streaming past the cap with `SQL_ROW_CAP`; `maxMemoryBytes` (default 256 MiB) via a per-session DuckDB memory limit on the query path. A cap trip is a denial: audited, never silently truncated.

**Audit-every-denial:** every 401/403/cap trip appends a denial row through the SUPA-2 serializer (`src/serialization/audit.ts`) to the target namespace's `_audit` table: `{ ts, ns, table?, op, principal, outcome: "denied", reason: "role" | "table_grant" | "namespace_scope" | "expired" | "sql_flag" | "sql_cap" }`. Denials that occur before a namespace is resolved (bad credentials, expired token) are audited to a server-level audit file (`<namespacesPath>/.duckbrain-audit/denials.jsonl`), which never blocks the request path.

### Behavioral acceptance criteria

- **AC-1 (role matrix battery):** GIVEN five principals — admin, writer, analyst, uploader, and anonymous — and one namespace with a declared table, WHEN each principal attempts each of {table read, table write, file upload, file read, raw-SQL read, raw-SQL write}, THEN the outcome matches the matrix rows above exactly (anonymous → `401`; matrix-denied → `403`; flag-denied raw SQL → `403`), and every denial produced an audit row with the correct `reason`.
- **AC-2 (namespace scope refused):** GIVEN a token whose `namespaces: ["nsA"]` targets `nsB`, WHEN any request for `nsB` is issued, THEN `403 FORBIDDEN` — DB-GAP-031 semantics preserved and audited.
- **AC-3 (per-table grants):** GIVEN a writer-role principal with `tableGrants: {"t1": "read"}`, WHEN it GETs `t1` and POSTs to `t1`, and GETs/POSTs to `t2`, THEN `t1` GET passes, `t1` POST → `403`, and both `t2` requests → `403` (explicit map restricts the role default); an admin with the same `tableGrants` is not restricted.
- **AC-4 (expiry):** GIVEN a key whose `expiresAt` precedes the server clock, WHEN it authenticates, THEN `401 TOKEN_EXPIRED`; a key whose `expiresAt` is after the server clock passes.
- **AC-5 (revocation):** GIVEN a valid key, WHEN its entry is removed from the store file (mtime changes) and the same key is presented again, THEN the next request returns `401 Invalid API key` with no restart.
- **AC-6 (hash-at-rest):** GIVEN a store containing only migrated/new keys, WHEN the file is inspected, THEN no plaintext key material is present (every `key` field is `$sha256$…`); a presented key matches by digest.
- **AC-7 (legacy plaintext migration):** GIVEN a store with a legacy plaintext `key`, WHEN that key authenticates successfully, THEN the request passes and the store file is rewritten with `keyHash` replacing `key`; a second load shows no plaintext.
- **AC-8 (legacy token compat):** GIVEN a pre-existing token with no `roles`/`tableGrants` fields (DB-GAP-031 shape), WHEN it acts, THEN it keeps unrestricted access within its namespace scope (admin-equivalent), and the store load logs a deprecation notice naming the token.
- **AC-9 (auth=none unchanged):** GIVEN `config.type === "none"`, WHEN any request is issued, THEN no principal is attached, no grant check runs, and behavior is byte-identical to today (local single-user mode).
- **AC-10 (basic symmetric):** GIVEN a basic-auth user with `roles: ["analyst"]`, WHEN it reads a table and posts to it, THEN read passes and write → `403` with an audited denial.
- **AC-11 (raw-SQL caps):** GIVEN an analyst with `sql.read: true`, `maxRows: 10`, `timeoutMs: 10_000`, WHEN it runs a SELECT returning 100 rows, THEN 10 rows stream and the request fails with `SQL_ROW_CAP`, audited with `reason: "sql_cap"`; with `sql.write` unset, an INSERT → `403 reason: "sql_flag"`.
- **AC-12 (backend interface conformance):** GIVEN the three shipped backends, WHEN each is driven through `authMiddleware`, THEN each satisfies `AuthBackend` (type + authenticate contract) and the HTTP behavior of `none`/`basic`/`apikey` matches today's observable behavior for valid and invalid credentials.

## Edge Cases

- **Store reload failures:** an unreadable or mid-write store file on reload keeps the last good snapshot in memory and logs — the server never fails open to no-auth and never crashes on a transient read error.
- **Store validation failure:** a store file with an unknown role, invalid `expiresAt`, or a malformed `tableGrants` value fails startup validation (`AuthStoreSchema`) — fail loud, never partially apply.
- **Expiry boundary:** `expiresAt` equal to `now` is expired (inclusive-past rule).
- **Clock skew:** the server clock is authoritative; tokens carry no client time claims.
- **Key rotation:** issuing a new key and removing the old one from the store is immediate revocation of the old (AC-5 path) — no grace period, no dual-key window beyond the operator's own edit.
- **`tableGrants` referencing an undeclared table:** ignored at auth time (grants may precede DDL); the request then fails at the resource layer with `404 TABLE_NOT_FOUND` (`docs/specs/SUPA-3-rest.md`) — never a silent grant.
- **Multiple roles:** union of grants (precedence rule 3); an `admin` role in the union dominates for table access.
- **Denial audit never recurses:** audit appends are unauthenticated internal writes that cannot trigger further auth or audit.
- **Denials before namespace resolution** (bad key, expired): server-level audit file, bounded by size (rotate at 10 MB) — never blocks the request path.
- **`bcrypt` cost:** basic-auth reload is mtime-gated so a store edit cannot trigger a bcrypt storm per request; only the first request after an mtime change re-reads and re-hashes.
- **Case sensitivity:** role names and grant keys are lowercase-only; mixed-case values fail store validation.
- **API key header:** the apikey backend reads `X-API-Key` only (unchanged); `Authorization: Bearer` is not an apikey transport in any shipped backend.

## Non-Goals

- No OIDC/OAuth **implementation**: the `AuthBackend` interface is the extension contract, and an OIDC backend is a separate board row. This row ships the interface plus the three existing backends refactored behind it.
- No per-row RBAC, attribute-based policies, or deny-list rules — grants are role + namespace + table + op + flags as pinned above.
- No token minting/management endpoints: keys are provisioned out-of-band by editing the store or the provisioning CLI that writes `$sha256$` digests.
- No password policies, reset flows, or MFA.
- No SQL statement allowlists; raw SQL is controlled by role flags and the timeout/memory/row caps only.
- No change to `auth=none` single-user semantics.

## Dependencies

- **DB-SUPA-2 (serialization layer)** — denial and acceptance audit rows are appended through `src/serialization/audit.ts` on the namespace writer; SUPA-2 AC-6 (role check before enqueue) consumes this spec's grant middlewares.
- **DB-SUPA-3 (REST)** — table routes mount `requireRole`/`requireTableGrant`; the `tables.read`/`tables.write` resource actions in the matrix are the same actions SUPA-3 enforces (AC-10 of that spec).
- **DB-SUPA-1 (write durability)** — none; denial paths never write data rows, so no durability interaction.
- **Existing code referenced:** `AuthConfig`/`ApiKeyEntry`/`AuthPrincipal`/`authMiddleware`/`requireNamespaceGrant`/`principalAuthorEmail` (`src/auth/middleware.ts`), rate limiting order (`src/auth/ratelimit.ts`, mounted before auth at `src/cli/http.ts:258-298`), auth store path resolution (`src/cli/http.ts:92-118`), store read at startup (`src/cli/http.ts:270-298`), error envelope (`src/http/middleware/errorHandler.ts`).

## Test Plan

New suites (runnable individually via `pnpm test <file>` or together via `pnpm test`):

`src/auth/roles.test.ts`:
- "matrix battery: 5 principals × {table read/write, file upload/read, sql read/write} produce the pinned outcomes" (AC-1).
- "admin bypasses tableGrants; non-admin explicit tableGrants restrict the role default" (AC-3).
- "multi-role principal holds the union of grants".
- "namespace scope denial for a token granted to another namespace" (AC-2).
- "raw-SQL flag gating: matrix grant without sql.read/write flags → 403" (AC-11).

`src/auth/token-lifecycle.test.ts`:
- "expired key → 401 TOKEN_EXPIRED; unexpired key passes; boundary second is expired" (AC-4).
- "store entry removal revokes on the next request via mtime reload" (AC-5).
- "store file contains only $sha256$ digests after migration" (AC-6).
- "legacy plaintext key authenticates once and the store is rewritten to keyHash" (AC-7).
- "legacy token without roles/tableGrants keeps unrestricted access + deprecation log" (AC-8).
- "invalid store (unknown role, bad expiresAt) fails startup validation".
- "unreadable store on reload keeps last good snapshot and logs".

`src/auth/backend-interface.test.ts`:
- "none/basic/apikey each satisfy AuthBackend (type + authenticate)" (AC-12).
- "apikey lookup is digest-based and constant-time (no plaintext compare path)".
- "basic user with roles:['analyst'] reads but cannot write" (AC-10).
- "auth=none attaches no principal and enforces no grants" (AC-9).

`src/cli/http-auth.test.ts` (in-process `createHttpServer`, `src/cli/http.ts:243`; temp auth store via `--auth-file` semantics):
- "role-denied write returns 403 and appends a denial audit row with reason role" (AC-1 audit clause).
- "SQL_ROW_CAP trips after maxRows and audits reason sql_cap" (AC-11).
- "denials before namespace resolution land in the server-level denials file".
- "rate limiting still precedes auth (credential-stuffing order unchanged)".

Run the full set with `pnpm test`; targeted runs: `pnpm test roles`, `pnpm test token-lifecycle`, `pnpm test backend-interface`, `pnpm test http-auth`.
