import { describe, it, expect } from 'vitest'
import { fromOpenAICompletion } from '../src/llm/openai-common.js'

describe('fromOpenAICompletion - JSON Parse Fallback', () => {
  it('safely parses standard JSON', () => {
    const raw = {
      choices: [{
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: {
                name: 'bash',
                arguments: '{"command": "echo \\"hello\\""}'
              }
            }
          ]
        }
      }]
    }
    const result = fromOpenAICompletion(raw as any)
    expect((result.content[0] as any).input).toEqual({ command: 'echo "hello"' })
  })

  it('falls back to regex for python triple quotes', () => {
    const raw = {
      choices: [{
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call_2',
              type: 'function' as const,
              function: {
                name: 'run_python_script',
                arguments: '{"code": """print("Unescaped JSON!")"""}'
              }
            }
          ]
        }
      }]
    }
    const result = fromOpenAICompletion(raw as any)
    expect((result.content[0] as any).input).toEqual({ code: 'print("Unescaped JSON!")' })
  })

  it('fails gracefully when regex does not match', () => {
    const raw = {
      choices: [{
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call_3',
              type: 'function' as const,
              function: {
                name: 'bash',
                arguments: '{"command": echo hello' // invalid JSON and regex fails
              }
            }
          ]
        }
      }]
    }
    const result = fromOpenAICompletion(raw as any)
    expect((result.content[0] as any).input).toEqual({}) // Returns empty object on complete failure
  })
})
