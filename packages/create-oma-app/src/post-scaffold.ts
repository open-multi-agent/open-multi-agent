import { spawnSync } from 'node:child_process'

export interface PostScaffoldActions {
  readonly install: boolean
  readonly runDemo: boolean
}

export interface CommandResult {
  readonly status: number | null
  readonly error?: Error
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => CommandResult

export interface PostScaffoldResult {
  readonly ok: boolean
  readonly failedStep?: 'install' | 'demo'
  readonly error?: Error
}

export function resolvePostScaffoldActions(options: {
  readonly interactive: boolean
  readonly noInstall: boolean
  readonly noRun: boolean
}): PostScaffoldActions {
  if (!options.interactive || options.noInstall) {
    return { install: false, runDemo: false }
  }
  return { install: true, runDemo: !options.noRun }
}

export const runCommand: CommandRunner = (command, args, cwd) => {
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command
  const result = spawnSync(executable, [...args], { cwd, stdio: 'inherit' })
  return {
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  }
}

export function runPostScaffold(
  targetDir: string,
  actions: PostScaffoldActions,
  runner: CommandRunner = runCommand,
): PostScaffoldResult {
  if (actions.install) {
    const install = runner('npm', ['install', '--no-audit', '--no-fund'], targetDir)
    if (install.error || install.status !== 0) {
      return { ok: false, failedStep: 'install', ...(install.error ? { error: install.error } : {}) }
    }
  }

  if (actions.runDemo) {
    const demo = runner('npm', ['run', 'demo'], targetDir)
    if (demo.error || demo.status !== 0) {
      return { ok: false, failedStep: 'demo', ...(demo.error ? { error: demo.error } : {}) }
    }
  }

  return { ok: true }
}
