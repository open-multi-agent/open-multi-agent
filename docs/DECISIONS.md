# Architecture Decisions

This document records our architectural decisions — both what we choose NOT to build, and what we're actively working toward. Our goal is to be the **simplest multi-agent framework**, but simplicity doesn't mean closed. We believe the long-term value of a framework isn't its feature checklist — it's the size of the network it connects to.

## Won't Do

These are paradigms we evaluated and deliberately chose not to implement, because they conflict with our core model.

### 1. Agent Handoffs

**What**: Agent A transfers an in-progress conversation to Agent B (like OpenAI Agents SDK `handoff()`).

**Why not**: Handoffs are a different paradigm from our task-based model. Our tasks have clear boundaries — one agent, one task, one result. Handoffs blur those boundaries and add state-transfer complexity. Users who need handoffs likely need a different framework (OpenAI Agents SDK is purpose-built for this).

### 2. State Persistence / Checkpointing

**What**: Save workflow state to a database so long-running workflows can resume after crashes (like LangGraph checkpointing).

**Why not**: Requires a storage backend (SQLite, Redis, Postgres), schema migrations, and serialization logic. This is enterprise infrastructure — it triples the complexity surface. Our target users run workflows that complete in seconds to minutes, not hours. If you need checkpointing, LangGraph is the right tool.

**Related**: Closing #20 with this rationale.

## Open to Adoption

These are protocols we see strategic value in and are actively tracking. We're waiting for the right moment — not the right feature spec, but the right network density.

> **Our thesis**: Framework competition on features (DAG scheduling, shared memory, zero-dependency) is a race that can always be caught. Network competition — where the value of the framework grows with every agent published to it — creates a fundamentally different moat. MCP and A2A are the protocols that turn a framework from a build tool into a registry.

### 3. MCP Integration (Model Context Protocol)

**What**: Anthropic's protocol for connecting LLMs to external tools and data sources.

**Status**: **Next up.** MCP has crossed the adoption threshold — Cursor, Windsurf, Claude Code all ship with built-in support, and many services now provide MCP servers directly. Asking users to re-wrap each one via `defineTool()` creates unnecessary friction.

**Approach**: Optional peer dependency (`@modelcontextprotocol/sdk`). Zero impact on the core — if you don't use MCP, you don't pay for it. This preserves our minimal-dependency principle while connecting to the broader tool ecosystem.

**Tracking**: #86

### 4. A2A Protocol (Agent-to-Agent)

**What**: Google's open protocol for agents on different servers to discover and communicate with each other.

**Status**: **Watching.** The spec is still evolving and production adoption is minimal. But we recognize A2A's potential to enable the network effect we care about — if 1,000 developers publish agent services using open-multi-agent, the 1,001st developer isn't just choosing an API, they're choosing which ecosystem has the most agents they can call.

**When we'll move**: When A2A adoption reaches a tipping point where the protocol connects real, production agent services — not just demos. We'll prioritize a lightweight integration that lets agents be both consumers and providers of A2A services.

---

*Last updated: 2026-04-09*
