# Context Management

Long-running agents can hit input token ceilings fast. Set `contextStrategy` on `AgentConfig` to control how the conversation shrinks as it grows:

```typescript
const agent: AgentConfig = {
  name: 'long-runner',
  model: 'claude-sonnet-4-6',
  // Pick one:
  contextStrategy: { type: 'sliding-window', maxTurns: 20 },
  // contextStrategy: { type: 'summarize', maxTokens: 80_000, summaryModel: 'claude-haiku-4-5' },
  // contextStrategy: { type: 'compact', maxTokens: 100_000, preserveRecentTurns: 4 },
  // contextStrategy: { type: 'custom', compress: (messages, estimatedTokens) => ... },
}
```

| Strategy | When to reach for it |
|----------|----------------------|
| `sliding-window` | Cheapest. Keep the last N turns, drop the rest. |
| `summarize` | Send old turns to a summary model; keep the summary in place of the originals. |
| `compact` | Rule-based: truncate large assistant text blocks and tool results, keep recent turns intact. No extra LLM call. |
| `custom` | Supply your own `compress(messages, estimatedTokens)` function. |

## Compressing Tool Results

Tool outputs persist in the conversation history across turns even after the agent has acted on them. In long runs this can consume a significant portion of the context budget.

`compressToolResults` replaces already-consumed tool results (those followed by an assistant response) with a short marker before each new LLM call:

```typescript
const agent: AgentConfig = {
  name: 'long-runner',
  model: 'claude-sonnet-4-6',
  // Enable with the default threshold (500 chars):
  compressToolResults: true,
  // Or only compress results longer than N characters:
  // compressToolResults: { minChars: 2000 },
}
```

| Value | Behaviour |
|-------|-----------|
| `true` | Compress results longer than 500 characters (default threshold) |
| `{ minChars: N }` | Compress results longer than N characters |
| `false` / `undefined` | Disabled (default) |

**Notes:**
- Error tool results are never compressed.
- Delegation `tool_result` blocks (from `delegate_to_agent`) are exempt — the parent agent always retains the full sub-agent output.
- Works alongside `contextStrategy`; combine both for maximum context headroom.

## Truncating Tool Output

`maxToolOutputChars` caps the raw output length for every tool used by an agent. Outputs longer than the limit are truncated to a head + tail excerpt with a marker in between. This applies at execution time, before the result enters the conversation.

```typescript
const agent: AgentConfig = {
  name: 'long-runner',
  model: 'claude-sonnet-4-6',
  maxToolOutputChars: 10_000, // truncate any single tool output to 10 k chars
}
```

Per-tool `maxOutputChars` (set on `ToolDefinition`) takes priority over the agent-level `maxToolOutputChars`.
