# MCP Client Example

This example demonstrates how to use DuckBrain as an MCP server with a client.

## Setup

1. Install DuckBrain:
```bash
npm install
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
        "DUCKBRAIN_DATA_DIR": "/path/to/duckbrain/memory"
      }
    }
  }
}
```

3. Restart Claude Desktop

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
npm start -- stdio
```
