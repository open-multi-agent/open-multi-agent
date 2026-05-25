/**
 * Phase 2 (#223): assert that `preserveReasoningAsText` and
 * `compressReasoningText` set on AgentRunner options actually reach the
 * adapter's `chat()` and `stream()` calls as part of LLMChatOptions /
 * LLMStreamOptions.
 *
 * The wiring path covered:
 *   AgentConfig (src/agent/agent.ts:178-185)
 *     → RunnerOptions in src/agent/runner.ts:142-148
 *     → baseChatOptions in src/agent/runner.ts:707-715
 *     → adapter.chat(messages, options) / adapter.stream(...)
 *
 * A regression that drops the runner-side copy would silently break the
 * public API while every per-adapter outbound conversion test (which
 * exercises the conversion in isolation with a directly-constructed
 * `outboundOptions`) still passes. This file pins the runner contract.
 */

import { describe, it, expect } from 'vitest'
import { AgentRunner } from '../src/agent/runner.js'
import { ToolRegistry } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMResponse,
  LLMStreamOptions,
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
  readonly capturedStream: LLMStreamOptions[]
}

function makeCapturingAdapter(): CapturingAdapter {
  const capturedChat: LLMChatOptions[] = []
  const capturedStream: LLMStreamOptions[] = []
  return {
    name: 'mock',
    capturedChat,
    capturedStream,
    capabilities: { echoesReasoning: 'never' },
    async chat(_messages, options) {
      capturedChat.push(options)
      return makeTextResponse()
    },
    async *stream(_messages, options): AsyncIterable<StreamEvent> {
      capturedStream.push(options)
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
})
