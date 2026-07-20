import { describe, expect, it, vi } from 'vitest'
import {
  resolvePostScaffoldActions,
  runPostScaffold,
  type CommandRunner,
} from '../src/post-scaffold.js'

describe('post-scaffold flow', () => {
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
