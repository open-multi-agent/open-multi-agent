import { describe, it, expect } from 'vitest'
import { Agent } from '../src/agent/agent.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { ToolRegistry } from '../src/tool/framework.js'

function makeAgent(script: string): Agent {
  const registry = new ToolRegistry()
  return new Agent(
    {
      name: 'cli-worker',
      systemPrompt: 'You are a local process worker.',
      backend: {
        kind: 'process',
        command: process.execPath,
        args: ['-e', script],
      },
    },
    registry,
    new ToolExecutor(registry),
  )
}

describe('process backend', () => {
  it('runs a local process as an agent backend and sends the prompt on stdin', async () => {
    const agent = makeAgent(`
      process.stdin.setEncoding('utf8')
      let input = ''
      process.stdin.on('data', chunk => { input += chunk })
      process.stdin.on('end', () => {
        process.stdout.write('processed:' + input.trim())
      })
    `)

    const result = await agent.run('summarize checkout')

    expect(result.success).toBe(true)
    expect(result.output).toBe(
      'processed:You are a local process worker.\n\nsummarize checkout',
    )
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: result.output }],
      },
    ])
    expect(result.tokenUsage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('kills a pending process when the caller aborts the run', async () => {
    const agent = makeAgent(`
      process.stdin.resume()
      setTimeout(() => process.stdout.write('too late'), 10_000)
    `)
    const controller = new AbortController()

    const pending = agent.run('wait', { abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const result = await pending

    expect(result.success).toBe(false)
    expect(result.status.code).toBe('cancelled')
    expect(result.output).toContain('cancelled')
  })

  it('reports non-zero process exits without leaking secret stderr values', async () => {
    const agent = makeAgent(`
      process.stderr.write('api_key=super-secret-value\\n')
      process.exit(7)
    `)

    const result = await agent.run('fail')

    expect(result.success).toBe(false)
    expect(result.output).toContain('exited with code 7')
    expect(result.output).toContain('api_key=[redacted]')
    expect(result.output).not.toContain('super-secret-value')
  })
})
