import { describe, it, expect } from 'vitest'
import { Agent } from '../src/agent/agent.js'
import { OpenMultiAgent } from '../src/orchestrator/orchestrator.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { ToolRegistry } from '../src/tool/framework.js'
import type { AgentConfig } from '../src/types.js'

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

function processAgent(name: string, script: string): AgentConfig {
  return {
    name,
    systemPrompt: `${name} runs as a local process.`,
    backend: {
      kind: 'process',
      command: process.execPath,
      args: ['-e', script],
    },
  }
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

  it('participates in runTasks dependency handoff through shared memory', async () => {
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('process-team', {
      name: 'process-team',
      sharedMemory: true,
      agents: [
        processAgent('researcher', `
          process.stdin.resume()
          process.stdout.write('research-output')
        `),
        processAgent('reviewer', `
          process.stdin.setEncoding('utf8')
          let input = ''
          process.stdin.on('data', chunk => { input += chunk })
          process.stdin.on('end', () => {
            process.stdout.write(input.includes('research-output') ? 'review saw research' : 'missing context')
          })
        `),
      ],
    })

    const result = await oma.runTasks(team, [
      { title: 'Research', description: 'Gather context', assignee: 'researcher' },
      { title: 'Review', description: 'Review prior output', assignee: 'reviewer', dependsOn: ['Research'] },
    ])

    expect(result.success).toBe(true)
    expect(result.agentResults.get('researcher')?.output).toBe('research-output')
    expect(result.agentResults.get('reviewer')?.output).toBe('review saw research')
    const researchTask = result.tasks?.find(task => task.title === 'Research')
    expect(researchTask?.status).toBe('completed')
    await expect(
      team.getSharedMemoryInstance()?.read(`researcher/task:${researchTask?.id}:result`),
    ).resolves.toMatchObject({ value: 'research-output' })
  })

  it('isolates process failures by preventing dependent tasks from running', async () => {
    const oma = new OpenMultiAgent({ defaultModel: 'mock-model' })
    const team = oma.createTeam('process-failure-team', {
      name: 'process-failure-team',
      sharedMemory: true,
      agents: [
        processAgent('coder', `process.stderr.write('boom'); process.exit(3)`),
        processAgent('reviewer', `process.stdout.write('should not run')`),
      ],
    })

    const result = await oma.runTasks(team, [
      { title: 'Code', description: 'Write code', assignee: 'coder' },
      { title: 'Review', description: 'Review code', assignee: 'reviewer', dependsOn: ['Code'] },
    ])

    expect(result.success).toBe(false)
    expect(result.tasks?.find(task => task.title === 'Code')?.status).toBe('failed')
    expect(result.tasks?.find(task => task.title === 'Review')?.status).toBe('failed')
    expect(result.agentResults.get('coder')?.output).toContain('exited with code 3')
    expect(result.agentResults.has('reviewer')).toBe(false)
  })
})
