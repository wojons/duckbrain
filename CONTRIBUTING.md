# Contributing to DuckBrain

Thank you for your interest in contributing to DuckBrain! This document provides guidelines for contributing to the project.

## Development Setup

### Prerequisites

- Node.js 20+
- Git
- TypeScript 5.0+

### Local Development

```bash
# Clone the repository
git clone https://github.com/wojons/duckbrain.git
cd duckbrain

# Install dependencies
npm install

# Run tests
npm test

# Start development server
npm run dev
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

## Making Changes

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Write/update tests
4. Run tests: `npm test`
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
npm test

# Run with coverage
npm run test:coverage

# Run integration tests
npm run test:integration
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

By contributing, you agree that your contributions will be licensed under the ISC License.
