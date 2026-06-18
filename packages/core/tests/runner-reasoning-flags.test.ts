/**
 * Phase 2 (#223): assert that `preserveReasoningAsText` and
 * `compressReasoningText` set on `AgentRunner` options actually reach the
 * adapter's `chat()` call as `LLMChatOptions` fields.
 *
 * Wiring path covered HERE:
 *   `AgentRunner` constructor options (src/agent/runner.ts:142-148)
 *     → `baseChatOptions` (src/agent/runner.ts:707-715)
 *     → `adapter.chat(messages, options)` (src/agent/runner.ts:766)
 *
 * Wiring path NOT covered here (intentional):
 *   - `AgentConfig → RunnerOptions` (src/agent/agent.ts:181-182). That's a
 *     one-line copy guarded by TypeScript's structural typing — both fields
 *     are optional on both sides, so a regression would compile-fail iff
 *     the field is renamed. No runtime test is added because constructing
 *     a fully-wired `Agent` with a stub adapter has unrelated dependencies
 *     (tool registry plumbing) that bloat the test surface.
 *
 *   - `adapter.stream()`. The framework's streaming path lives in
 *     `AgentRunner.stream()` (`runner.ts:677`), which under the hood still
 *     calls `adapter.chat()` rather than `adapter.stream()`. `adapter.stream`
 *     is exposed on the `LLMAdapter` interface but is currently unused by
 *     the runner — therefore Phase 2 flag propagation through `adapter.stream`
 *     does not exercise a real code path. Per-adapter outbound conversion
 *     tests still verify each `toXxxMessages` implementation correctly
 *     interprets the options regardless of which adapter method invokes it.
 */

import { describe, it, expect } from 'vitest'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMResponse,
  StreamEvent,
} from '../src/types.js'

function makeTextResponse(): LLMResponse {
  return {
    id: 'resp-1',
    content: [{ type: 'text', text: 'done' }],
    model: 'mock',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

interface CapturingAdapter extends LLMAdapter {
  readonly capturedChat: LLMChatOptions[]
}

function makeCapturingAdapter(): CapturingAdapter {
  const capturedChat: LLMChatOptions[] = []
  return {
    name: 'mock',
    capturedChat,
    capabilities: { echoesReasoning: 'never' },
    async chat(_messages, options) {
      capturedChat.push(options)
      return makeTextResponse()
    },
    // Required by the interface; intentionally not exercised by these tests
    // (see file-level JSDoc for rationale).
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: 'done', data: makeTextResponse() }
    },
  } satisfies CapturingAdapter
}

describe('AgentRunner reasoning-flag propagation (#223 Phase 2)', () => {
  it('forwards preserveReasoningAsText + compressReasoningText into chat() options', async () => {
    const adapter = makeCapturingAdapter()
    const runner = new AgentRunner(adapter, new ToolRegistry(), new ToolExecutor(new ToolRegistry()), {
      model: 'mock-model',
      maxTurns: 1,
      preserveReasoningAsText: true,
      compressReasoningText: { minChars: 2000 },
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

    expect(adapter.capturedChat).toHaveLength(1)
    const opts = adapter.capturedChat[0]!
    expect(opts.preserveReasoningAsText).toBe(true)
    expect(opts.compressReasoningText).toEqual({ minChars: 2000 })
  })

  it('forwards undefined when flags are not set on RunnerOptions (back-compat)', async () => {
    const adapter = makeCapturingAdapter()
    const runner = new AgentRunner(adapter, new ToolRegistry(), new ToolExecutor(new ToolRegistry()), {
      model: 'mock-model',
      maxTurns: 1,
      // flags omitted
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

    expect(adapter.capturedChat).toHaveLength(1)
    const opts = adapter.capturedChat[0]!
    expect(opts.preserveReasoningAsText).toBeUndefined()
    expect(opts.compressReasoningText).toBeUndefined()
  })

  it('forwards compressReasoningText: false sentinel for "no truncation"', async () => {
    const adapter = makeCapturingAdapter()
    const runner = new AgentRunner(adapter, new ToolRegistry(), new ToolExecutor(new ToolRegistry()), {
      model: 'mock-model',
      maxTurns: 1,
      preserveReasoningAsText: true,
      compressReasoningText: false,
    })

    await runner.run([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])

    expect(adapter.capturedChat[0]?.compressReasoningText).toBe(false)
  })

  it('runner.stream() also threads the flags via adapter.chat() (internal contract)', async () => {
    // `AgentRunner.stream()` internally drives turns via `adapter.chat()` —
    // verify the same flag-propagation contract holds for the stream entrypoint
    // so a future regression that touches the stream path's options-build still
    // gets caught.
    const adapter = makeCapturingAdapter()
    const runner = new AgentRunner(adapter, new ToolRegistry(), new ToolExecutor(new ToolRegistry()), {
      model: 'mock-model',
      maxTurns: 1,
      preserveReasoningAsText: true,
      compressReasoningText: { minChars: 500 },
    })

    const events: StreamEvent[] = []
    for await (const ev of runner.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])) {
      events.push(ev)
    }

    expect(adapter.capturedChat).toHaveLength(1)
    expect(adapter.capturedChat[0]?.preserveReasoningAsText).toBe(true)
    expect(adapter.capturedChat[0]?.compressReasoningText).toEqual({ minChars: 500 })
  })
})
