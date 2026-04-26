# Tool Configuration

Agents can be configured with fine-grained tool access control using presets, allowlists, and denylists.

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

**Resolution order:** preset → allowlist → denylist → framework safety rails.

## Custom Tools

Two ways to give an agent a tool that is not in the built-in set.

**Inject at config time** via `customTools` on `AgentConfig`. Good when the orchestrator wires up tools centrally. Tools defined here bypass preset/allowlist filtering but still respect `disallowedTools`.

```typescript
import { defineTool } from '@jackchen_me/open-multi-agent'
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

`open-multi-agent` can connect to any MCP server and expose its tools directly to agents.

```typescript
import { connectMCPTools } from '@jackchen_me/open-multi-agent/mcp'

const { tools, disconnect } = await connectMCPTools({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
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

See [`integrations/mcp-github`](../examples/integrations/mcp-github.ts) for a full runnable setup.
