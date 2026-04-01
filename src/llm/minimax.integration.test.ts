/**
 * @fileoverview Integration tests for the MiniMax LLM adapter.
 *
 * These tests hit the live MiniMax API and are automatically skipped when
 * MINIMAX_API_KEY is not set.  They do NOT mock the openai module so that
 * the real HTTP client is exercised.
 *
 * Run with:
 *   MINIMAX_API_KEY=<key> npm test
 */

import { describe, it, expect } from 'vitest'
import { MiniMaxAdapter } from './minimax.js'

const runIntegration = Boolean(process.env['MINIMAX_API_KEY'])

function userMsg(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }] }
}

describe.skipIf(!runIntegration)('MiniMaxAdapter (integration)', () => {
  it('chat() returns a non-empty response from MiniMax-M2.7', async () => {
    const adapter = new MiniMaxAdapter()
    const response = await adapter.chat(
      [userMsg('Reply with exactly the word "pong" and nothing else.')],
      { model: 'MiniMax-M2.7', temperature: 0.01, maxTokens: 20 },
    )

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as any).text)
      .join('')

    expect(text.toLowerCase()).toContain('pong')
    expect(response.usage.input_tokens).toBeGreaterThan(0)
  })

  it('chat() works with MiniMax-M2.7-highspeed model', async () => {
    const adapter = new MiniMaxAdapter()
    const response = await adapter.chat(
      [userMsg('Say only "ok".')],
      { model: 'MiniMax-M2.7-highspeed', temperature: 0.01, maxTokens: 50 },
    )
    expect(response.content.length).toBeGreaterThan(0)
    expect(['end_turn', 'max_tokens']).toContain(response.stop_reason)
  })

  it('stream() yields text events and a done event', { timeout: 15000 }, async () => {
    const adapter = new MiniMaxAdapter()
    const events: any[] = []
    for await (const event of adapter.stream(
      [userMsg('Count from 1 to 3, one number per line.')],
      { model: 'MiniMax-M2.7', temperature: 0.5, maxTokens: 60 },
    )) {
      events.push(event)
    }

    const textEvents = events.filter((e) => e.type === 'text')
    const doneEvent = events.find((e) => e.type === 'done')
    expect(textEvents.length).toBeGreaterThan(0)
    expect(doneEvent).toBeDefined()
    expect(['end_turn', 'max_tokens']).toContain((doneEvent.data as any).stop_reason)
  })
})
