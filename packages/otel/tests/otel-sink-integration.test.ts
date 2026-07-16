import { describe, expect, it } from 'vitest'
import type { Tracer } from '@opentelemetry/api'
import {
  OpenMultiAgent,
  type AgentConfig,
  type LLMAdapter,
  type LLMChatOptions,
  type LLMMessage,
  type LLMResponse,
} from '@open-multi-agent/core'
import { createOtelTraceSink } from '../src/index.js'

function adapter(): LLMAdapter {
  return {
    name: 'otel-failure-test',
    async chat(_messages: LLMMessage[], _options: LLMChatOptions): Promise<LLMResponse> {
      return {
        id: 'response',
        content: [{ type: 'text', text: 'completed despite telemetry failure' }],
        model: 'test-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    async *stream() { /* unused */ },
  }
}

describe('OTel sink failure isolation', () => {
  it('does not change an Agent result when a user tracer rejects OTel records', async () => {
    const rejectingTracer = {
      startSpan: () => { throw new Error('otel unavailable') },
    } as unknown as Tracer
    const sink = createOtelTraceSink({
      tracer: rejectingTracer,
      batching: { scheduledDelayMs: 1, maxRetries: 0, diagnostics: 'silent', retryJitter: false },
    })
    const agent: AgentConfig = { name: 'worker', model: 'test-model', adapter: adapter() }
    const result = await new OpenMultiAgent({ observability: { sinks: [sink] } }).runAgent(agent, 'hello')

    expect(result.success).toBe(true)
    expect(result.status?.code).toBe('ok')
    const delivery = await sink.forceFlush({ timeoutMs: 100 })
    expect(delivery.status).toBe('error')
    expect(delivery.failed).toBeGreaterThan(0)
  })
})
