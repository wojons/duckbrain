# Connection Profiles

Profiles are **tool-visibility presets** for MCP connections: they decide
which tools a connection _sees_ in `tools/list`. They are **not security
boundaries** — they never grant, revoke, or broaden authority. Every
`tools/call` is evaluated exactly as before, against the existing
authentication, namespace-grant, and tool/runtime safeguards.

> **The one-line contract:** a profile can hide a tool from discovery; it
> cannot make an unauthorized call succeed, and it cannot break an
> authorized one.

## Why agents can build their own profiles

Because profiles do not control authorization, there is nothing dangerous
about an agent defining one. Creation requires no privilege — any
connection may define a profile that narrows (or reshapes) its own
discovery, and only the profile's owner can later change its definition.
Authority lives entirely in the token/grant model (see
[Authorization](#authorization-the-thing-profiles-are-not)).

## The model

A profile is a named list of per-tool directives:

| Directive   | Effect on `tools/list` for a connection that selected the profile |
| ----------- | ----------------------------------------------------------------- |
| `hidden`    | The tool is **not advertised** (removed from the list).           |
| `exclusive` | The selection advertises **only** the exclusive-named tools.      |
| `default`   | No change — the tool keeps its built-in visibility. Folding a     |
|             | `default` is a no-op; it never re-widens a tool another selected  |
|             | profile hid.                                                      |

Profiles may reference **built-in tools** and **registered custom tools**
(the custom-function MCP tools, when that runtime is present on the
server). A directive for a tool that is not currently registered is inert:
it is neither an error nor visible until the tool appears.

### Multi-profile composition (deterministic)

A connection selects any number of profiles (order in the selection does
not matter). The composed visibility is the **set union of every selected
profile's directives**:

1. Fold all selected profiles' directives together (union of `hidden`
   names, union of `exclusive` names).
2. If any selected profile used `exclusive`, the visible set is exactly the
   exclusive union.
3. Remove every `hidden` name from the result.
4. **Conflict rule:** for the same tool name, `hidden` always beats
   `exclusive` — regardless of which profile mentioned it first. A tool
   named both ways is invisible, never the reverse.

The outcome depends only on WHICH profiles were selected, never on the
order or on concurrent activity from other connections.

### Isolation

Selections are **per connection/session** state:

- Over stdio, a session's `select_profiles` call affects only that process.
- Over MCP-over-HTTP, a selection can be passed per request with the
  `X-DuckBrain-Profiles: name1, name2` header — it applies to that single
  request only and cannot leak into another client's requests.
- A selection never mutates another connection's state, and profile
  definitions are owner-keyed so one agent cannot rewrite another agent's
  profile.

## Using profiles

### Discover what exists

Call `list_profiles` — it returns the stored profiles, the built-in tool
names, the custom tools registered on this server, the active selection,
and the contract note.

### Define your own

```json
{
  "name": "create_profile",
  "arguments": {
    "name": "memory-only",
    "owner": "my-agent",
    "description": "Only memory read/write tools",
    "directives": [
      { "tool": "remember", "visibility": "exclusive" },
      { "tool": "recall", "visibility": "exclusive" },
      { "tool": "squash", "visibility": "hidden" }
    ]
  }
}
```

Update your own profile with `update_profile` (full directive replacement;
the `owner` must match).

### Select profiles for this connection

```json
{
  "name": "select_profiles",
  "arguments": { "profiles": ["memory-only"] }
}
```

Or, per HTTP request:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "X-API-Key: $DUCKBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-DuckBrain-Profiles: memory-only" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

An unknown profile name in a selection is inert (reported in previews as
`unknownProfiles`) — it never breaks discovery, and it never widens it.

## What profiles change — and what they never touch

| Surface                | Profiles affect it | Notes                                                                                                                                                        |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/list`           | Yes                | Filtered by the active selection.                                                                                                                            |
| `tools/call`           | **No**             | Hidden-but-authorized tools still execute under the existing contract; unauthorized tools still fail identically with or without a profile advertising them. |
| Authentication         | **No**             | Tokens, keys, and principals are unchanged.                                                                                                                  |
| Namespace grants       | **No**             | Scope enforcement is untouched.                                                                                                                              |
| Roles / admin surfaces | **No**             | Unchanged.                                                                                                                                                   |
| Rate limits / sandbox  | **No**             | Runtime safeguards are untouched.                                                                                                                            |

## Authorization (the thing profiles are NOT)

Profiles are configuration presets for discovery. All authority decisions
remain with the existing model:

- **Tokens and keys** — `--auth=apikey` / `--auth=basic`, stored and
  validated exactly as before (`~/.duckbrain/auth.json` or `--auth-file`).
- **Namespace grants** — a token scoped to specific namespaces still cannot
  read or write outside them, no matter what its profile advertises.
- **Roles** — admin/writer/analyst/uploader semantics are unchanged.
- **Tool/runtime safeguards** — sandboxing, timeouts, and per-tool checks
  are unchanged.

If you need to restrict what a caller can DO, use the token/grant model —
mint a token with narrower `namespaces`, fewer roles, or tighter grants.
Do not use profiles: hiding a tool from a client's discovery is not a
control against that client calling it directly (and is not intended to
be).

## Storage

Profile definitions live in `<duckbrain root>/.duckbrain/mcp-profiles.json`
(additive, versioned file, `{"version": 1, "profiles": [...]}`). The file
is created on first `create_profile`. Selection state is never persisted —
it is per-connection/session only.
