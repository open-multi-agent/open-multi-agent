/**
 * @fileoverview {@link AgentBackend} that runs a generic local process.
 *
 * This backend is intentionally protocol-neutral: it sends one prompt to a
 * subprocess and maps stdout/stderr/exit into the same AgentBackend result shape
 * used by LLM and ACP-backed agents. Protocol-specific adapters can build on
 * their own backends; this covers simple CLIs and testable process lifecycle
 * semantics without introducing a new runtime dependency.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { LLMMessage, StreamEvent } from '../types.js'
import { killProcessTree, killProcessTreeAndWait } from '../utils/process-tree.js'
import type { AgentBackend, RunOptions, RunResult } from './runner.js'
import {
  ZERO_PROCESS_USAGE,
  buildPrompt,
  cancelledResult,
  processExitError,
  processOutputLimitError,
  spawnProcess,
  toError,
  waitForExit,
  type ProcessBackendOptions,
} from './process-backend-io.js'

export type { ProcessBackendOptions } from './process-backend-io.js'

export function createProcessBackend(options: ProcessBackendOptions): AgentBackend {
  return new ProcessBackend(options)
}

export class ProcessBackend implements AgentBackend {
  constructor(private readonly options: ProcessBackendOptions) {
    const { maxOutputBytes } = options
    if (maxOutputBytes !== undefined
      && (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1)) {
      throw new RangeError('ProcessBackendOptions.maxOutputBytes must be a positive integer.')
    }
  }

  async run(messages: LLMMessage[], options: RunOptions = {}): Promise<RunResult> {
    let result: RunResult = {
      messages: [],
      output: '',
      toolCalls: [],
      tokenUsage: ZERO_PROCESS_USAGE,
      turns: 0,
    }
    for await (const event of this.stream(messages, options)) {
      if (event.type === 'done') {
        result = event.data as RunResult
      } else if (event.type === 'error') {
        throw event.data
      }
    }
    return result
  }

  async *stream(messages: LLMMessage[], options: RunOptions = {}): AsyncGenerator<StreamEvent> {
    const label = this.options.agentName ?? 'process'
    const inputMode = this.options.input ?? 'stdin'
    const prompt = buildPrompt(messages, this.options.systemPrompt)

    if (inputMode !== 'none' && prompt.length === 0) {
      yield { type: 'error', data: new Error(`Process backend "${label}" received an empty prompt.`) }
      return
    }
    if (options.abortSignal?.aborted) {
      yield { type: 'done', data: cancelledResult(label) }
      return
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(this.options, inputMode, prompt)
    } catch (err) {
      yield { type: 'error', data: toError(err) }
      return
    }

    const abort = options.abortSignal
    const onAbort = () => killProcessTree(child)
    abort?.addEventListener('abort', onAbort, { once: true })

    let stdout = ''
    let stderr = ''
    const chunks: string[] = []
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let outputBytes = 0
    let outputLimitError: Error | undefined
    let wake: (() => void) | undefined
    const wakeReader = () => {
      wake?.()
      wake = undefined
    }

    let notifyOutputLimit: (error: Error) => void = () => {}
    const outputLimit = new Promise<{ kind: 'limit'; error: Error }>(resolve => {
      notifyOutputLimit = error => resolve({ kind: 'limit', error })
    })
    const acceptOutput = (chunk: Buffer, channel: 'stdout' | 'stderr') => {
      if (outputLimitError) return
      outputBytes += chunk.byteLength
      const maxOutputBytes = this.options.maxOutputBytes
      if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
        outputLimitError = processOutputLimitError(label, maxOutputBytes)
        killProcessTree(child)
        notifyOutputLimit(outputLimitError)
        return
      }
      if (channel === 'stdout') {
        const text = stdoutDecoder.write(chunk)
        stdout += text
        if (text) chunks.push(text)
      } else {
        stderr += stderrDecoder.write(chunk)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      acceptOutput(chunk, 'stdout')
      wakeReader()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      acceptOutput(chunk, 'stderr')
    })
    child.stdout.on('end', () => {
      if (outputLimitError) return
      const text = stdoutDecoder.end()
      stdout += text
      if (text) chunks.push(text)
      wakeReader()
    })
    child.stderr.on('end', () => {
      if (!outputLimitError) stderr += stderrDecoder.end()
    })

    const exit = waitForExit(child)
    let completed = false

    try {
      while (true) {
        while (chunks.length > 0) {
          yield { type: 'text', data: chunks.shift()! }
        }

        const outcome = await Promise.race([
          exit.then(result => ({ kind: 'exit' as const, result })),
          outputLimit,
          new Promise<{ kind: 'chunk' }>(resolve => { wake = () => resolve({ kind: 'chunk' }) }),
        ])

        if (outcome.kind === 'chunk') continue

        if (outcome.kind === 'limit') {
          await killProcessTreeAndWait(child, exit)
          yield { type: 'error', data: outcome.error }
          return
        }

        if (outputLimitError) {
          await killProcessTreeAndWait(child, exit)
          yield { type: 'error', data: outputLimitError }
          return
        }

        while (chunks.length > 0) {
          yield { type: 'text', data: chunks.shift()! }
        }
        completed = true

        if (abort?.aborted) {
          yield { type: 'done', data: cancelledResult(label, stdout) }
          return
        }

        if (outcome.result.code !== 0) {
          yield { type: 'error', data: processExitError(label, outcome.result.code, outcome.result.signal, stderr) }
          return
        }

        const output = stdout
        const assistantMsg = output
          ? ({ role: 'assistant', content: [{ type: 'text', text: output }] } satisfies LLMMessage)
          : undefined
        if (assistantMsg) options.onMessage?.(assistantMsg)
        yield {
          type: 'done',
          data: {
            messages: assistantMsg ? [assistantMsg] : [],
            output,
            toolCalls: [],
            tokenUsage: ZERO_PROCESS_USAGE,
            turns: 1,
          } satisfies RunResult,
        }
        return
      }
    } catch (err) {
      yield { type: 'error', data: toError(err) }
    } finally {
      abort?.removeEventListener('abort', onAbort)
      wakeReader()
      if (!completed) {
        if (child.exitCode !== null || child.signalCode !== null) {
          killProcessTree(child)
        } else {
          await killProcessTreeAndWait(child, exit)
        }
      }
    }
  }
}
