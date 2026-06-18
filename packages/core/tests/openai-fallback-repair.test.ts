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
                arguments: '{"command": "echo \"hello\""}'
              }
            }
          ]
        }
      }]
    }
    const result = fromOpenAICompletion(raw as any)
    expect((result.content[0] as any).input).toEqual({ command: 'echo "hello"' })
  })

  it('falls back to regex for python triple double quotes', () => {
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
                name: 'generic_tool',
                arguments: '{"generic_param": """print("Unescaped JSON!")\nx=2"""}'
              }
            }
          ]
        }
      }]
    }
    const result = fromOpenAICompletion(raw as any)
    expect((result.content[0] as any).input).toEqual({ generic_param: 'print("Unescaped JSON!")\nx=2' })
  })

  it('falls back to regex for python triple single quotes', () => {
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
                name: 'generic_tool',
                arguments: "{\"generic_param\": '''print(\"Unescaped JSON!\")\nx=2'''}"
              }
            }
          ]
        }
      }]
    }
    const result = fromOpenAICompletion(raw as any)
    expect((result.content[0] as any).input).toEqual({ generic_param: 'print("Unescaped JSON!")\nx=2' })
  })

  it('falls back to regex for standard quotes with unescaped content', () => {
    const raw = {
      choices: [{
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call_4',
              type: 'function' as const,
              function: {
                name: 'generic_tool',
                arguments: '{"generic_param": "echo \"unescaped\"\nnewline"}'
              }
            }
          ]
        }
      }]
    }
    const result = fromOpenAICompletion(raw as any)
    expect((result.content[0] as any).input).toEqual({ generic_param: 'echo "unescaped"\nnewline' })
  })

  it('fails gracefully when regex does not match', () => {
    const raw = {
      choices: [{
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call_5',
              type: 'function' as const,
              function: {
                name: 'bash',
                arguments: '{"command": echo hello'
              }
            }
          ]
        }
      }]
    }
    const result = fromOpenAICompletion(raw as any)
    expect((result.content[0] as any).input).toEqual({})
  })
})