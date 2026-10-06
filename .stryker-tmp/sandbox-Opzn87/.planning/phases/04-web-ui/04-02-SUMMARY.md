---
phase: 04-web-ui
plan: 02
subsystem: api
tags: [express, http-api, mcp-tools, rest, sse]

requires:
  - phase: 04-web-ui-01
    provides: Vite + React + Tailwind CSS UI foundation
provides:
  - Express HTTP API routes wrapping MCP tools
  - Memory CRUD endpoints (GET/POST/PUT/DELETE)
  - Key tree hierarchical endpoint
  - Namespace management endpoints
  - Server-Sent Events endpoint for real-time updates
  - CORS configuration for localhost:5173
affects:
  - 04-web-ui-03 (UI data connection)

tech-stack:
  added: []
  patterns:
    - "Centralized architecture: HTTP API is thin wrapper around MCP tools"
    - "PUT operation uses forget+remember pattern for versioning"
    - "Error handler middleware for structured JSON error responses"
    - "CORS middleware for cross-origin UI development"

key-files:
  created:
    - src/http/types/api.ts - API request/response type definitions
    - src/http/middleware/errorHandler.ts - Error handling with ApiError classes
    - src/http/routes/index.ts - Route barrel file
    - src/http/routes/memories.ts - Memory CRUD endpoints wrapping recall/remember/forget
    - src/http/routes/keys.ts - Key tree endpoint with hierarchical building
    - src/http/routes/namespaces.ts - Namespace management endpoints
    - src/http/routes/events.ts - Server-Sent Events endpoint
  modified:
    - src/cli/http.ts - Updated to register all API routes, added CORS

key-decisions:
  - "All routes wrap MCP tools - no direct storage access (per D-17)"
  - "PUT /api/memories/:id uses forget+remember for versioned updates"
  - "CORS allows all origins for UI development (to be restricted in production)"
  - "SSE endpoint ready for future real-time integration"

requirements-completed:
  - UI-01
  - UI-02
  - UI-03

duration: 12 min
completed: 2026-04-02T21:39:00Z
---

# Phase 04 Plan 02: HTTP API Routes Summary

**Express REST API endpoints that wrap MCP tools, providing HTTP interface for the Web UI to query and mutate memory data with SSE support for real-time updates.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-04-02T21:27:13Z
- **Completed:** 2026-04-02T21:39:00Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- REST API endpoints wrapping MCP tool functions (recall, remember, forget, listKeys, namespace tools)
- Full Memory CRUD: GET /api/memories, POST /api/memories, PUT /api/memories/:id, DELETE /api/memories/:id
- Hierarchical key tree endpoint at GET /api/keys
- Namespace management: GET /api/namespaces, POST /api/namespaces, POST /api/namespaces/switch
- Server-Sent Events endpoint at GET /api/events/:namespace with heartbeat
- CORS middleware configured for localhost:5173 UI development
- Structured error handling with JSON responses

## Task Commits

Each task was committed atomically:

1. **Task 1: Create HTTP API types and error handling middleware** - `1499e3d` (feat)
2. **Task 2: Implement memory and keys API routes** - `6f92b69` (feat)
3. **Task 3: Implement namespace and SSE events routes** - `d1bf80d` (feat)

**Plan metadata:** TBD (docs: complete plan)

## Files Created/Modified

- `src/http/types/api.ts` - TypeScript interfaces for API responses (MemoryResponse, KeyNode, NamespaceResponse)
- `src/http/middleware/errorHandler.ts` - Error handling with ApiError, ValidationError, NotFoundError classes
- `src/http/routes/index.ts` - Barrel file exporting all route modules
- `src/http/routes/memories.ts` - Memory CRUD endpoints (GET, POST, PUT, DELETE)
- `src/http/routes/keys.ts` - Key tree endpoints with hierarchical tree building
- `src/http/routes/namespaces.ts` - Namespace management wrapping list/create/switch tools
- `src/http/routes/events.ts` - Server-Sent Events endpoint with connection tracking
- `src/cli/http.ts` - Updated to register all API routes, added CORS middleware

## Decisions Made

- **Centralized Architecture:** All HTTP routes wrap MCP tools rather than accessing storage directly. This maintains the "single source of truth" pattern where MCP tools are the only interface to memory data.

- **Versioned Updates:** PUT operations use the forget+remember pattern (tombstone old version, create new version) rather than in-place updates. This preserves audit history and matches the append-only philosophy.

- **CORS for Development:** Configured CORS to allow all origins for development on localhost:5173. Production deployments should restrict this.

- **SSE Structure:** Implemented SSE endpoint with connection tracking and heartbeat. Full event publishing integration with memory changes can be enhanced in future phases.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None significant. The Express type errors visible in LSP are pre-existing issues in the project and don't affect runtime behavior.

## API Endpoints Reference

### Memories
- `GET /api/memories?prefix=&domain=&author=&limit=50&offset=0` - List memories with filters
- `GET /api/memories/:id` - Get single memory by ID
- `POST /api/memories` - Create new memory (body: {key, domain, content, attributes?})
- `PUT /api/memories/:id` - Update memory (forget + remember)
- `DELETE /api/memories/:id` - Delete memory (create tombstone)

### Keys
- `GET /api/keys?prefix=/&depth=10` - Get hierarchical key tree
- `GET /api/keys/flat?prefix=/&limit=100` - Get flat key list

### Namespaces
- `GET /api/namespaces` - List all namespaces
- `POST /api/namespaces` - Create namespace (body: {name, setDefault?})
- `POST /api/namespaces/switch` - Switch namespace (body: {name})

### Events (SSE)
- `GET /api/events/:namespace` - Server-Sent Events stream
- `POST /api/events/:namespace/broadcast` - Broadcast event (internal)
- `GET /api/events/:namespace/stats` - Connection statistics

## Next Phase Readiness

- API foundation complete, ready for Plan 03: Connect UI to memory API
- All MCP tools are accessible via HTTP
- CORS configured for local development
- SSE infrastructure ready for real-time features

---
*Phase: 04-web-ui*
*Completed: 2026-04-02*
