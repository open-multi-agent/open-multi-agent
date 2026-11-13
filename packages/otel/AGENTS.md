# @open-multi-agent/otel agent rules

Repository-wide rules, the shared validation matrix, and the cross-package invariants are in the root [AGENTS.md](../../AGENTS.md). This file holds only what matters while editing this package.

## Validation

- **OpenTelemetry adapter:** relevant tests, then `npm run lint -w @open-multi-agent/otel`, `npm run test -w @open-multi-agent/otel`, and build when package output or public types may be affected.
