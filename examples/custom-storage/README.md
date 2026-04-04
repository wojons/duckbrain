# Custom Storage Example

This example demonstrates how to configure DuckBrain with custom storage settings.

## Configuration

DuckBrain uses a configuration file at `duckbrain.config.json`:

```json
{
  "storage": {
    "dataDir": "./custom-data",
    "namespace": "production",
    "git": {
      "enabled": true,
      "remote": "origin",
      "autoCommit": true
    },
    "duckdb": {
      "maxMemory": "512MB",
      "threads": 4
    }
  },
  "api": {
    "port": 3000,
    "host": "0.0.0.0",
    "auth": {
      "enabled": true,
      "tokenExpiration": "24h"
    },
    "rateLimit": {
      "enabled": true,
      "maxRequests": 100,
      "windowMs": 60000
    }
  },
  "ui": {
    "port": 8080,
    "theme": "dark"
  }
}
```

## Environment Variables

You can also configure via environment variables:

```bash
# Required
export DUCKBRAIN_NAMESPACE=production
export DUCKBRAIN_DATA_DIR=/var/lib/duckbrain

# API Server
export DUCKBRAIN_API_PORT=3000
export DUCKBRAIN_API_HOST=0.0.0.0

# Security
export DUCKBRAIN_API_TOKEN=$(openssl rand -base64 32)
export DUCKBRAIN_RATE_LIMIT_ENABLED=true

# Git
export DUCKBRAIN_GIT_REMOTE=origin
export DUCKBRAIN_GIT_AUTO_COMMIT=true

# Logging
export DUCKBRAIN_LOG_LEVEL=info
```

## Production Deployment

### Docker

```bash
# Build image
docker build -t duckbrain:prod .

# Run with custom config
docker run -d \
  -p 3000:3000 \
  -p 8080:8080 \
  -v /path/to/config.json:/app/duckbrain.config.json \
  -v duckbrain-data:/data \
  --name duckbrain \
  duckbrain:prod
```

### Docker Compose

```yaml
version: '3.8'
services:
  duckbrain:
    image: duckbrain:latest
    ports:
      - "3000:3000"
      - "8080:8080"
    volumes:
      - ./duckbrain.config.json:/app/duckbrain.config.json
      - duckbrain-data:/data
    environment:
      - DUCKBRAIN_LOG_LEVEL=info
      - NODE_ENV=production
    restart: unless-stopped

volumes:
  duckbrain-data:
```

## Storage Backends

DuckBrain supports multiple storage backends:

### Local Filesystem (Default)

```json
{
  "storage": {
    "backend": "filesystem",
    "dataDir": "./memory"
  }
}
```

### Custom Git Repository

```json
{
  "storage": {
    "backend": "git",
    "dataDir": "./memory",
    "git": {
      "url": "https://github.com/user/duckbrain-memories.git",
      "branch": "main",
      "autoPush": true
    }
  }
}
```

## Performance Tuning

### DuckDB Settings

```json
{
  "storage": {
    "duckdb": {
      "maxMemory": "1GB",
      "threads": 8,
      "tempDirectory": "/tmp/duckbrain",
      "checkpointThreshold": "100MB"
    }
  }
}
```

### Vector Search

```json
{
  "storage": {
    "vss": {
      "dimensions": 1536,
      "metric": "cosine",
      "efConstruction": 128,
      "efSearch": 64
    }
  }
}
```

## Testing Configuration

```bash
# Test with custom config
npm start -- http --config=./examples/custom-storage/duckbrain.config.json

# Verify configuration
npm start -- --verify-config
```

## Troubleshooting

### Permission Issues

```bash
# Fix data directory permissions
chown -R 1000:1000 /path/to/data
chmod 755 /path/to/data
```

### Git Authentication

```bash
# Configure git credentials
git config --global credential.helper store
# Or use SSH key
export GIT_SSH_COMMAND='ssh -i /path/to/key'
```
