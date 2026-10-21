# Custom MCP Tools (Sandboxed JS/WASM Runtime)

MCP-CUSTOM-RUNTIME-001. DuckBrain lets you expose your own JavaScript and
WebAssembly functions as **first-class MCP tools**: each declared tool
appears as an individual entry in `tools/list` (its own name, description
and input schema) and is directly executable through `tools/call` — no
wrapper tool, no second hop.

Everything runs inside a sandboxed runtime:

- **Fresh Worker thread per call** with a V8 heap ceiling
  (`resourceLimits.maxOldGenerationSizeMb`) — memory exhaustion kills the
  sandbox, never the server.
- **JavaScript** executes inside a `node:vm` realm whose global surface is
  the full realm-fresh set of ES intrinsics (Object, Array, JSON, Math,
  Date, String, Number, Promise, the Error family, WebAssembly, ...)
  plus `console` (Node provides it per vm context; its output goes to the
  sandbox worker's stdout, which the parent drains to nothing) and
  `globalThis`. Nothing is injected from the host realm — not even the
  call arguments as an object; the arguments arrive only as one primitive
  JSON string that the realm parses itself. What the boundary actually
  enforces: code generation from strings is disabled
  (`codeGeneration.strings: false`), so `Function(...)`, `eval(...)` and
  every `x.constructor.constructor(...)` bridge throw; `require`,
  `process`, `fetch`, `Buffer`, module loading and timers do not exist in
  the realm; WebAssembly modules instantiate with an EMPTY import
  namespace; declared capabilities fail closed before execution.
- **WebAssembly** modules are instantiated with an EMPTY import namespace:
  any host function a module tries to import traps at link time. Compute
  modules that need no imports run unchanged.
- **Wall-clock budget** per call. A sync `while(true)` loop is killed by
  the vm's own script timeout; anything else is terminated hard by
  `worker.terminate()` at the budget boundary — the call returns a
  structured TIMEOUT error and the server keeps serving.

## Registering tools

Add a `customTools` block to `duckbrain.config.json` and restart the
server (the MCP stdio process and the HTTP daemon each load the block at
startup):

```json
{
  "customTools": {
    "enabled": true,
    "timeoutMs": 5000,
    "maxHeapMb": 64,
    "tools": [
      {
        "name": "word_count",
        "description": "Count words in a text",
        "version": "1.0.0",
        "runtime": "javascript",
        "module": "inline: return { words: String(args.text).split(/\\s+/).filter(Boolean).length };",
        "capabilities": [],
        "inputSchema": {
          "type": "object",
          "properties": { "text": { "type": "string" } },
          "required": ["text"]
        }
      },
      {
        "name": "crc32",
        "description": "CRC-32 of the input string (wasm compute kernel)",
        "version": "1.0.0",
        "runtime": "wasm",
        "module": "tools/crc32.wasm",
        "capabilities": [],
        "inputSchema": { "type": "object" }
      }
    ]
  }
}
```

The block is **disabled by default**; no custom tool exists until you opt
in.

### Contract fields

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | Stable MCP tool name. `^[a-zA-Z][a-zA-Z0-9_-]*$`, max 64 chars. Built-in names (`remember`, `recall`, `list_keys`, `forget`, `squash`, `get_compaction_stats`, `create_namespace`, `list_namespaces`, `switch_namespace`, `delete_namespace`, `server_status`, `server_http_start`) are reserved — a collision is refused at startup, never silently shadowed. Duplicates are refused too. |
| `description` | yes | What agents see in `tools/list`. Keep it precise: agents choose tools by this text. |
| `version` | yes | Your contract version. Bump on breaking input/output changes so clients can pin. Surfaced to clients in the tool's `_meta["duckbrain.dev/customTool"]` together with runtime + capabilities. |
| `runtime` | yes | `javascript` or `wasm`. |
| `module` | yes | See "Module references" below. |
| `capabilities` | yes (may be `[]`) | Host capabilities requested: `fs`, `net`, `process`, `env`, `secret`. **The current build grants none** — a tool declaring any capability is refused with `CAPABILITY_DECLARED` before it runs (fail closed). Declare `[]` and keep the tool self-contained. |
| `inputSchema` | no (default `{"type":"object"}`) | JSON Schema (object form) for the tool's arguments. It becomes the tool's transport-level input schema — invalid calls are rejected by the MCP layer with the standard `-32602` error before your code runs — and the runtime re-checks required properties/types at execution time. Modeled types: `string`, `number`, `integer`, `boolean`, `array`, `object`. |

### Module references

- `javascript`: a path to a `.js`/`.mjs`/`.cjs` file **or** `inline:<source>`.
- `wasm`: a path to a `.wasm` file **or** `inline:<base64 bytes>`.
- Relative paths resolve against the duckbrain root (the directory owning
  `duckbrain.config.json`). Paths escaping the root are refused
  (`MODULE_INVALID`).
- Inline or file, a module is capped at 256 KB — bigger code does not
  belong in a config file.

#### JavaScript tool conventions

Your source is evaluated inside the vm realm wrapped in a function that
receives nothing; the tool's result is:

1. the value of a `return` statement (`return {...};` — the common shape),
2. otherwise the value assigned to a variable named `tool`,
3. otherwise the value assigned to `result`,
4. otherwise the script's completion value.

If the completion value is a **function**, the runtime calls it with the
arguments object and uses its return value. Results must be
JSON-serializable; a BigInt, function, symbol or circular reference
resolves to a structured `RESULT_UNSERIALIZABLE` error instead of a
mangled payload.

```javascript
// inline: module example — args is the validated arguments object
const scale = Number(args.scale ?? 1);
return { scaled: Number(args.value) * scale };
```

#### WebAssembly tool conventions

The FIRST exported function of the module is the entry point. Dispatch:

- If the declared `inputSchema.required` is non-empty and every required
  property is `number`/`integer`, they are spread positionally
  (`add(a, b)` style — note wasm exports always report arity 0, so the
  schema decides, never `fn.length`).
- Otherwise the entry receives the arguments object (memory-based
  conventions do your own marshalling).
- The return value must be JSON-serializable.

```json
{
  "name": "add",
  "runtime": "wasm",
  "module": "tools/add.wasm",
  "inputSchema": {
    "type": "object",
    "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
    "required": ["a", "b"]
  }
}
```

## Versioning, updating, removing

- **Update**: edit the declaration (or the module file) and restart the
  server. Bump `version` when the input/output contract changes; agents
  that pinned `<tool>@1.0.0` keep working against servers still running
  the old contract.
- **Remove**: delete the entry and restart. The tool disappears from
  `tools/list` on the next listing; in-flight calls finish or fail
  naturally.
- **Disable one tool without deleting it**: there is no per-tool flag —
  set `"enabled": false` on the whole block, or move the entry out.
- **Bad declarations never take the surface down**: an entry that fails
  validation (bad name, missing module, wrong runtime…) is reported on
  stderr (`[MCP Custom Tools] invalid declaration at tools[N] ignored: …`)
  and skipped; every valid sibling still registers.

## Structured error contract

Every failure mode resolves to a JSON payload of the shape

```json
{ "success": false, "error": "human-readable message", "code": "MACHINE_CODE" }
```

surfaced through `tools/call` with `isError: true` (the message stays
visible to the agent). The server never crashes or hangs on a bad tool.

| Code | When |
|------|------|
| `TOOL_UNKNOWN` | Call to a name that is not a registered custom tool. |
| `CONTRACT_INVALID` | (reserved) declaration-level failures surface at startup as stderr reports. |
| `MODULE_NOT_FOUND` | Module file missing. |
| `MODULE_INVALID` | Module unreadable, oversized, bad base64, or a path escaping the duckbrain root. |
| `SCHEMA_INVALID` | Arguments violate the declared input schema floor. |
| `RUNTIME_TRAP` | The module threw, or a wasm module trapped (including import-binding failures at instantiation). |
| `TIMEOUT` | The call exceeded `timeoutMs`; the sandbox was terminated. |
| `RESOURCE_EXHAUSTED` | The sandbox exceeded its heap ceiling or died without a result. |
| `CAPABILITY_DENIED` | (reserved) a capability the runtime would deny was invoked. |
| `CAPABILITY_DECLARED` | The tool declares host capabilities this build does not grant — refused before execution. |
| `RESULT_UNSERIALIZABLE` | The tool returned a non-JSON-safe value. |

## Trust boundary — read this before enabling

A custom tool's module is **user-supplied code**. The operator who can
write `duckbrain.config.json` (or the module files it points at) can run
arbitrary computation on this host inside the sandbox. The sandbox
boundary is:

- **inside**: pure computation over the arguments you pass; no I/O of any
  kind is reachable (no fs, no net, no process, no env, no secrets, no
  require/import of host modules).
- **outside (the host)**: the server's own process, the DuckDB store, the
  git repos, and every credential the host holds. None of it is exposed
  to the sandbox, and no capability is granted implicitly — the only
  escalation path is a future runtime that implements an explicit
  capability bridge, and a tool must then DECLARE the capability in its
  contract (recorded in config, visible in `_meta`) to even ask.

Defense-in-depth in this implementation: the arguments pass through a
transport-level schema validation, a runtime floor validation, and an
in-sandbox re-check; results must round-trip JSON; every call gets a
fresh Worker thread (a tool cannot poison the next call); and the
sandbox's stdout/stderr are drained to nothing so a chatty module can
never corrupt the MCP wire or flood the log.

What this sandbox does NOT claim: it is not a security boundary against
the operator (who already owns the config), and `node:vm` is not a
hardened isolation technology like V8 isolates or a separate OS process —
it is a realm separation layer on a resource-limited thread. Treat
`customTools.enabled: true` as "the operator vouches for this code";
the sandbox exists to make accidents bounded (CPU, memory, time, wire),
not to contain a determined attacker who can already edit your config.
