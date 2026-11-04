import { describe, expect, it, vi } from 'vitest'
import {
  demoFailureGuidance,
  resolvePostScaffoldActions,
  runPostScaffold,
  type CommandRunner,
} from '../src/post-scaffold.js'

describe('post-scaffold flow', () => {
  it('suggests a newer Node release only for the reported demo crash version', () => {
    expect(demoFailureGuidance('v20.0.0')).toContain('Node.js 22 or 24')
    expect(demoFailureGuidance('v20.1.0')).toBeUndefined()
    expect(demoFailureGuidance('v22.0.0')).toBeUndefined()
    expect(demoFailureGuidance('v24.13.0')).toBeUndefined()
  })
  it('installs and runs only for interactive callers without opt-outs', () => {
    expect(resolvePostScaffoldActions({ interactive: true, noInstall: false, noRun: false }))
      .toEqual({ install: true, runDemo: true })
    expect(resolvePostScaffoldActions({ interactive: false, noInstall: false, noRun: false }))
      .toEqual({ install: false, runDemo: false })
    expect(resolvePostScaffoldActions({ interactive: true, noInstall: true, noRun: false }))
      .toEqual({ install: false, runDemo: false })
    expect(resolvePostScaffoldActions({ interactive: true, noInstall: false, noRun: true }))
      .toEqual({ install: true, runDemo: false })
  })

  it('runs install before demo in the generated project', () => {
    const runner = vi.fn<CommandRunner>(() => ({ status: 0 }))
    expect(runPostScaffold('/tmp/generated', { install: true, runDemo: true }, runner)).toEqual({ ok: true })
    expect(runner.mock.calls).toEqual([
      ['npm', ['install', '--no-audit', '--no-fund'], '/tmp/generated'],
      ['npm', ['run', 'demo'], '/tmp/generated'],
    ])
  })

  it('stops after an install failure and reports the failed step', () => {
    const runner = vi.fn<CommandRunner>(() => ({ status: 1 }))
    expect(runPostScaffold('/tmp/generated', { install: true, runDemo: true }, runner))
      .toEqual({ ok: false, failedStep: 'install' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('keeps an installed project when the demo fails', () => {
    const runner = vi.fn<CommandRunner>()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 })
    expect(runPostScaffold('/tmp/generated', { install: true, runDemo: true }, runner))
      .toEqual({ ok: false, failedStep: 'demo' })
    expect(runner).toHaveBeenCalledTimes(2)
  })
})

describe('successful CLI output', () => {
  it('shows how to rerun the demo from a project path with spaces', async () => {
    const originalArgv = process.argv
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const output: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push(args.map(String).join(' '))
    })
    try {
      process.argv = ['node', 'create-oma-app', 'my project', '--template', 'demo', '--provider', 'cloud']
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
      vi.doMock('../src/scaffold.js', () => ({
        isNonEmptyDir: () => false,
        scaffold: vi.fn(),
      }))
      vi.doMock('../src/post-scaffold.js', async () => ({
        ...await vi.importActual<typeof import('../src/post-scaffold.js')>('../src/post-scaffold.js'),
        runPostScaffold: () => ({ ok: true }),
      }))
      vi.resetModules()
      await import('../src/index.js')

      const text = output.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
      expect(text).toContain('No-key demo complete.')
      expect(text).toMatch(/cd "my project"\s*\n\s*npm run demo/)
      expect(text).not.toContain('npm install --no-audit --no-fund')

      output.length = 0
      process.argv = ['node', 'create-oma-app', 'my project', '--template', 'demo', '--provider', 'cloud', '--no-run']
      vi.resetModules()
      await import('../src/index.js')
      const noRunText = output.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
      expect(noRunText).toContain('Dependencies installed.')
      expect(noRunText).toMatch(/cd "my project"\s*\n\s*npm run demo/)
    } finally {
      process.argv = originalArgv
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY)
      else Reflect.deleteProperty(process.stdin, 'isTTY')
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY)
      else Reflect.deleteProperty(process.stdout, 'isTTY')
      log.mockRestore()
      vi.doUnmock('../src/scaffold.js')
      vi.doUnmock('../src/post-scaffold.js')
      vi.resetModules()
    }
  })
})
