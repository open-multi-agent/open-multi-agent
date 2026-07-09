/**
 * @fileoverview {@link AgentBackend} that drives an external coding agent over the
 * Agent Client Protocol (ACP).
 *
 * OMA takes the ACP **client** role: it spawns the agent (a local CLI such as
 * Gemini CLI or Claude Code) as a subprocess, exchanges JSON-RPC over stdio, and
 * turns one `session/prompt` turn into a {@link RunResult}. This lets an ACP agent
 * sit in the same task DAG as LLM agents — with shared memory, cascade-on-failure,
 * and token budget — because it satisfies the same {@link AgentBackend} contract.
 *
 * Requires the optional peer dependency `@agentclientprotocol/sdk`, loaded lazily
 * so the three-runtime-dependency promise holds for consumers that never use ACP.
 * Reached only through `AgentConfig.backend` (see {@link Agent}) or the
 * `@open-multi-agent/core/acp` subpath — never imported by the package root.
 *
 * v1 scope: OMA is the client only; the agent performs its own filesystem access
 * within `cwd` (client-side `fs/*` proxying is intentionally not implemented yet).
 */

import { spawn } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { Readable, Writable } from 'node:stream'

import type {
  ActiveSession,
  CancelNotification,
  ClientApp,
  ClientConnection,
  ClientContext,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  StopReason,
} from '@agentclientprotocol/sdk'

import type {
  AcpPermissionPolicy,
  AcpPermissionRequest,
  ContentBlock,
  LLMMessage,
  StreamEvent,
  TokenUsage,
  ToolCallRecord,
} from '../types.js'
import type { AgentBackend, RunOptions, RunResult } from './runner.js'

/** The `@agentclientprotocol/sdk` module shape, resolved lazily. */
type AcpSdkModule = typeof import('@agentclientprotocol/sdk')

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

/** A live ACP client connection paired with its teardown. */
export interface AcpConnection {
  readonly connection: ClientConnection
  dispose(): Promise<void> | void
}

/** Options for {@link createAcpBackend} / {@link AcpBackend}. */
export interface AcpBackendOptions {
  /** Executable to spawn (e.g. `'npx'`, `'gemini'`, `'codex-acp'`). */
  readonly command: string
  /** Arguments passed to `command` (e.g. `['-y', '@agentclientprotocol/claude-agent-acp']`). */
  readonly args?: readonly string[]
  /** Extra environment variables for the subprocess, merged over `process.env`. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory the agent reads and edits. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** How to answer the agent's permission prompts. Defaults to `'auto-approve'`. */
  readonly permission?: AcpPermissionPolicy
  /** Agent name, used as the ACP client identity and in error messages. */
  readonly agentName?: string
  /** Model/label, forwarded only for diagnostics. */
  readonly model?: string
  /** Advisory per-call timeout hint (unused today; reserved). */
  readonly callTimeoutMs?: number
  /**
   * Test seam. Given the configured {@link ClientApp}, return an open connection
   * instead of spawning `command` — e.g. `app.connect(fakeAgentApp)` for an
   * in-process fake agent. Defaults to spawning a subprocess and framing its
   * stdio as newline-delimited JSON-RPC.
   */
  readonly connect?: (app: ClientApp, sdk: AcpSdkModule) => AcpConnection | Promise<AcpConnection>
}

/** Construct an ACP-backed {@link AgentBackend}. The subprocess is spawned lazily on first run. */
export function createAcpBackend(options: AcpBackendOptions): AgentBackend {
  return new AcpBackend(options)
}

/**
 * {@link AgentBackend} implementation backed by an ACP subprocess.
 *
 * The subprocess + session are created on the first `run`/`stream` and reused for
 * subsequent calls (preserving conversation context). Call {@link dispose} to
 * close the connection and kill the subprocess.
 */
export class AcpBackend implements AgentBackend {
  private readonly options: AcpBackendOptions
  private sdk: AcpSdkModule | null = null
  private conn: AcpConnection | null = null
  private ctx: ClientContext | null = null
  private session: ActiveSession | null = null
  private starting: Promise<void> | null = null

  constructor(options: AcpBackendOptions) {
    this.options = options
  }

  /** Run one prompt turn to completion and return the aggregated {@link RunResult}. */
  async run(messages: LLMMessage[], options: RunOptions = {}): Promise<RunResult> {
    let result: RunResult = {
      messages: [],
      output: '',
      toolCalls: [],
      tokenUsage: ZERO_USAGE,
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

  /** Run one prompt turn, yielding `text` deltas then a terminal `done`/`error` event. */
  async *stream(messages: LLMMessage[], options: RunOptions = {}): AsyncGenerator<StreamEvent> {
    const label = this.options.agentName ?? 'agent'
    const userText = lastUserText(messages)
    if (!userText) {
      yield { type: 'error', data: new Error(`ACP backend "${label}" received an empty prompt.`) }
      return
    }

    let session: ActiveSession
    let ctx: ClientContext
    try {
      const started = await this.ensureSession()
      session = started.session
      ctx = started.ctx
    } catch (err) {
      yield { type: 'error', data: toError(err) }
      return
    }

    const abort = options.abortSignal
    const toolCalls: ToolCallRecord[] = []
    // Tool metadata seen on the initial `tool_call` event, finalized on the
    // completing `tool_call_update` (which may omit the title/input).
    const toolMeta = new Map<string, { start: number; title?: string; input?: Record<string, unknown> }>()
    const assistantText: string[] = []
    let usedTokens = 0

    // Wire abort → session/cancel; a well-behaved agent replies with a
    // `cancelled` stop, which ends the drain loop below.
    const onAbort = (): void => {
      void ctx
        .notify('session/cancel', { sessionId: session.sessionId } satisfies CancelNotification)
        .catch(() => {})
    }
    if (abort) {
      if (abort.aborted) onAbort()
      else abort.addEventListener('abort', onAbort, { once: true })
    }

    try {
      // Fire the prompt; its completion is also queued as a `stop` message for
      // nextUpdate(). Attach a no-op catch now, then propagate after draining.
      const promptPromise = session.prompt(userText)
      promptPromise.catch(() => {})

      let stopReason: StopReason = 'end_turn'
      while (true) {
        const msg = await session.nextUpdate()
        if (msg.kind === 'stop') {
          stopReason = msg.stopReason
          break
        }
        const update = msg.update
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            if (update.content.type === 'text') {
              assistantText.push(update.content.text)
              yield { type: 'text', data: update.content.text }
            }
            break
          }
          case 'tool_call': {
            toolMeta.set(update.toolCallId, {
              start: Date.now(),
              title: update.title ?? undefined,
              input: asRecord(update.rawInput),
            })
            break
          }
          case 'tool_call_update': {
            if (update.status === 'completed' || update.status === 'failed') {
              const meta = toolMeta.get(update.toolCallId)
              toolCalls.push({
                toolName: update.title ?? meta?.title ?? update.toolCallId,
                input: update.rawInput !== undefined ? asRecord(update.rawInput) : meta?.input ?? {},
                output: toolOutputText(update.rawOutput, update.content),
                duration: Math.max(0, Date.now() - (meta?.start ?? Date.now())),
              })
            }
            break
          }
          case 'usage_update': {
            // ACP reports a single context-token figure, not an input/output
            // split; record it as the run's total (see docs/external-agents.md).
            usedTokens = update.used
            break
          }
          default:
            break
        }
      }

      // Surface a late prompt rejection (e.g. transport failure at turn end).
      await promptPromise

      const output = assistantText.join('')

      // A refusal is a task failure — dependents should not proceed on it.
      if (stopReason === 'refusal') {
        yield {
          type: 'error',
          data: new Error(`ACP agent "${label}" refused the task${output ? `: ${output}` : '.'}`),
        }
        return
      }

      const assistantMsg = output
        ? ({ role: 'assistant', content: [{ type: 'text', text: output }] } satisfies LLMMessage)
        : undefined
      if (assistantMsg) options.onMessage?.(assistantMsg)

      // `max_tokens` / `max_turn_requests` mean the agent stopped before finishing;
      // reuse the "hit a limit, may be incomplete" signal so the task soft-fails.
      const budgetExceeded = stopReason === 'max_tokens' || stopReason === 'max_turn_requests'
      const result: RunResult = {
        messages: assistantMsg ? [assistantMsg] : [],
        output,
        toolCalls,
        tokenUsage: { input_tokens: usedTokens, output_tokens: 0 },
        turns: 1,
        ...(budgetExceeded ? { budgetExceeded: true } : {}),
      }
      yield { type: 'done', data: result }
    } catch (err) {
      yield { type: 'error', data: toError(err) }
    } finally {
      if (abort) abort.removeEventListener('abort', onAbort)
    }
  }

  /** Close the ACP connection and kill the subprocess. Safe to call more than once. */
  async dispose(): Promise<void> {
    try {
      this.session?.dispose()
    } catch {
      // best-effort
    }
    if (this.conn) {
      await this.conn.dispose()
    }
    this.session = null
    this.ctx = null
    this.conn = null
    this.starting = null
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async ensureSession(): Promise<{ session: ActiveSession; ctx: ClientContext }> {
    if (this.session && this.ctx) {
      return { session: this.session, ctx: this.ctx }
    }
    if (!this.starting) {
      this.starting = this.start()
    }
    await this.starting
    return { session: this.session!, ctx: this.ctx! }
  }

  private async start(): Promise<void> {
    const sdk = this.sdk ?? (this.sdk = await loadAcpSdk())
    const app = sdk
      .client({ name: this.options.agentName ?? 'open-multi-agent' })
      .onRequest('session/request_permission', ({ params }) => this.resolvePermission(params))

    const connector = this.options.connect ?? defaultSpawnConnector(this.options)
    this.conn = await connector(app, sdk)
    this.ctx = this.conn.connection.agent

    await this.ctx.request('initialize', {
      protocolVersion: sdk.PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    this.session = await this.ctx.buildSession(resolveCwd(this.options.cwd)).start()
  }

  private async resolvePermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const options = params.options
    const allow = pick(options, 'allow_always') ?? pick(options, 'allow_once')
    const reject = pick(options, 'reject_once') ?? pick(options, 'reject_always')
    const policy = this.options.permission ?? 'auto-approve'

    let approve: boolean
    if (policy === 'auto-approve') {
      approve = true
    } else if (policy === 'reject') {
      approve = false
    } else {
      const request: AcpPermissionRequest = {
        title: params.toolCall.title ?? '',
        kind: params.toolCall.kind ?? undefined,
        optionKinds: options.map((o) => o.kind),
      }
      approve = await policy(request)
    }

    if (approve && allow) {
      return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }
    if (!approve && reject) {
      return { outcome: { outcome: 'selected', optionId: reject.optionId } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

async function loadAcpSdk(): Promise<AcpSdkModule> {
  try {
    return await import('@agentclientprotocol/sdk')
  } catch (err) {
    throw new Error(
      `The 'acp' agent backend requires the optional peer dependency ` +
        `'@agentclientprotocol/sdk'. Install it with: npm install @agentclientprotocol/sdk\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Default connector: spawn the CLI and frame its stdio as newline-delimited JSON-RPC. */
function defaultSpawnConnector(
  options: AcpBackendOptions,
): (app: ClientApp, sdk: AcpSdkModule) => AcpConnection {
  return (app, sdk) => {
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: resolveCwd(options.cwd),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    if (!child.stdin || !child.stdout) {
      child.kill()
      throw new Error(`Failed to open stdio pipes for ACP agent command "${options.command}".`)
    }
    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    )
    const connection = app.connect(stream)
    // If the process can't start (e.g. command not found), close the connection
    // so pending requests reject instead of hanging.
    child.once('error', () => {
      try {
        connection.close()
      } catch {
        // best-effort
      }
    })
    return {
      connection,
      dispose: () => {
        try {
          connection.close()
        } catch {
          // best-effort
        }
        if (!child.killed) child.kill()
      },
    }
  }
}

function pick(options: readonly PermissionOption[], kind: string): PermissionOption | undefined {
  return options.find((o) => o.kind === kind)
}

/** Extract the text of the most recent user message (the new turn for the ACP session). */
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toolOutputText(rawOutput: unknown, content: unknown): string {
  if (typeof rawOutput === 'string') return rawOutput
  if (rawOutput != null) return safeStringify(rawOutput)
  if (Array.isArray(content) && content.length > 0) return safeStringify(content)
  return ''
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function resolveCwd(cwd?: string): string {
  return resolvePath(cwd ?? process.cwd())
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
