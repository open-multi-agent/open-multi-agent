import { describe, it, expect } from 'vitest'
import { extractToolCallsFromText } from '../src/tool/text-tool-extractor.js'

const TOOLS = ['bash', 'file_read', 'file_write']

describe('extractToolCallsFromText', () => {
  // -------------------------------------------------------------------------
  // No tool calls
  // -------------------------------------------------------------------------

  it('returns empty array for empty text', () => {
    expect(extractToolCallsFromText('', TOOLS)).toEqual([])
  })

  it('returns empty array for plain text with no JSON', () => {
    expect(extractToolCallsFromText('Hello, I am a helpful assistant.', TOOLS)).toEqual([])
  })

  it('returns empty array for JSON that does not match any known tool', () => {
    const text = '{"name": "unknown_tool", "arguments": {"x": 1}}'
    expect(extractToolCallsFromText(text, TOOLS)).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Bare JSON
  // -------------------------------------------------------------------------

  it('extracts a bare JSON tool call with "arguments"', () => {
    const text = 'I will run this command:\n{"name": "bash", "arguments": {"command": "ls -la"}}'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('tool_use')
    expect(result[0]!.name).toBe('bash')
    expect(result[0]!.input).toEqual({ command: 'ls -la' })
    expect(result[0]!.id).toMatch(/^extracted_call_/)
  })

  it('extracts a bare JSON tool call with "parameters"', () => {
    const text = '{"name": "file_read", "parameters": {"path": "/tmp/test.txt"}}'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('file_read')
    expect(result[0]!.input).toEqual({ path: '/tmp/test.txt' })
  })

  it('extracts a bare JSON tool call with "input"', () => {
    const text = '{"name": "bash", "input": {"command": "pwd"}}'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('bash')
    expect(result[0]!.input).toEqual({ command: 'pwd' })
  })

  it('extracts { function: { name, arguments } } shape', () => {
    const text = '{"function": {"name": "bash", "arguments": {"command": "echo hi"}}}'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('bash')
    expect(result[0]!.input).toEqual({ command: 'echo hi' })
  })

  it('handles string-encoded arguments', () => {
    const text = '{"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.input).toEqual({ command: 'ls' })
  })

  // -------------------------------------------------------------------------
  // Multiple tool calls
  // -------------------------------------------------------------------------

  it('extracts multiple tool calls from text', () => {
    const text = `Let me do two things:
{"name": "bash", "arguments": {"command": "ls"}}
And then:
{"name": "file_read", "arguments": {"path": "/tmp/x"}}`
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('bash')
    expect(result[1]!.name).toBe('file_read')
  })

  // -------------------------------------------------------------------------
  // Code fence wrapped
  // -------------------------------------------------------------------------

  it('extracts tool call from markdown code fence', () => {
    const text = 'Here is the tool call:\n```json\n{"name": "bash", "arguments": {"command": "whoami"}}\n```'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('bash')
    expect(result[0]!.input).toEqual({ command: 'whoami' })
  })

  it('extracts tool call from code fence without language tag', () => {
    const text = '```\n{"name": "file_write", "arguments": {"path": "/tmp/a.txt", "content": "hi"}}\n```'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('file_write')
  })

  // -------------------------------------------------------------------------
  // Hermes format
  // -------------------------------------------------------------------------

  it('extracts tool call from <tool_call> tags', () => {
    const text = '<tool_call>\n{"name": "bash", "arguments": {"command": "date"}}\n</tool_call>'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('bash')
    expect(result[0]!.input).toEqual({ command: 'date' })
  })

  it('extracts multiple hermes tool calls', () => {
    const text = `<tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>
Some text in between
<tool_call>{"name": "file_read", "arguments": {"path": "/tmp/x"}}</tool_call>`
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('bash')
    expect(result[1]!.name).toBe('file_read')
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('skips malformed JSON gracefully', () => {
    const text = '{"name": "bash", "arguments": {invalid json}}'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toEqual([])
  })

  it('skips JSON objects without a name field', () => {
    const text = '{"command": "ls", "arguments": {"x": 1}}'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toEqual([])
  })

  it('works with empty knownToolNames (no whitelist filtering)', () => {
    const text = '{"name": "anything", "arguments": {"x": 1}}'
    const result = extractToolCallsFromText(text, [])
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('anything')
  })

  it('generates unique IDs for each extracted call', () => {
    const text = `{"name": "bash", "arguments": {"command": "a"}}
{"name": "bash", "arguments": {"command": "b"}}`
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(2)
    expect(result[0]!.id).not.toBe(result[1]!.id)
  })

  it('handles tool call with no arguments', () => {
    const text = '{"name": "bash"}'
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.input).toEqual({})
  })

  it('handles text with nested JSON objects that are not tool calls', () => {
    const text = `Here is some config: {"port": 3000, "host": "localhost"}
And a tool call: {"name": "bash", "arguments": {"command": "ls"}}`
    const result = extractToolCallsFromText(text, TOOLS)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('bash')
  })
})
