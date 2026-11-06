# Contributing to DuckBrain

Thank you for your interest in contributing to DuckBrain! This document provides guidelines for contributing to the project.

## Development Setup

### Prerequisites

- Node.js 22+
- Git
- pnpm 12.4.2 (pinned by `package.json`)
- TypeScript 7.x

### Local Development

```bash
# Clone the repository
git clone https://github.com/wojons/duckbrain.git
cd duckbrain

# Install exactly from the committed lockfile
pnpm install --frozen-lockfile

# Run tests
pnpm test

# Start development server
pnpm run dev
```

## Project Structure

```
duckbrain/
├── packages/
│   └── ui/              # Vite + React + TypeScript Web UI
├── src/
│   ├── mcp/            # MCP server implementation
│   ├── http/           # HTTP API routes
│   ├── storage/        # JSONL/DuckDB storage layer
│   └── cli/            # CLI commands
├── bin/                # Entry points
├── assets/             # Brand assets, screenshots
└── docs/               # Documentation
```

## Dependency Changes: Both Lockfiles, One Command

This repository has **two install paths and therefore two lockfiles**:

- `pnpm-lock.yaml` — CI (`.github/workflows/ci.yml`) and local development
  (`pnpm install --frozen-lockfile`);
- `package-lock.json` — the Docker image (`npm ci`, `Dockerfile:8`).

**Rule: a change to `package.json` is committed together with BOTH
lockfiles.** Refreshing one and not the other leaves the other install path
broken, and it has already cost two CI outages (adding `prom-client` in
OBSDB-001). Regenerate both, in one commit:

```bash
pnpm install --lockfile-only
npm install --package-lock-only --ignore-scripts
```

Then prove it before committing — the check is offline and takes ~0.1s:

```bash
pnpm deps:lockstep          # same as: bash scripts/ci/check-lockfile-lockstep.sh
```

It runs two arms and names every offending package: arm 1 compares
`package.json` with `package-lock.json`, arm 2 compares `package.json` with
the `importers` block of `pnpm-lock.yaml` (root and `packages/ui`). It also
reports a locked dependency the manifest no longer declares.

To have the same check refuse the commit locally, enable the tracked hook
once per clone:

```bash
git config core.hooksPath .githooks
```

CI runs the same command as its own step, before any test, and the pre-commit
hook only fires when a `package.json` or a lockfile is staged. A deliberate
bypass is `git commit --no-verify`. Note that pnpm 12 writes `pnpm-lock.yaml`
as two YAML documents (a self-management document plus the real lock) — that
shape is expected, do not "fix" it by hand.

## Making Changes

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Write/update tests
4. Run tests: `pnpm test`
5. Commit with clear messages
6. Push and create a pull request

## Code Style

- TypeScript strict mode enabled
- Follow existing patterns
- Add JSDoc comments for public APIs
- Keep functions small and focused

## Testing

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm run test:coverage

# Run integration tests
pnpm run test:integration

# Run the bin CLI E2E (spawns the shipped bin/duckbrain.js; run `pnpm build:cli`
# first for a compiled-tree check, otherwise it falls back to tsx)
pnpm run test:cli-e2e
```

## Commit Messages

Follow conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `test:` Tests
- `refactor:` Code refactoring
- `chore:` Maintenance

Example: `feat(storage): add batch commit optimization`

## Pull Request Process

1. Ensure tests pass
2. Update documentation if needed
3. Add screenshots for UI changes
4. Request review from maintainers
5. Address feedback
6. Merge when approved

## Questions?

- Open an issue for bugs or feature requests
- Join discussions in GitHub Discussions

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
