import { describe, expect, it } from 'vitest'
import {
  EXIT,
  PROVIDER_REFERENCE,
  parseArgs,
  serializeAgentResult,
  serializeTeamRunResult,
} from '../src/cli/oma.js'
import type { AgentRunResult, TeamRunResult } from '../src/types.js'

describe('parseArgs', () => {
  it('parses flags, key=value, and key value', () => {
    const a = parseArgs(['node', 'oma', 'run', '--goal', 'hello', '--team=x.json', '--pretty'])
    expect(a._[0]).toBe('run')
    expect(a.kv.get('goal')).toBe('hello')
    expect(a.kv.get('team')).toBe('x.json')
    expect(a.flags.has('pretty')).toBe(true)
  })
})

describe('serializeTeamRunResult', () => {
  it('maps agentResults to a plain object', () => {
    const ar: AgentRunResult = {
      success: true,
      output: 'ok',
      messages: [],
      tokenUsage: { input_tokens: 1, output_tokens: 2 },
      toolCalls: [],
    }
    const tr: TeamRunResult = {
      success: true,
      agentResults: new Map([['alice', ar]]),
      totalTokenUsage: { input_tokens: 1, output_tokens: 2 },
    }
    const json = serializeTeamRunResult(tr, { pretty: false, includeMessages: false })
    expect(json.success).toBe(true)
    expect((json.agentResults as Record<string, unknown>)['alice']).toMatchObject({
      success: true,
      output: 'ok',
    })
    expect((json.agentResults as Record<string, unknown>)['alice']).not.toHaveProperty('messages')
  })

  it('includes messages when requested', () => {
    const ar: AgentRunResult = {
      success: true,
      output: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tokenUsage: { input_tokens: 0, output_tokens: 0 },
      toolCalls: [],
    }
    const tr: TeamRunResult = {
      success: true,
      agentResults: new Map([['bob', ar]]),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    }
    const json = serializeTeamRunResult(tr, { pretty: false, includeMessages: true })
    expect(serializeAgentResult(ar, true).messages).toHaveLength(1)
    expect((json.agentResults as Record<string, unknown>)['bob']).toHaveProperty('messages')
  })
})

describe('EXIT', () => {
  it('uses stable numeric codes', () => {
    expect(EXIT.SUCCESS).toBe(0)
    expect(EXIT.RUN_FAILED).toBe(1)
    expect(EXIT.USAGE).toBe(2)
    expect(EXIT.INTERNAL).toBe(3)
  })
})

describe('PROVIDER_REFERENCE', () => {
  it('includes the Doubao shortcut for provider list/template commands', () => {
    expect(PROVIDER_REFERENCE).toContainEqual(
      expect.objectContaining({
        id: 'doubao',
        apiKeyEnv: ['ARK_API_KEY'],
        baseUrlSupported: true,
      }),
    )
  })
})
