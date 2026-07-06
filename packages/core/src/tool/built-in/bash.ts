/**
 * Built-in bash tool.
 *
 * Executes a shell command and returns its stdout + stderr.  Supports an
 * optional timeout and a custom working directory.
 */

import { spawn, type ChildProcess } from 'child_process'
import { z } from 'zod'
import { defineTool } from '../framework.js'
import { isSensitiveName, redactSensitiveText } from '../../utils/redaction.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const SAFE_ENV_ALLOWLIST = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
])

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const bashTool = defineTool({
  name: 'bash',
  description:
    'Execute a bash command and return its stdout and stderr. ' +
    'Use this for file system operations, running scripts, installing packages, ' +
    'and any task that requires shell access. ' +
    'The command runs in a non-interactive shell (bash -c). ' +
    'Long-running commands should use the timeout parameter.',

  inputSchema: z.object({
    command: z.string().describe('The bash command to execute.'),
    timeout: z
      .number()
      .optional()
      .describe(
        `Timeout in milliseconds before the command is forcibly killed. ` +
          `Defaults to ${DEFAULT_TIMEOUT_MS} ms.`,
      ),
    cwd: z
      .string()
      .optional()
      .describe('Working directory in which to run the command.'),
  }),

  execute: async (input, context) => {
    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS

    const { stdout, stderr, exitCode } = await runCommand(
      input.command,
      { cwd: input.cwd, timeoutMs },
      context.abortSignal,
    )

    const combined = redactSensitiveText(buildOutput(stdout, stderr, exitCode))
    const isError = exitCode !== 0

    return {
      data: combined,
      isError,
    }
  },
})

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface RunOptions {
  cwd: string | undefined
  timeoutMs: number
}

/**
 * Spawn a bash subprocess, capture its output, and resolve when it exits or
 * the abort signal fires.
 */
function runCommand(
  command: string,
  options: RunOptions,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    const child = spawn('bash', ['-c', command], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: buildSafeShellEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    let timedOut = false
    let aborted = false
    let settled = false

    const done = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort)
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')

      resolve({ stdout, stderr, exitCode })
    }

    // Timeout handler — kill the whole process group so backgrounded
    // children (`(sleep 5; ...) &`) do not outlive the parent.
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, options.timeoutMs)

    // Abort-signal handler — same process-group cleanup as the timeout.
    const onAbort = (): void => {
      aborted = true
      killProcessTree(child)
    }

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // `close` (process exited AND stdio drained) is the normal completion
    // path. After a forced kill we settle on `exit` instead: on Windows,
    // MSYS bash's fork emulation can leave descendants that taskkill cannot
    // reach (their recorded parent PID is a dead intermediate process), and
    // any such straggler would hold the stdio pipes open and delay `close`
    // until it exits naturally.
    //
    // When we killed the process ourselves, report the conventional exit
    // codes (124 timeout / 130 abort) authoritatively: the code the OS
    // reports for a forced termination is platform-dependent (`null` after
    // SIGKILL on POSIX, `1` after taskkill on Windows).
    const resolveExitCode = (code: number | null): number => {
      if (timedOut) return 124
      if (aborted) return 130
      return code ?? 1
    }

    child.on('close', (code: number | null) => {
      done(resolveExitCode(code))
    })

    child.on('exit', (code: number | null) => {
      if (timedOut || aborted) {
        done(resolveExitCode(code))
      }
    })

    child.on('error', (err: Error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        if (signal !== undefined) {
          signal.removeEventListener('abort', onAbort)
        }
        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 127,
        })
      }
    })
  })
}

/**
 * Kill the child and any descendants spawned through `&` / job-control.
 *
 * POSIX: we rely on `detached: true` at spawn time, which puts the bash
 * shell in its own process group; sending SIGKILL to the negated PID
 * delivers to every member of that group.
 *
 * Windows: there are no POSIX process groups, and `child.kill()` terminates
 * only the direct child — orphaned descendants would both survive and hold
 * the stdio pipes open, delaying the `close` event until they exit. Use
 * `taskkill /T /F` (always present in System32) to terminate the whole tree.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    })
    // taskkill fails when the tree already exited; direct kill is then a no-op.
    killer.on('error', () => child.kill('SIGKILL'))
    killer.on('exit', (code) => {
      if (code !== 0) child.kill('SIGKILL')
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The child may already have exited; fall through to a direct kill,
    // which is a no-op in that case.
    child.kill('SIGKILL')
  }
}

function buildSafeShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!SAFE_ENV_ALLOWLIST.has(name)) continue
    if (isSensitiveName(name)) continue
    safeEnv[name] = value
  }
  return safeEnv
}

/**
 * Format captured output into a single readable string.
 * When only stdout is present its content is returned as-is.
 * When stderr is also present both sections are labelled.
 */
function buildOutput(stdout: string, stderr: string, exitCode: number): string {
  const parts: string[] = []

  if (stdout.length > 0) {
    parts.push(stdout)
  }

  if (stderr.length > 0) {
    parts.push(
      stdout.length > 0
        ? `--- stderr ---\n${stderr}`
        : stderr,
    )
  }

  if (parts.length === 0) {
    return exitCode === 0
      ? '(command completed with no output)'
      : `(command exited with code ${exitCode}, no output)`
  }

  if (exitCode !== 0 && parts.length > 0) {
    parts.push(`\n(exit code: ${exitCode})`)
  }

  return parts.join('\n')
}
