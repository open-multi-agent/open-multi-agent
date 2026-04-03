# Architecture Decisions

This document records deliberate "won't do" decisions for the project. These are features we evaluated and chose NOT to implement — not because they're bad ideas, but because they conflict with our positioning as the **simplest multi-agent framework**.

If you're considering a PR in any of these areas, please open a discussion first.

## Won't Do

### 1. Agent Handoffs

**What**: Agent A transfers an in-progress conversation to Agent B (like OpenAI Agents SDK `handoff()`).

**Why not**: Handoffs are a different paradigm from our task-based model. Our tasks have clear boundaries — one agent, one task, one result. Handoffs blur those boundaries and add state-transfer complexity. Users who need handoffs likely need a different framework (OpenAI Agents SDK is purpose-built for this).

### 2. State Persistence / Checkpointing

**What**: Save workflow state to a database so long-running workflows can resume after crashes (like LangGraph checkpointing).

**Why not**: Requires a storage backend (SQLite, Redis, Postgres), schema migrations, and serialization logic. This is enterprise infrastructure — it triples the complexity surface. Our target users run workflows that complete in seconds to minutes, not hours. If you need checkpointing, LangGraph is the right tool.

**Related**: Closing #20 with this rationale.

### 3. A2A Protocol (Agent-to-Agent)

**What**: Google's open protocol for agents on different servers to discover and communicate with each other.

**Why not**: Too early — the spec is still evolving and adoption is minimal. Our users run agents in a single process, not across distributed services. If A2A matures and there's real demand, we can revisit. Today it would add complexity for zero practical benefit.

### 4. MCP Integration (Model Context Protocol)

**What**: Anthropic's protocol for connecting LLMs to external tools and data sources.

**Why not**: MCP is valuable but targets a different layer. Our `defineTool()` API already lets users wrap any external service as a tool in ~10 lines of code. Adding MCP would mean maintaining protocol compatibility, transport layers, and tool discovery — complexity that serves tool platform builders, not our target users who just want to run agent teams.

### 5. Dashboard / Visualization

**What**: Built-in web UI to visualize task DAGs, agent activity, and token usage.

**Why not**: We expose data, we don't build UI. The `onProgress` callback and upcoming `onTrace` (#18) give users all the raw data. They can pipe it into Grafana, build a custom dashboard, or use console logs. Shipping a web UI means owning a frontend stack, which is outside our scope.

---

*Last updated: 2026-04-03*
