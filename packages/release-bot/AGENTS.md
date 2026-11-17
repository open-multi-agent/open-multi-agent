# @open-multi-agent/release-bot agent rules

Repository-wide rules, the shared validation matrix, and the cross-package invariants are in the root [AGENTS.md](../../AGENTS.md). This file holds only what matters while editing this package.

## Validation

- **Release bot:** relevant tests, then `npm run lint -w @open-multi-agent/release-bot` and `npm run test -w @open-multi-agent/release-bot`; both build core first through their `pre` scripts, so they also catch a core API change that breaks the bot. Workflow changes follow [`.github/RELEASING.md`](../../.github/RELEASING.md).
