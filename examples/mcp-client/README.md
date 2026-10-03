# MCP Client Example

This example demonstrates how to use DuckBrain as an MCP server with a client.

## Setup

1. Install DuckBrain:

```bash
pnpm install --frozen-lockfile
```

2. Configure your MCP client (e.g., Claude Desktop) to use DuckBrain:

**Claude Desktop Config** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "duckbrain": {
      "command": "node",
      "args": ["/path/to/duckbrain/bin/duckbrain.js", "stdio"],
      "env": {
        "DUCKBRAIN_NAMESPACE": "claude",
        "DUCKBRAIN_NAMESPACES_PATH": "/path/to/duckbrain/namespaces"
      }
    }
  }
}
```

3. Restart Claude Desktop

## Namespace Resolution

`DUCKBRAIN_NAMESPACE` is what isolates one agent's memory from another's. The
namespace an operation uses is resolved in this order (first one set wins):

1. an explicit parameter — the `remember` tool's `namespace` argument, the
   CLI's `--namespace=<name>`, or the HTTP API's `?namespace=<name>`
2. `DUCKBRAIN_NAMESPACE` from the agent's `env` block
3. `defaultNamespace` in `duckbrain.config.json`
4. `default`

So the config above makes every `remember`/`recall`/`list_keys` call that does
not name a namespace land in `claude`. The env var is applied at runtime only —
it is never written back into `duckbrain.config.json`. To change the namespace
for good, use the `switch_namespace` tool or
`duckbrain config set defaultNamespace <name>`.

`DUCKBRAIN_NAMESPACES_PATH` is the separate "where is memory stored" knob: it
is the directory that holds the namespace repositories (default
`<duckbrain root>/namespaces`). Note that `DUCKBRAIN_DATA_DIR` is **not** the
memory store — it only sets the directory for the HTTP server's PID file.

## Usage

Once configured, DuckBrain provides these tools to Claude:

- `remember` - Store a memory
- `recall` - Query memories
- `list_keys` - List memory keys
- `forget` - Remove a memory

## Example Conversation

**You:** "Remember that my favorite color is blue"

**Claude:** Uses `remember` tool with key="preferences/favorite_color" content="blue"

**You:** "What's my favorite color?"

**Claude:** Uses `recall` tool with key="preferences/favorite_color" and returns "blue"

**You:** "What do you know about me?"

**Claude:** Uses `list_keys` to discover available memory keys, then `recall` to retrieve them.

## Testing

Test the MCP connection:

```bash
# Run DuckBrain in stdio mode
node bin/duckbrain.js stdio
```

(Do not use the `--`-separator spelling (`pnpm start` + `--` + `stdio`) here:
under the repo's pinned pnpm the separator is forwarded to the CLI verbatim
and DuckBrain exits with `Unknown command: --`.)
