/**
 * E2E tests for AnthropicAdapter against the real API.
 *
 * Skipped by default. Run with: npm run test:e2e
 * Requires: ANTHROPIC_API_KEY environment variable
 */
import { describe, it, expect } from 'vitest'
import { AnthropicAdapter } from '../../src/llm/anthropic.js'
import type { LLMResponse, StreamEvent, ToolUseBlock } from '../../src/types.js'

const describeE2E = process.env['RUN_E2E'] ? describe : describe.skip

describeE2E('AnthropicAdapter E2E', () => {
  const adapter = new AnthropicAdapter()
  const model = 'claude-haiku-4-5-20251001'

  const weatherTool = {
    name: 'get_weather',
    description: 'Get the weather for a city',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  }

  it('chat() returns a text response', async () => {
    const result = await adapter.chat(
      [{ role: 'user', content: [{ type: 'text', text: 'Say "hello" and nothing else.' }] }],
      { model, maxTokens: 50, temperature: 0 },
    )

    expect(result.id).toBeTruthy()
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.content[0].type).toBe('text')
    expect(result.usage.input_tokens).toBeGreaterThan(0)
    expect(result.stop_reason).toBe('end_turn')
  }, 30_000)

  it('chat() handles tool use', async () => {
    const result = await adapter.chat(
      [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Tokyo? Use the get_weather tool.' }] }],
      { model, maxTokens: 100, temperature: 0, tools: [weatherTool] },
    )

    const toolBlocks = result.content.filter(b => b.type === 'tool_use')
    expect(toolBlocks.length).toBeGreaterThan(0)
    expect((toolBlocks[0] as ToolUseBlock).name).toBe('get_weather')
    expect(result.stop_reason).toBe('tool_use')
  }, 30_000)

  it('stream() yields text events and a done event', async () => {
    const events: StreamEvent[] = []
    for await (const event of adapter.stream(
      [{ role: 'user', content: [{ type: 'text', text: 'Say "hi".' }] }],
      { model, maxTokens: 50, temperature: 0 },
    )) {
      events.push(event)
    }

    const textEvents = events.filter(e => e.type === 'text')
    expect(textEvents.length).toBeGreaterThan(0)

    const doneEvents = events.filter(e => e.type === 'done')
    expect(doneEvents).toHaveLength(1)
    const response = doneEvents[0].data as LLMResponse
    expect(response.usage.input_tokens).toBeGreaterThan(0)
  }, 30_000)

  it('stream() handles tool use', async () => {
    const events: StreamEvent[] = []
    for await (const event of adapter.stream(
      [{ role: 'user', content: [{ type: 'text', text: 'Get weather in Paris. Use the tool.' }] }],
      { model, maxTokens: 100, temperature: 0, tools: [weatherTool] },
    )) {
      events.push(event)
    }

    const toolEvents = events.filter(e => e.type === 'tool_use')
    expect(toolEvents.length).toBeGreaterThan(0)
    expect((toolEvents[0].data as ToolUseBlock).name).toBe('get_weather')
  }, 30_000)
})
