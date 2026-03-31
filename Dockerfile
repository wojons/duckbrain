# Build stage — install dependencies (Debian for DuckDB glibc native binding)
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install all deps (tsx is a dep, not devDep)
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Production stage — Debian slim for DuckDB native binding (requires glibc)
FROM node:20-slim

# Install git (needed for version control features)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# The node:20-slim base already has a 'node' user with UID 1000
# We reuse it for running the app as non-root

WORKDIR /app

# Copy installed dependencies and source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/src ./src

# Copy entrypoint script
COPY scripts/docker-entrypoint.sh /app/scripts/docker-entrypoint.sh
RUN chmod +x /app/scripts/docker-entrypoint.sh

# Create data directory with proper ownership for node user
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

# Switch to non-root user
USER node

EXPOSE 3000

# Health check — verify the process can start
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/').catch(()=>process.exit(1))" || exit 1

# Run via entrypoint (initializes git repo) then tsx for TypeScript execution
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh", "npx", "tsx", "bin/duckbrain.ts"]
CMD ["http", "--port=3000", "--bind=0.0.0.0"]
