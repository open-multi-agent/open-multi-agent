import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { Agent } from '../src/agent/agent.js'
import { createProcessBackend } from '../src/agent/process-backend.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { ToolRegistry } from '../src/tool/framework.js'

function makeAgent(script: string, maxOutputBytes?: number): Agent {
  const registry = new ToolRegistry()
  return new Agent(
    {
      name: 'cli-worker',
      systemPrompt: 'You are a local process worker.',
      backend: {
        kind: 'process',
        command: process.execPath,
        args: ['-e', script],
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      },
    },
    registry,
    new ToolExecutor(registry),
  )
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const start = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${path}`)
    }
    await delay(10)
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const start = Date.now()
  while (true) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return
      throw err
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for process ${pid} to exit`)
    }
    await delay(10)
  }
}

function descendantMarkerScript(
  markerPath: string,
  options: { readyPath?: string; writeReady?: boolean } = {},
): string {
  const childScript = `
    const fs = require('node:fs')
    process.on('SIGHUP', () => {})
    process.on('SIGTERM', () => {})
    setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, 'alive'), 350)
    setTimeout(() => {}, 10_000)
  `
  return `
    const { spawn } = require('node:child_process')
    const fs = require('node:fs')
    const child = spawn(process.execPath, [
      '-e',
      ${JSON.stringify(childScript)}
    ], { stdio: 'ignore' })
    child.unref()
    ${options.readyPath ? `fs.writeFileSync(${JSON.stringify(options.readyPath)}, 'ready')` : ''}
    ${options.writeReady ? "process.stdout.write('ready\\n')" : ''}
    setTimeout(() => {}, 10_000)
  `
}

function exitedParentDescendantScript(markerPath: string): string {
  const childScript = `
    const fs = require('node:fs')
    process.on('SIGHUP', () => {})
    process.on('SIGTERM', () => {})
    setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, 'alive'), 350)
    setTimeout(() => {}, 10_000)
  `
  return `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, [
      '-e',
      ${JSON.stringify(childScript)}
    ], { stdio: 'ignore' })
    child.unref()
    process.stdout.write(String(process.pid) + '\\n')
  `
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('process backend lifecycle cleanup', () => {
  it('kills descendant processes when a run is aborted', async () => {
    const marker = join(tmpdir(), `oma-process-abort-${process.pid}-${Date.now()}`)
    const ready = join(tmpdir(), `oma-process-abort-ready-${process.pid}-${Date.now()}`)
    await rm(marker, { force: true })
    await rm(ready, { force: true })
    const agent = makeAgent(descendantMarkerScript(marker, { readyPath: ready }))
    const controller = new AbortController()

    const pending = agent.run('wait', { abortSignal: controller.signal })
    await waitForFile(ready)
    controller.abort()
    const result = await pending
    await delay(700)

    expect(result.success).toBe(false)
    expect(result.status.code).toBe('cancelled')
    expect(existsSync(marker)).toBe(false)
    await rm(ready, { force: true })
  })

  it('kills descendant processes when stream consumption stops early', async () => {
    const marker = join(tmpdir(), `oma-process-stream-${process.pid}-${Date.now()}`)
    await rm(marker, { force: true })
    const agent = makeAgent(descendantMarkerScript(marker, { writeReady: true }))

    for await (const event of agent.stream('wait')) {
      if (event.type === 'text') break
    }
    await delay(700)

    expect(existsSync(marker)).toBe(false)
  })

  it('kills the process when output exceeds the configured limit', async () => {
    const backend = createProcessBackend({
      command: process.execPath,
      args: ['-e', `
        process.stdout.write(String(process.pid) + '\\n')
        setTimeout(() => process.stdout.write('x'.repeat(100)), 20)
        setTimeout(() => {}, 10_000)
      `],
      input: 'none',
      maxOutputBytes: 32,
    })
    let childPid: number | undefined
    let errorMessage = ''

    for await (const event of backend.stream([])) {
      if (event.type === 'text') childPid = Number(event.data.trim())
      if (event.type === 'error') errorMessage = event.data.message
    }

    expect(childPid).toBeTypeOf('number')
    expect(errorMessage).toContain('exceeded the maxOutputBytes limit of 32 bytes')
    await waitForProcessExit(childPid!, 2_000)
  })

  it.skipIf(process.platform === 'win32')(
    'kills descendant processes when output exceeds the configured limit',
    async () => {
      const marker = join(tmpdir(), `oma-process-output-limit-${process.pid}-${Date.now()}`)
      await rm(marker, { force: true })
      const agent = makeAgent(descendantMarkerScript(marker, { writeReady: true }), 1)

      const result = await agent.run('emit too much')
      await delay(700)

      expect(result.success).toBe(false)
      expect(result.output).toContain('exceeded the maxOutputBytes limit of 1 bytes')
      expect(existsSync(marker)).toBe(false)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'kills descendants after the direct child exits before stream closure',
    async () => {
      const marker = join(tmpdir(), `oma-process-exited-parent-${process.pid}-${Date.now()}`)
      await rm(marker, { force: true })
      const agent = makeAgent(exitedParentDescendantScript(marker))

      for await (const event of agent.stream('wait')) {
        if (event.type !== 'text') continue
        await waitForProcessExit(Number(event.data.trim()))
        break
      }
      await delay(700)

      expect(existsSync(marker)).toBe(false)
    },
  )

})
