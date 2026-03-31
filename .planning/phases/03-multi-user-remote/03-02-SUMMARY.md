---
phase: 03-multi-user-remote
plan: 02
subsystem: infra
tags: [docker, containerization, compose, alpine, debian, tsx]

# Dependency graph
requires:
  - phase: 01-core-mvp
    provides: CLI entry points (bin/duckbrain.ts) and source modules
  - phase: 02-git-auto
    provides: Git worker for version-controlled storage
provides:
  - Production Docker image (node:20-slim, non-root, health check)
  - Development Docker image (with debugging tools, --watch reload)
  - Single-container docker-compose.yml
  - Multi-container docker-compose.multi.yml
  - Docker entrypoint script with git initialization
affects: [04-web-ui, deployment]

# Tech tracking
tech-stack:
  added: [docker, docker-compose]
  patterns: [multi-stage-build, non-root-container, named-volumes, health-check]

key-files:
  created: [Dockerfile, Dockerfile.dev, docker-compose.yml, docker-compose.multi.yml, scripts/docker-entrypoint.sh, .dockerignore]
  modified: []

key-decisions:
  - "Used node:20-slim (Debian) instead of Alpine for DuckDB glibc compatibility"
  - "Reused existing node user (UID 1000) instead of creating custom user to avoid UID/GID conflicts"
  - "Uses tsx directly instead of npm run build since project has no build step"
  - "DuckDB sidecar in multi-compose uses Alpine tail for volume keepalive (DuckDB is in-process)"

patterns-established:
  - "Multi-stage build: builder installs deps, production stage copies artifacts"
  - "Entrypoint script pattern: initialize git repo, then exec main command"
  - "Named volumes preferred over bind mounts for production persistence"

requirements-completed: [REMOTE-01]

# Metrics
duration: 11min
completed: 2026-03-31
---

# Phase 3 Plan 02: Docker Containerization Summary

**Production and development Docker images with non-root execution, health checks, named volumes, and multi-container compose configs using tsx for TypeScript execution**

## Performance

- **Duration:** 11 min
- **Started:** 2026-03-31T10:22:49Z
- **Completed:** 2026-03-31T10:34:17Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- Production Docker image builds successfully and runs as UID 1000 (non-root)
- Development Docker image with vim/curl/htop debugging tools and tsx --watch auto-reload
- Single and multi-container Docker Compose configurations with named volumes and localhost-only binding
- Entrypoint script that auto-initializes git repository in the data volume

## Task Commits

Each task was committed atomically:

1. **Task 1: Create production Dockerfile** - `2fafc17` (feat)
2. **Task 2: Create development Dockerfile** - `6b5413c` (feat)
3. **Task 3: Create Docker Compose configurations** - `48505c6` (feat)

## Files Created/Modified
- `Dockerfile` - Production image: multi-stage build, node:20-slim, non-root, health check
- `Dockerfile.dev` - Development image: debugging tools, tsx --watch for auto-reload
- `docker-compose.yml` - Single-container compose with named volume and localhost binding
- `docker-compose.multi.yml` - Multi-container compose with DuckDB sidecar
- `scripts/docker-entrypoint.sh` - Initializes git repo in /data, execs main command
- `.dockerignore` - Excludes .git, .planning, node_modules, dist from build context

## Decisions Made
- **node:20-slim over Alpine:** DuckDB's native Node.js binding requires glibc, which Alpine doesn't provide. Switched from Alpine to Debian-slim for both build and production stages.
- **Reused node user (UID 1000):** The node:20-slim image already has a `node` user with UID/GID 1000. Creating a custom user with UID 1000 conflicts with the existing one, so we reuse the built-in node user.
- **tsx instead of build step:** The project runs TypeScript directly via tsx (no `npm run build` or `dist/` directory). Dockerfile uses `npx tsx bin/duckbrain.ts` instead of the planned `node dist/bin/duckbrain.js`.
- **Alpine sidecar for DuckDB:** Since DuckDB is embedded (in-process), the multi-container setup uses a minimal Alpine container to keep the shared volume active, rather than a dedicated DuckDB server.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Switched from Alpine to Debian-slim for DuckDB compatibility**
- **Found during:** Task 1 (Docker build verification)
- **Issue:** Plan specified Alpine-based production image, but DuckDB's native binding requires glibc (ld-linux-aarch64.so.1). Alpine uses musl libc, causing ERR_DLOPEN_FAILED.
- **Fix:** Changed production stage from `alpine:latest` to `node:20-slim` (Debian-based). Also changed builder stage to match for consistent native module compilation.
- **Files modified:** Dockerfile
- **Verification:** `docker build` succeeds, `docker run --rm --entrypoint "" duckbrain:test id` returns uid=1000(node)
- **Committed in:** 2fafc17 (Task 1 commit)

**2. [Rule 1 - Bug] Reused existing node user instead of creating UID 1000 user**
- **Found during:** Task 1 (Docker build verification)
- **Issue:** Plan specified creating a new user with UID/GID 1000, but node:20-alpine (and node:20-slim) already has a `node` user with UID 1000. `adduser -u 1000` fails with "uid in use".
- **Fix:** Removed custom user creation, reused the existing `node` user (UID 1000) from the base image.
- **Files modified:** Dockerfile
- **Verification:** Container runs as uid=1000(node) gid=1000(node)
- **Committed in:** 2fafc17 (Task 1 commit)

**3. [Rule 3 - Blocking] Adapted Dockerfile for tsx runtime (no build step)**
- **Found during:** Task 1 (plan analysis before execution)
- **Issue:** Plan referenced `npm run build` and `/app/dist/` paths, but the project has no build script and no dist directory. TypeScript runs directly via tsx.
- **Fix:** Changed ENTRYPOINT to `npx tsx bin/duckbrain.ts`, copied source files (bin/, src/) instead of dist/, and used `npm ci` (not `npm ci --only=production`) since tsx is a regular dependency.
- **Files modified:** Dockerfile
- **Verification:** Container starts and shows DuckBrain CLI output
- **Committed in:** 2fafc17 (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 bug)
**Impact on plan:** All deviations necessary for functional Docker images. Alpine→Debian slightly increases image size but required by DuckDB. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Docker images build and run successfully
- Ready for Plan 03 (HTTP server deployment or remote access configuration)
- Multi-container setup provides foundation for future DuckDB server separation

---
*Phase: 03-multi-user-remote*
*Completed: 2026-03-31*
