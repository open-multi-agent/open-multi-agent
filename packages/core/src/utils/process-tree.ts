import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_KILL_WAIT_MS = 1_000

/**
 * Kill a child process and its descendants.
 *
 * POSIX: callers must spawn the child with `detached: true`, which creates a
 * process group. Sending SIGKILL to `-pid` terminates every process in it.
 *
 * Windows: `taskkill /T /F` terminates the process tree.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    })
    killer.on('error', () => child.kill('SIGKILL'))
    killer.on('exit', (code) => {
      if (code !== 0) child.kill('SIGKILL')
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export async function killProcessTreeAndWait(
  child: ChildProcess,
  exit: Promise<unknown>,
  waitMs = DEFAULT_KILL_WAIT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  killProcessTree(child)
  await Promise.race([
    exit.catch(() => undefined),
    new Promise(resolve => setTimeout(resolve, waitMs)),
  ])
}
