# Tool Configuration

Agents can be configured with fine-grained tool access control using presets, allowlists, and denylists.

## Built-in tools are opt-in (default-deny)

Built-in tools — `bash` and the filesystem tools (`file_read`, `file_write`, `file_edit`, `grep`, `glob`) — are **default-deny**. An agent receives a built-in tool only when it is granted explicitly via `tools` (an allowlist of names) or `toolPreset`. An agent that sets **neither** resolves to **zero** built-in tools:

```typescript
// No tools / toolPreset → this agent cannot run bash or touch the filesystem.
const llmOnly: AgentConfig = { name: 'writer', model: 'claude-sonnet-4-6' }

// Opt in explicitly.
const coder: AgentConfig = {
  name: 'coder',
  model: 'claude-sonnet-4-6',
  tools: ['file_read', 'file_write', 'bash'],
}
```

This holds uniformly across `runAgent`, `runTeam` / `runTasks`, the `runTeam` simple-goal short-circuit, and a standalone `Agent`. Calling `registerBuiltInTools()` makes tools _available to grant_ — it does not grant them; the agent still needs `tools` / `toolPreset`. If the model emits a call to a registered-but-ungranted tool (a confused model, or text steered by prompt injection), the runner returns a clear `"not granted"` error instead of executing it.

**Two things stay true once a tool is granted — design around them:**

- **`bash` is not sandboxed.** Granting it gives the agent arbitrary shell on the host (see [_Filesystem Working Directory_](#filesystem-working-directory) below). Only the filesystem tools are path-contained.
- **Tool output flows to your model provider.** Every tool result is appended to the conversation and sent to the configured LLM on the next turn. Anything a tool reads — file contents, command output, fetched pages — leaves your process and reaches the provider. Grant read access deliberately.

**Custom / runtime tools are exempt from the grant requirement** — registering them _is_ the grant. Tools passed via `customTools` or `agent.addTool()` are always available (they still respect `disallowedTools`); see [_Custom Tools_](#custom-tools). **`delegate_to_agent`** (team orchestration handoff) follows the default-deny rule like any other built-in: grant it with `tools: ['delegate_to_agent']` on each agent you want to be able to delegate.

### Restoring the previous "all tools" behavior

Before default-deny, an agent with no tool config received every registered built-in — including the unsandboxed `bash`. To restore that convenience in one line, set `defaultToolPreset` on the orchestrator:

```typescript
const orchestrator = new OpenMultiAgent({
  defaultToolPreset: 'full', // agents with no tools/toolPreset get the full preset
})
```

`defaultToolPreset` is a **fallback**: it applies only to agents that declare neither `tools` nor `toolPreset`. Per-agent config always overrides it, and it never widens an agent that already declares a grant. It does not apply to the internal coordinator (which never calls tools).

## Tool Presets

Predefined tool sets for common use cases:

```typescript
const readonlyAgent: AgentConfig = {
  name: 'reader',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readonly',  // file_read, grep, glob
}

const readwriteAgent: AgentConfig = {
  name: 'editor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',  // file_read, file_write, file_edit, grep, glob
}

const fullAgent: AgentConfig = {
  name: 'executor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'full',  // file_read, file_write, file_edit, grep, glob, bash
}
```

## Advanced Filtering

Combine presets with allowlists and denylists for precise control:

```typescript
const customAgent: AgentConfig = {
  name: 'custom',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',        // Start with: file_read, file_write, file_edit, grep, glob
  tools: ['file_read', 'grep'],   // Allowlist: intersect with preset = file_read, grep
  disallowedTools: ['grep'],      // Denylist: subtract = file_read only
}
```

**Resolution order:** default-deny (no preset _and_ no allowlist ⇒ zero built-in tools) → preset → allowlist → denylist → framework safety rails. Custom / runtime tools bypass the grant step (registration is the grant) but still honor the denylist.

## Filesystem Working Directory

Built-in filesystem tools (`file_read`, `file_write`, `file_edit`, `grep`, `glob`) are sandboxed to a per-agent working directory. Paths must be absolute and resolve inside that directory; symlinks are resolved before the check so they cannot escape the configured root.

> **`bash` is not sandboxed.** Once an agent has a shell, any `cd /etc`, absolute path, or subshell trivially escapes a per-tool path check. The sandbox is therefore best understood as **path containment for built-in filesystem tools**, not a security boundary against arbitrary command execution. If full path containment matters, drop `bash` via `disallowedTools: ['bash']` (or omit it from your `tools` allowlist) and rely on the filesystem tools. Process-level isolation (containers, seatbelt, firejail) is the right tool for an actually-untrusted shell.

### Three typical configurations

```typescript
import { OpenMultiAgent } from '@open-multi-agent/core'

// 1. Default — sandbox rooted at `<cwd>/.agent-workspace`.
//    The directory is auto-created on first write. Agents cannot read or
//    write outside that subdirectory, which keeps source files, `.env`,
//    `.git/`, and `node_modules` off-limits even when the host launched
//    from the repo root.
const defaultOrchestrator = new OpenMultiAgent()

// 2. Widen the sandbox to the entire current working directory.
//    Useful when the agent is a coding assistant operating on the user's
//    project (the host already established trust by launching there).
const wideOrchestrator = new OpenMultiAgent({
  defaultCwd: process.cwd(),
})

// 3. Disable the sandbox entirely (relative and absolute paths anywhere).
const unrestrictedOrchestrator = new OpenMultiAgent({
  defaultCwd: null,
})
```

### Custom sandbox root

```typescript
const orchestrator = new OpenMultiAgent({
  defaultCwd: '/var/run/my-agent-workspace', // any absolute path
})

const agent: AgentConfig = {
  name: 'editor',
  model: 'claude-sonnet-4-6',
  toolPreset: 'readwrite',
  cwd: '/var/run/my-agent-workspace/packages/app', // optional per-agent override
}
```

**Resolution order.** `AgentConfig.cwd` (if set) → `OrchestratorConfig.defaultCwd` (if set) → `<process.cwd()>/.agent-workspace`. Pass `null` at either level to disable the sandbox for that scope.

**Auto-creation.** The sandbox root is `mkdir -p`'d on first write, so callers do not need to pre-create `.agent-workspace` (or any custom path).

The `bash` tool runs in its own process group on POSIX, so timeouts and abort signals kill any backgrounded children rather than letting them outlive the parent.

## Custom Tools

Two ways to give an agent a tool that is not in the built-in set.

**Inject at config time** via `customTools` on `AgentConfig`. Good when the orchestrator wires up tools centrally. Tools defined here bypass preset/allowlist filtering but still respect `disallowedTools`.

```typescript
import { defineTool } from '@open-multi-agent/core'
import { z } from 'zod'

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Look up current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ data: await fetchWeather(city) }),
})

const agent: AgentConfig = {
  name: 'assistant',
  model: 'claude-sonnet-4-6',
  customTools: [weatherTool],
}
```

**Register at runtime** via `agent.addTool(tool)`. Tools added this way are always available, regardless of filtering.

## Tool Output Control

Long tool outputs can blow up conversation size and cost. Two controls work together.

**Validation (optional).** Add `outputSchema` to catch malformed tool results before they are forwarded:

> **Note — two different `outputSchema` fields.** The one on `defineTool()` /
> `ToolDefinition` (shown below) validates a single **tool's** `ToolResult.data`
> — it is always a `ZodSchema<string>` because tool output is serialised as
> text. The `outputSchema` on [`AgentConfig`](../examples/patterns/structured-output.ts)
> is different: it validates the **agent's final answer** as parsed JSON
> against an arbitrary Zod schema (see _Structured output_ in `examples/`).
> Different types, different scopes — TypeScript won't warn you if you mix
> them up, so pick the one that matches the layer you're working at.

```typescript
const jsonTool = defineTool({
  name: 'json_tool',
  description: 'Return JSON payload as string.',
  inputSchema: z.object({}),
  outputSchema: z.string().refine((value) => {
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  }, 'Output must be valid JSON'),
  execute: async () => ({ data: '{"ok": true}' }),
})
```

**Truncation.** Cap an individual tool result to a head + tail excerpt with a marker in between:

```typescript
const agent: AgentConfig = {
  // ...
  maxToolOutputChars: 10_000, // applies to every tool this agent runs
}

// Per-tool override (takes priority over AgentConfig.maxToolOutputChars):
const bigQueryTool = defineTool({
  // ...
  maxOutputChars: 50_000,
})
```

**Post-consumption compression.** Once the agent has acted on a tool result, compress older copies in the transcript so they stop costing input tokens on every subsequent turn. Error results are never compressed.

```typescript
const agent: AgentConfig = {
  // ...
  compressToolResults: true,                 // default threshold: 500 chars
  // or: compressToolResults: { minChars: 2_000 }
}
```

## MCP Tools (Model Context Protocol)

`open-multi-agent` can connect to stdio MCP servers and expose their tools directly to agents.

```typescript
import { connectMCPTools } from '@open-multi-agent/core/mcp'

const { tools, disconnect } = await connectMCPTools({
  command: 'npx',
  args: ['--no-install', '@modelcontextprotocol/server-github'],
  env: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  },
  namePrefix: 'github',
})

// Register each MCP tool in your ToolRegistry, then include their names in AgentConfig.tools
// Don't forget cleanup when done
await disconnect()
```

Notes:
- `@modelcontextprotocol/sdk` is an optional peer dependency, only needed when using MCP.
- Current transport support is stdio.
- MCP input validation is delegated to the MCP server (`inputSchema` is `z.any()`).
- Prefer locally installed or pinned MCP server binaries and pass only the environment variables that server needs. Avoid spreading `process.env` into MCP subprocesses.

See [`integrations/mcp-github`](../examples/integrations/mcp-github.ts) for a full runnable setup.
