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

Pairs well with `compressToolResults` and `maxToolOutputChars`.
