import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'

import type {
  ContentBlock,
  LLMMessage,
  ProcessBackendInputMode,
  TokenUsage,
} from '../types.js'
import { redactSensitiveText } from '../utils/redaction.js'
import type { RunResult } from './runner.js'

export const ZERO_PROCESS_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

export interface ProcessBackendOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly input?: ProcessBackendInputMode
  readonly systemPrompt?: string
  readonly agentName?: string
}

export function spawnProcess(
  options: ProcessBackendOptions,
  inputMode: ProcessBackendInputMode,
  prompt: string,
): ChildProcessWithoutNullStreams {
  const args = [...(options.args ?? [])]
  if (inputMode === 'argument') args.push(prompt)

  const child = spawn(options.command, args, {
    cwd: resolvePath(options.cwd ?? process.cwd()),
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  if (inputMode === 'stdin') {
    child.stdin.end(prompt)
  } else {
    child.stdin.end()
  }
  return child
}

export function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

export function buildPrompt(messages: LLMMessage[], systemPrompt?: string): string {
  const userText = lastUserText(messages)
  const role = systemPrompt?.trim()
  return [role, userText].filter(Boolean).join('\n\n')
}

export function cancelledResult(label: string, stdout = ''): RunResult {
  const output = stdout || `Process backend "${label}" cancelled.`
  return {
    messages: [],
    output,
    toolCalls: [],
    tokenUsage: ZERO_PROCESS_USAGE,
    turns: 0,
    aborted: true,
  }
}

export function processExitError(
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const detail = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
  const redactedStderr = redactSensitiveText(stderr.trim())
  const suffix = redactedStderr ? `: ${redactedStderr}` : ''
  return new Error(`Process backend "${label}" exited with ${detail}${suffix}`)
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function lastUserText(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    return message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }
  return ''
}
