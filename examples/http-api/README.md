# HTTP API Example

This example demonstrates how to use DuckBrain via its HTTP REST API.

## Setup

1. Start the HTTP server:
```bash
npm start -- http --port=3000
```

2. Get an API token (if authentication is enabled):
```bash
curl -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/json" \
  -d '{"clientId": "my-app", "secret": "your-secret"}'
```

## API Examples

### Store a Memory
```bash
curl -X POST http://localhost:3000/api/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "key": "projects/mcp/schema",
    "content": {
      "type": "database",
      "fields": ["id", "name", "content"]
    }
  }'
```

### Query Memories by Key
```bash
curl "http://localhost:3000/api/memories?key=projects/mcp/schema" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Semantic Search
```bash
curl "http://localhost:3000/api/memories?query=database%20schema&limit=5" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### List Namespaces
```bash
curl http://localhost:3000/api/namespaces \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Create Namespace
```bash
curl -X POST http://localhost:3000/api/namespaces \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"name": "my-project"}'
```

### Subscribe to Events (Server-Sent Events)
```bash
curl http://localhost:3000/api/events \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Accept: text/event-stream"
```

## JavaScript/TypeScript Client

```typescript
import { DuckBrainClient } from './client';

const client = new DuckBrainClient({
  baseUrl: 'http://localhost:3000',
  token: 'your-api-token'
});

// Store a memory
await client.remember({
  key: 'user/preferences',
  content: { theme: 'dark' }
});

// Recall memories
const memories = await client.recall({
  key: 'user/preferences'
});

// Semantic search
const results = await client.search({
  query: 'user preferences',
  limit: 10
});
```

## Python Client

```python
import requests

BASE_URL = "http://localhost:3000"
TOKEN = "your-api-token"
headers = {"Authorization": f"Bearer {TOKEN}"}

# Store memory
requests.post(f"{BASE_URL}/api/memories", 
    headers=headers,
    json={"key": "test", "content": {"data": "value"}})

# Query memories
response = requests.get(f"{BASE_URL}/api/memories?key=test", headers=headers)
memories = response.json()
```

## Testing

Run the test script:
```bash
node examples/http-api/test.js
```
