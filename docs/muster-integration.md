# Muster as an additional connection surface (MUSTER-001)

Status: **optional, additive, opt-in**. Verified 2026-10-23 against DuckBrain v1.1.0 and
muster `v0.1.1-541-g0bd841fe`.

DuckBrain already speaks MCP (stdio), MCP-over-HTTP, and a REST API on `:3000`
authenticated with `x-api-key`. [Muster](https://github.com/wojons/muster) turns any
OpenAPI spec into three extra front-ends over that same HTTP API:

| Surface | Binary | What it gives you |
|---|---|---|
| Generated CLI | `openapi-cli` | Typed commands (`create-memory`, `list-memories`, `get-memory-by-key`) generated from DuckBrain's published spec |
| MCP server | `openapi-mcp` | The memory operations as MCP tools (`createMemory`, `listMemories`, `getMemoryByKey`) for any MCP client |
| Unix-socket proxy daemon | `openapi-daemon` | One local socket that multiplexes clients onto DuckBrain **and holds the API key for them** |

**Nothing in DuckBrain's serving path imports, requires, or knows about muster.**
No file under `src/` and no entry in `package.json` mentions it
(`grep -rni muster src/ package.json` → 0 matches, asserted below). The existing
HTTP API, the stdio MCP server, and the namespace-scoped OpenAPI spec route are
unchanged and remain the default; muster is a client of them, exactly like curl.

---

## 1. The spec muster consumes

DuckBrain publishes a namespace-scoped OpenAPI 3.1 document at:

```
GET /api/ns/<namespace>/openapi.json      (requires a namespace grant, x-api-key)
```

It documents the memory surface plus any declared tables:

```
/api/memories               GET (listMemories) / POST (createMemory)
/api/memories/key/{key}     GET (getMemoryByKey)
/api/ns/<ns>/tables/<name>  the declared table routes
```

The route is authenticated, so fetching the spec needs the same key as the API. Muster's
`discover`/`generate` accept a repeatable `--header` for exactly this:

```bash
export DUCKBRAIN_URL=http://127.0.0.1:3000
export DUCKBRAIN_NS=my-namespace
export DUCKBRAIN_KEY_FILE=~/.duckbrain/my-namespace.token

# parse (AC2)
openapi-cli discover "$DUCKBRAIN_URL/api/ns/$DUCKBRAIN_NS/openapi.json" \
  --header "x-api-key: $(cat "$DUCKBRAIN_KEY_FILE")"
```

Observed output:

```
API: DuckBrain tables — namespace 'my-namespace' (v1.1.0)
Base URL: http://127.0.0.1:3000

Other
  GET    /api/memories                            listMemories
  POST   /api/memories                            createMemory
  GET    /api/memories/key/{key}                  getMemoryByKey
```

Without `--header` the fetch fails loudly (`Error: ... unexpected status 401`); there is
no unauthenticated spec path and nothing silently degrades.

---

## 2. Generated CLI

```bash
# generate + persist typed commands (AC2)
openapi-cli generate "$DUCKBRAIN_URL/api/ns/$DUCKBRAIN_NS/openapi.json" \
  --header "x-api-key: $(cat "$DUCKBRAIN_KEY_FILE")" \
  -u "$DUCKBRAIN_URL"

# store the credential once; --auth attaches it as X-API-Key (type: api-key)
openapi-cli auth add --name duckbrain --type api-key --value "$(cat "$DUCKBRAIN_KEY_FILE")"

openapi-cli --help | grep -E 'create-memory|list-memories|get-memory-by-key'
```

Round trip (AC3), verified 201 → 200 → 200:

```bash
openapi-cli create-memory --key /notes/first --content "hello" \
  --namespace "$DUCKBRAIN_NS" --domain raw_note --auth duckbrain

openapi-cli get-memory-by-key /notes/first --namespace "$DUCKBRAIN_NS" --auth duckbrain

openapi-cli list-memories --namespace "$DUCKBRAIN_NS" --q "hello" --limit 5 --auth duckbrain
```

Retarget a persisted command without regenerating (AC3):

```bash
openapi-cli list-memories --base-url http://other-host:3000 --namespace "$DUCKBRAIN_NS" --auth duckbrain
MUSTER_BASE_URL=http://other-host:3000 openapi-cli list-memories --namespace "$DUCKBRAIN_NS" --auth duckbrain
```

`--base-url` / `MUSTER_BASE_URL` is read at request time; the persisted commands are not
tied to one deployment.

---

## 3. MCP server

`openapi-mcp` serves the same spec as MCP tools. DuckBrain authenticates with an
`x-api-key` header, so pass `-auth-type api-key`:

```bash
# an authenticated spec URL cannot be fetched by the MCP loader (no header support),
# so fetch the document once and point -spec at the file
curl -fsS "$DUCKBRAIN_URL/api/ns/$DUCKBRAIN_NS/openapi.json" \
  -H "x-api-key: $(cat "$DUCKBRAIN_KEY_FILE")" -o /tmp/duckbrain-$DUCKBRAIN_NS.json

openapi-mcp -spec /tmp/duckbrain-$DUCKBRAIN_NS.json \
  -base-url "$DUCKBRAIN_URL" \
  -auth-type api-key -auth-token-file "$DUCKBRAIN_KEY_FILE"
```

A client's `tools/list` returns (asserted, not just "the binary starts"):

```
createMemory, getMemoryByKey, listMemories
```

`tools/call` for `createMemory` returns the created record (id, key, namespace,
timestamp) and `listMemories` returns the page including it.

Any MCP client works. Example stdio entry:

```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "openapi-mcp",
      "args": ["-spec", "/tmp/duckbrain-my-namespace.json",
               "-base-url", "http://127.0.0.1:3000",
               "-auth-type", "api-key",
               "-auth-token-file", "/home/agent/.duckbrain/my-namespace.token"]
    }
  }
}
```

---

## 4. Unix-socket proxy daemon ("the proxy stuff")

`openapi-daemon` in `proxy` mode listens on a Unix socket and forwards to DuckBrain.
With `--backend-token-file` it **injects the DuckBrain key itself**, so a client needs
neither the API key nor the DuckBrain base URL — it only needs the socket path and the
daemon's own client token.

```bash
install -m 600 /dev/null /run/muster/duckbrain-client.token
head -c 32 /dev/urandom | base64 > /run/muster/duckbrain-client.token   # client token

openapi-daemon proxy \
  --backend-url "$DUCKBRAIN_URL" \
  --backend-auth-type api-key \
  --backend-token-file "$DUCKBRAIN_KEY_FILE" \
  --client-token-file /run/muster/duckbrain-client.token \
  --socket-path /run/muster/duckbrain.sock \
  --pid-file /run/muster/duckbrain.pid
```

Client usage (no key, no DuckBrain URL):

```bash
curl --unix-socket /run/muster/duckbrain.sock \
  -H "Authorization: Bearer $(cat /run/muster/duckbrain-client.token)" \
  -H 'content-type: application/json' \
  -d '{"key":"/notes/via-proxy","content":"hello","namespace":"my-namespace","domain":"raw_note"}' \
  http://localhost/api/memories
```

### Auth model (why the daemon is safe to expose)

Two credentials, two roles:

- **Backend credential** (`--backend-token-file`, type via `--backend-auth-type`):
  read once at startup, injected on every proxied request, never logged, never sent to
  a client. It is applied *after* the client's headers are copied, so a caller cannot
  override or downgrade it.
- **Client token** (`--client-token-file`, `Authorization: Bearer <token>`): required on
  every socket request except `/health*`.

`--backend-token-file` **refuses to start without** `--client-token-file`: a daemon that
injects an upstream credential would otherwise authenticate every local caller as its own
upstream identity.

Verified behaviour (AC5 + AC7):

| Probe | Result |
|---|---|
| Authorized client writes with **no** `x-api-key` | `201`, memory created as the key's principal |
| Authorized client reads back / lists | `200` / `200` |
| 8 concurrent clients on the same socket | 8 × `200` |
| Write with **no** client token | `401` from the daemon, request never reaches DuckBrain (follow-up read → `404`) |
| Direct call to DuckBrain with no key | `401` — DuckBrain's own auth is not bypassed by adding a front-end |

Without `--backend-token-file` the daemon behaves exactly as before (plain pass-through,
client headers forwarded untouched, no socket auth).

---

## 5. Additive-only guarantee (AC1)

```bash
grep -rni muster src/ package.json     # 0 matches
node bin/duckbrain.js http --port 3000 # unchanged: same routes, same x-api-key auth
pnpm test:run                          # unchanged suite
```

Muster is not a dependency of DuckBrain in any form: not in `package.json`, not imported
by the serving path, not required at build or test time. Removing every muster binary
leaves DuckBrain exactly as it was. The integration lives entirely in the muster
binaries plus this document.

---

## 6. Deployment notes

### Requirements

- muster binaries built from the private repo (`git@github.com:wojons/muster.git`, so
  `GOPRIVATE`/SSH access is required to build it; nothing is fetched at DuckBrain build
  time):

  ```bash
  git clone git@github.com:wojons/muster.git && cd muster && make build
  # → bin/openapi-cli, bin/openapi-mcp, bin/openapi-daemon
  ```

- A DuckBrain API key with a grant on the target namespace
  (`duckbrain token --name muster --namespace <ns> --role writer`), stored in a file
  with `0600` permissions.

### Bunker / single-box topology

On a bunker agent (agent + muster + DuckBrain on one host), the intended shape is:

```
agent/MCP client ──stdio──> openapi-mcp ─┐
   human shell  ──exec───> openapi-cli ──┼──HTTP x-api-key──> DuckBrain :3000
   any local client ─unix socket─> openapi-daemon ──┘ (daemon holds the key)
```

- Put the socket under `$XDG_RUNTIME_DIR` or `/run/muster/` (not `/tmp`, which is shared
  on a multi-user bunker) and keep it `0600` — the daemon adds token auth on top.
- Keep `--backend-token-file` and `--client-token-file` `0600` and outside the repo.
- Run the daemon as a user service so it starts with the agent's session; do not add it
  to DuckBrain's unit, which must stay independent:

  ```ini
  # ~/.config/systemd/user/muster-duckbrain.service
  [Unit]
  Description=muster unix-socket proxy for DuckBrain
  After=duckbrain.service

  [Service]
  ExecStart=%h/bin/openapi-daemon proxy \
    --backend-url http://127.0.0.1:3000 \
    --backend-auth-type api-key \
    --backend-token-file %h/.duckbrain/duckbrain.token \
    --client-token-file %h/.duckbrain/muster-client.token \
    --socket-path %t/muster/duckbrain.sock
  Restart=on-failure

  [Install]
  WantedBy=default.target
  ```

- The daemon reads the backend credential **once at startup**: rotating the DuckBrain key
  requires restarting the daemon, not DuckBrain.
- If DuckBrain runs in a container and muster on the host (or vice versa), point
  `--backend-url` at the reachable address and remember the socket is host-local.

### Known limitations (measured, not assumed)

- **Muster profile `headers:` are not applied** by generated commands
  (`pkg/config` declares them; no consumer reads them). Use `openapi-cli auth add`
  (type `api-key`) + `--auth`, or `-H 'x-api-key: ...'` per call.
- **MCP `-spec` cannot fetch an authenticated URL** (its loader sends no headers):
  fetch the spec file with the key first, as shown above.
- **`openapi-daemon` has no keychain integration**: the backend credential must be a
  file (or `MUSTER_BACKEND_TOKEN_FILE`/`MUSTER_DAEMON_CLIENT_TOKEN_FILE`).
- Memory keys that start with `/` produce a doubled slash in the generated path
  (`/api/memories/key//notes/x`). DuckBrain accepts this; keys without the leading slash
  avoid it entirely.
- The daemon is a *proxy*, not a cache or a queue: no offline buffering, and a write is
  only durable when DuckBrain answers.

---

## 7. Removing the integration

```bash
openapi-cli generate --clear     # drop generated commands
openapi-cli auth remove --name duckbrain
# stop + disable the muster-daemon unit
```

DuckBrain needs no change to un-integrate: the surfaces were never part of it.

---

## 8. Verification record

Run 2026-10-23 on Linux, `openapi-cli`/`openapi-mcp`/`openapi-daemon`
`v0.1.1-541-g0bd841fe`, DuckBrain `v1.1.0`, a scratch daemon on `127.0.0.1:3099` with
a namespace-scoped `writer` key, and the production instance on `:3000` untouched.

| AC | Evidence |
|---|---|
| 1 additive | `grep -rni muster src/ package.json` → 0; `:3000` served before and after; `pnpm test:run` unchanged |
| 2 spec → commands | `discover` parsed the authenticated spec URL with `--header`; `create-memory`, `list-memories`, `get-memory-by-key` persisted and loaded on the next invocation |
| 3 CLI round trip | `create-memory` → `201` with the record; `get-memory-by-key` → `200` with the same content; `list-memories --q` → `200` (score 1.0 on the exact match); `--base-url` and `MUSTER_BASE_URL` both redirected the *same* persisted command at a second endpoint |
| 4 MCP | `tools/list` → `createMemory`, `listMemories`, `getMemoryByKey`; `tools/call createMemory` → record `e93f6b08…`; `tools/call listMemories` returned it |
| 5 daemon proxy | socket write `201` and read `200` with no `x-api-key` and no DuckBrain URL in the client; 8 concurrent clients all `200` |
| 6 docs | this file + `docs/index.md` link |
| 7 negative | no client token → `401` (daemon), write absent on read-back (`404`); direct unauthenticated DuckBrain write → `401` |

Muster-side defects found and fixed while doing this (they blocked ACs 2–5, and are
opt-in/no-op for existing muster users):

- generated commands **panicked** (`flag redefined: namespace`) on a spec that names a
  request-body property like an operation parameter — DuckBrain's `create-memory` does
  exactly that;
- persisted commands **dropped every query parameter named `namespace`** (and never
  recorded which parameters were query vs header), so reloaded commands could not
  address a namespace at all;
- query parameter values were **not percent-encoded** (`?q=round trip` → `400`);
- `discover`/`generate` had **no way to send a header** to an authenticated spec URL;
- the MCP server could only authenticate with `Authorization: Bearer`;
- the daemon had **no backend credential injection** and no way to require a client
  token — the gap MUSTER-002 recorded as the real blocker for the proxy criterion.
