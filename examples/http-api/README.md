# HTTP API Example

This example demonstrates how to use DuckBrain via its HTTP REST API.

## Setup

1. Start the HTTP server:

```bash
node bin/duckbrain.js http --port=3000
```

(The `pnpm start` + `--`-separator spelling is avoided here on purpose: under
the repo's pinned pnpm, the separator is forwarded to the CLI verbatim and
DuckBrain exits with `Unknown command: --`. Invoke the entry point directly,
or use `pnpm start http --port=3000` with no separator.)

2. Authentication (optional): the examples below run against a daemon started
   with `--auth=none` (the default), so no headers are needed. To require auth,
   start the daemon with `--auth=apikey`, mint a token with
   `duckbrain token --name=my-app`, and pass it with
   `-H "X-API-Key: <your-token>"` (the client below does this automatically when
   `DUCKBRAIN_TOKEN` is set).

## API Examples

The examples assume a scratch daemon with a scratch data dir so they never
touch production data:

```bash
export SCRATCH_DATA=$(mktemp -d)
mkdir -p "$SCRATCH_DATA/namespaces/default"
DUCKBRAIN_DATA_DIR="$SCRATCH_DATA" \
DUCKBRAIN_NAMESPACES_PATH="$SCRATCH_DATA/namespaces" \
  node bin/duckbrain.js http --port=39471 &
# wait for readiness
curl --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:39471/health
```

### Store a Memory

```bash
curl -X POST http://127.0.0.1:39471/api/memories \
  -H "Content-Type: application/json" \
  -d '{
    "key": "/projects/mcp/schema",
    "domain": "config",
    "content": "Database schema: id, name, content"
  }'
```

### Query Memories by Key

```bash
curl "http://127.0.0.1:39471/api/memories/key/projects/mcp/schema"
```

### Keyword Search (offline, no embedding provider needed)

```bash
curl "http://127.0.0.1:39471/api/memories?contains=schema&limit=5"
```

### Semantic Search

```bash
curl "http://127.0.0.1:39471/api/memories?q=database%20schema&limit=5"
```

(`?q=` needs a reachable embedding provider at query time; when none is
configured the endpoint answers 503 `EMBEDDINGS_UNAVAILABLE`. Prefer
`?contains=` in examples — it works offline.)

### List Namespaces

```bash
curl http://127.0.0.1:39471/api/namespaces
```

### Create Namespace

```bash
curl -X POST http://127.0.0.1:39471/api/namespaces \
  -H "Content-Type: application/json" \
  -d '{"name": "my-project"}'
```

### Subscribe to Events (Server-Sent Events)

```bash
curl http://127.0.0.1:39471/api/events \
  -H "Accept: text/event-stream"
```

### Stop the scratch daemon

Kill only the exact PID recorded at startup — never a pattern kill:

```bash
kill "$(cat "$SCRATCH_DATA/duckbrain-http-39471.pid")"
```

## JavaScript Client

```javascript
const { DuckBrainClient } = require("./client.js");

const client = new DuckBrainClient({
  baseUrl: "http://localhost:3000",
  token: "your-api-token", // sent as the X-API-Key header
});

// Store a memory — key is a filesystem-style path starting with "/",
// content is a plain string, domain must be one of:
// person, event, concept, message, config, raw_note
await client.remember({
  key: "/user/preferences",
  content: "theme=dark",
  domain: "config",
});

// Recall the latest memory under an exact key path
const memory = await client.recall({
  key: "/user/preferences",
});

// Keyword search (offline)
const results = await client.search({
  query: "preferences",
  limit: 10,
});
```

Run the bundled example end to end:

```bash
node examples/http-api/client.js
```

## Python Client

```python
import requests

BASE_URL = "http://localhost:3000"
TOKEN = "your-api-token"
headers = {"X-API-Key": TOKEN}

# Store memory (key starts with "/", content is a string)
requests.post(f"{BASE_URL}/api/memories",
    headers=headers,
    json={"key": "/test", "domain": "raw_note", "content": "value"})

# Query memories by key path
response = requests.get(f"{BASE_URL}/api/memories/key/test", headers=headers)
memory = response.json()

# Keyword search
response = requests.get(f"{BASE_URL}/api/memories",
    headers=headers,
    params={"contains": "value", "limit": 10})
memories = response.json()
```
