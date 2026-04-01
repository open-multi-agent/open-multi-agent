/**
 * @fileoverview GitHub Copilot adapter implementing {@link LLMAdapter}.
 *
 * ## Authentication
 *
 * GitHub Copilot requires a GitHub OAuth token. Resolution order:
 *   1. `token` constructor argument
 *   2. `GITHUB_COPILOT_TOKEN` environment variable
 *   3. `GITHUB_TOKEN` environment variable
 *   4. `~/.config/github-copilot/hosts.json` (written by `:Copilot setup` / `gh auth login`)
 *
 * If no token is found, the constructor throws. Run the interactive Device
 * Authorization Flow with {@link CopilotAdapter.authenticate} — this mirrors
 * exactly what `:Copilot setup` does in copilot.vim: it prints a one-time
 * code, opens GitHub in the browser, polls for confirmation, then saves the
 * token to `~/.config/github-copilot/hosts.json`.
 *
 * ## Internal token exchange
 *
 * Each GitHub OAuth token is exchanged on-demand for a short-lived Copilot
 * API bearer token via `GET https://api.github.com/copilot_internal/v2/token`.
 * This token is cached in memory and auto-refreshed 60 seconds before it
 * expires, so callers never need to manage it.
 *
 * ## Wire format
 *
 * The Copilot Chat API (`https://api.githubcopilot.com/chat/completions`) is
 * OpenAI-compatible. Message conversion reuses the same rules as
 * {@link OpenAIAdapter}.
 *
 * @example
 * ```ts
 * // Authenticate once (writes to ~/.config/github-copilot/hosts.json)
 * await CopilotAdapter.authenticate()
 *
 * // Then use normally — token is read from hosts.json automatically
 * const adapter = new CopilotAdapter()
 * const response = await adapter.chat(messages, { model: 'gpt-4o' })
 * ```
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

import type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
} from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** OAuth App client ID used by the VS Code Copilot extension (public). */
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const COPILOT_CHAT_URL = 'https://api.githubcopilot.com/chat/completions'

/** Editor headers expected by the Copilot API. */
const EDITOR_HEADERS = {
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot/1.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': 'open-multi-agent',
}

// ---------------------------------------------------------------------------
// Token file helpers (mirrors copilot.vim's hosts.json location)
// ---------------------------------------------------------------------------

interface HostsJson {
  [host: string]: {
    oauth_token?: string
    user?: string
  }
}

/** Return the path to the GitHub Copilot hosts file. */
function hostsFilePath(): string {
  const xdgConfig = process.env['XDG_CONFIG_HOME']
  const base = xdgConfig ?? join(homedir(), '.config')
  return join(base, 'github-copilot', 'hosts.json')
}

/** Read the stored GitHub OAuth token from the copilot.vim hosts file. */
function readStoredToken(): string | undefined {
  try {
    const raw = readFileSync(hostsFilePath(), 'utf8')
    const data: unknown = JSON.parse(raw)
    if (data !== null && typeof data === 'object') {
      const hosts = data as HostsJson
      const entry = hosts['github.com']
      if (entry?.oauth_token) return entry.oauth_token
    }
  } catch {
    // File not found or malformed — not an error.
  }
  return undefined
}

/** Persist an OAuth token to the copilot.vim hosts file. */
function writeStoredToken(token: string, user: string): void {
  const filePath = hostsFilePath()
  mkdirSync(dirname(filePath), { recursive: true })

  let existing: HostsJson = {}
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      existing = parsed as HostsJson
    }
  } catch {
    // File does not exist yet — start fresh.
  }

  existing['github.com'] = { oauth_token: token, user }
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Copilot token exchange
// ---------------------------------------------------------------------------

interface CopilotTokenResponse {
  token: string
  expires_at: number
}

async function fetchCopilotToken(githubToken: string): Promise<CopilotTokenResponse> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${githubToken}`,
      ...EDITOR_HEADERS,
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`Copilot token exchange failed (${res.status}): ${body}`)
  }

  return (await res.json()) as CopilotTokenResponse
}

// ---------------------------------------------------------------------------
// Device Authorization Flow (mirrors :Copilot setup in copilot.vim)
// ---------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface AccessTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface GitHubUser {
  login: string
}

/**
 * Run the GitHub Device Authorization Flow and return the OAuth access token.
 *
 * This is the same flow that `:Copilot setup` in copilot.vim performs:
 * 1. Request a device code
 * 2. Display the user code and open (or print) the verification URL
 * 3. Poll until the user authorises the app
 * 4. Return the OAuth token
 */
async function runDeviceFlow(
  onPrompt: (userCode: string, verificationUri: string) => void,
): Promise<string> {
  // Step 1 — request device + user code
  const dcRes = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `client_id=${GITHUB_CLIENT_ID}&scope=read:user`,
  })

  if (!dcRes.ok) {
    throw new Error(`Device code request failed: ${dcRes.statusText}`)
  }

  const dc: DeviceCodeResponse = (await dcRes.json()) as DeviceCodeResponse

  // Step 2 — prompt the user
  onPrompt(dc.user_code, dc.verification_uri)

  // Step 3 — poll for the access token
  const intervalMs = (dc.interval ?? 5) * 1000
  const deadline = Date.now() + dc.expires_in * 1000

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs))

    const tokenRes = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body:
        `client_id=${GITHUB_CLIENT_ID}` +
        `&device_code=${dc.device_code}` +
        `&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
    })

    const body: AccessTokenResponse = (await tokenRes.json()) as AccessTokenResponse

    if (body.access_token) return body.access_token

    // Keep polling on authorization_pending / slow_down; throw on all other errors.
    if (body.error && body.error !== 'authorization_pending' && body.error !== 'slow_down') {
      throw new Error(`GitHub OAuth error: ${body.error_description ?? body.error}`)
    }
  }

  throw new Error('Device authorization flow timed out')
}

// ---------------------------------------------------------------------------
// OpenAI-compatible message conversion (Copilot uses the same wire format)
// ---------------------------------------------------------------------------

function toOpenAITool(tool: LLMToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }
}

function buildOpenAIMessages(
  messages: LLMMessage[],
  systemPrompt: string | undefined,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []

  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(assistantToOpenAI(msg))
    } else {
      const toolResults = msg.content.filter((b) => b.type === 'tool_result')
      const others = msg.content.filter((b) => b.type !== 'tool_result')

      if (others.length > 0) {
        if (others.length === 1 && others[0]?.type === 'text') {
          result.push({ role: 'user', content: (others[0] as TextBlock).text })
        } else {
          const parts = others
            .filter((b): b is TextBlock => b.type === 'text')
            .map((b) => ({ type: 'text', text: b.text }))
          result.push({ role: 'user', content: parts })
        }
      }

      for (const block of toolResults) {
        if (block.type === 'tool_result') {
          result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
        }
      }
    }
  }

  return result
}

function assistantToOpenAI(msg: LLMMessage): Record<string, unknown> {
  const toolCalls: Record<string, unknown>[] = []
  const texts: string[] = []

  for (const b of msg.content) {
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      })
    } else if (b.type === 'text') {
      texts.push(b.text)
    }
  }

  const out: Record<string, unknown> = {
    role: 'assistant',
    content: texts.join('') || null,
  }
  if (toolCalls.length > 0) out['tool_calls'] = toolCalls
  return out
}

function normalizeFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'stop':        return 'end_turn'
    case 'tool_calls':  return 'tool_use'
    case 'length':      return 'max_tokens'
    default:            return reason ?? 'end_turn'
  }
}

// ---------------------------------------------------------------------------
// Response conversion (OpenAI → framework)
// ---------------------------------------------------------------------------

interface OpenAIChoice {
  message?: {
    content?: string | null
    tool_calls?: Array<{
      id: string
      function: { name: string; arguments: string }
    }>
  }
  delta?: {
    content?: string | null
    tool_calls?: Array<{
      index: number
      id?: string
      function?: { name?: string; arguments?: string }
    }>
  }
  finish_reason?: string | null
}

interface OpenAICompletion {
  id: string
  model: string
  choices: OpenAIChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function fromOpenAICompletion(completion: OpenAICompletion): LLMResponse {
  const choice = completion.choices[0]
  if (choice === undefined) throw new Error('Copilot returned a completion with no choices')

  const content: ContentBlock[] = []
  const message = choice.message ?? {}

  if (message.content) {
    content.push({ type: 'text', text: message.content } satisfies TextBlock)
  }

  for (const tc of message.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(tc.function.arguments)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>
      }
    } catch { /* malformed — surface as empty object */ }

    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input,
    } satisfies ToolUseBlock)
  }

  return {
    id: completion.id,
    content,
    model: completion.model,
    stop_reason: normalizeFinishReason(choice.finish_reason),
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * LLM adapter backed by the GitHub Copilot Chat API.
 *
 * The Copilot Chat API is OpenAI-compatible, supporting the same models
 * available in GitHub Copilot (e.g. `gpt-4o`, `claude-3.5-sonnet`, `o3-mini`).
 *
 * Call the static {@link CopilotAdapter.authenticate} method once to run the
 * GitHub Device Authorization Flow and persist the token — identical to
 * `:Copilot setup` in copilot.vim.
 *
 * Thread-safe — a single instance may be shared across concurrent agent runs.
 */
export class CopilotAdapter implements LLMAdapter {
  readonly name = 'copilot'

  readonly #githubToken: string

  /** Short-lived Copilot API bearer token (auto-refreshed). */
  #copilotToken: string | null = null
  /** Unix timestamp (seconds) at which the cached token expires. */
  #copilotTokenExpiry = 0

  /**
   * @param token - GitHub OAuth token. Falls back to `GITHUB_COPILOT_TOKEN`,
   *   `GITHUB_TOKEN`, then `~/.config/github-copilot/hosts.json`.
   * @throws {Error} When no token can be resolved. Run
   *   {@link CopilotAdapter.authenticate} first.
   */
  constructor(token?: string) {
    const resolved =
      token ??
      process.env['GITHUB_COPILOT_TOKEN'] ??
      process.env['GITHUB_TOKEN'] ??
      readStoredToken()

    if (!resolved) {
      throw new Error(
        'CopilotAdapter: No GitHub token found. ' +
          'Run CopilotAdapter.authenticate() or set GITHUB_COPILOT_TOKEN.',
      )
    }

    this.#githubToken = resolved
  }

  // -------------------------------------------------------------------------
  // Static: Device Authorization Flow (mirrors :Copilot setup)
  // -------------------------------------------------------------------------

  /**
   * Authenticate with GitHub using the Device Authorization Flow — the same
   * flow that `:Copilot setup` in copilot.vim runs.
   *
   * Prints a one-time code and a URL. After the user authorises the app the
   * OAuth token is saved to `~/.config/github-copilot/hosts.json` so that
   * future `new CopilotAdapter()` calls find it automatically.
   *
   * @param onPrompt - Called with the user code and verification URL so the
   *   caller can display / open them. Defaults to printing to stdout.
   * @returns The GitHub OAuth token.
   */
  static async authenticate(
    onPrompt?: (userCode: string, verificationUri: string) => void,
  ): Promise<string> {
    const prompt =
      onPrompt ??
      ((userCode, uri) => {
        process.stdout.write(
          `\nFirst copy your one-time code: ${userCode}\n` +
            `Then visit: ${uri}\n` +
            `Waiting for authorisation…\n`,
        )
      })

    const oauthToken = await runDeviceFlow(prompt)

    // Resolve the authenticated username and persist the token.
    let user = 'unknown'
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `token ${oauthToken}`, ...EDITOR_HEADERS },
      })
      if (res.ok) {
        const data: unknown = await res.json()
        if (data !== null && typeof data === 'object') {
          user = (data as GitHubUser).login ?? user
        }
      }
    } catch { /* best-effort */ }

    writeStoredToken(oauthToken, user)
    process.stdout.write(`\nCopilot: Authenticated as GitHub user ${user}\n`)

    return oauthToken
  }

  // -------------------------------------------------------------------------
  // Internal: Copilot API token (short-lived bearer)
  // -------------------------------------------------------------------------

  /**
   * Return a valid Copilot API bearer token, refreshing if needed.
   *
   * The token is cached in memory for its lifetime (typically 30 min) and
   * refreshed 60 seconds before expiry.
   */
  async #getCopilotToken(): Promise<string> {
    const nowSeconds = Date.now() / 1000
    if (this.#copilotToken !== null && this.#copilotTokenExpiry > nowSeconds + 60) {
      return this.#copilotToken
    }

    const data = await fetchCopilotToken(this.#githubToken)
    this.#copilotToken = data.token
    this.#copilotTokenExpiry = data.expires_at
    return this.#copilotToken
  }

  // -------------------------------------------------------------------------
  // chat()
  // -------------------------------------------------------------------------

  /**
   * Send a synchronous (non-streaming) chat request and return the complete
   * {@link LLMResponse}.
   *
   * Throws on non-2xx responses. Callers should handle rate-limit errors
   * (HTTP 429) and quota errors (HTTP 403).
   */
  async chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMResponse> {
    const copilotToken = await this.#getCopilotToken()
    const openAIMessages = buildOpenAIMessages(messages, options.systemPrompt)

    const body: Record<string, unknown> = {
      model: options.model,
      messages: openAIMessages,
      stream: false,
    }
    if (options.tools) body['tools'] = options.tools.map(toOpenAITool)
    if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens
    if (options.temperature !== undefined) body['temperature'] = options.temperature

    const res = await fetch(COPILOT_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        'Content-Type': 'application/json',
        ...EDITOR_HEADERS,
      },
      body: JSON.stringify(body),
      signal: options.abortSignal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Copilot API error ${res.status}: ${text}`)
    }

    const completion: OpenAICompletion = (await res.json()) as OpenAICompletion
    return fromOpenAICompletion(completion)
  }

  // -------------------------------------------------------------------------
  // stream()
  // -------------------------------------------------------------------------

  /**
   * Send a streaming chat request and yield {@link StreamEvent}s incrementally.
   *
   * Sequence guarantees (matching other adapters):
   * - Zero or more `text` events (incremental deltas)
   * - Zero or more `tool_use` events (emitted once per tool call, after stream ends)
   * - Exactly one terminal event: `done` or `error`
   */
  async *stream(
    messages: LLMMessage[],
    options: LLMStreamOptions,
  ): AsyncIterable<StreamEvent> {
    try {
      const copilotToken = await this.#getCopilotToken()
      const openAIMessages = buildOpenAIMessages(messages, options.systemPrompt)

      const body: Record<string, unknown> = {
        model: options.model,
        messages: openAIMessages,
        stream: true,
        stream_options: { include_usage: true },
      }
      if (options.tools) body['tools'] = options.tools.map(toOpenAITool)
      if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens
      if (options.temperature !== undefined) body['temperature'] = options.temperature

      const res = await fetch(COPILOT_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${copilotToken}`,
          'Content-Type': 'application/json',
          ...EDITOR_HEADERS,
        },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`Copilot API error ${res.status}: ${text}`)
      }

      if (res.body === null) throw new Error('Copilot streaming response has no body')

      // Accumulate state across SSE chunks.
      let completionId = ''
      let completionModel = options.model
      let finalFinishReason: string | null = 'stop'
      let inputTokens = 0
      let outputTokens = 0
      let fullText = ''

      const toolCallBuffers = new Map<
        number,
        { id: string; name: string; argsJson: string }
      >()

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let lineBuffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          lineBuffer += decoder.decode(value, { stream: true })
          const lines = lineBuffer.split('\n')
          lineBuffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') continue

            let chunk: OpenAICompletion
            try {
              chunk = JSON.parse(data) as OpenAICompletion
            } catch {
              continue
            }

            completionId = chunk.id || completionId
            completionModel = chunk.model || completionModel

            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? inputTokens
              outputTokens = chunk.usage.completion_tokens ?? outputTokens
            }

            const choice: OpenAIChoice | undefined = chunk.choices[0]
            if (choice === undefined) continue

            const delta = choice.delta ?? {}

            if (delta.content) {
              fullText += delta.content
              yield { type: 'text', data: delta.content } satisfies StreamEvent
            }

            for (const tc of delta.tool_calls ?? []) {
              const idx = tc.index
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', argsJson: '' })
              }
              const buf = toolCallBuffers.get(idx)
              if (buf !== undefined) {
                if (tc.id) buf.id = tc.id
                if (tc.function?.name) buf.name = tc.function.name
                if (tc.function?.arguments) buf.argsJson += tc.function.arguments
              }
            }

            if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
              finalFinishReason = choice.finish_reason
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      // Emit accumulated tool_use events.
      const finalToolUseBlocks: ToolUseBlock[] = []
      for (const buf of toolCallBuffers.values()) {
        let input: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(buf.argsJson)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>
          }
        } catch { /* malformed — empty object */ }

        const block: ToolUseBlock = { type: 'tool_use', id: buf.id, name: buf.name, input }
        finalToolUseBlocks.push(block)
        yield { type: 'tool_use', data: block } satisfies StreamEvent
      }

      const doneContent: ContentBlock[] = []
      if (fullText.length > 0) doneContent.push({ type: 'text', text: fullText })
      doneContent.push(...finalToolUseBlocks)

      const finalResponse: LLMResponse = {
        id: completionId,
        content: doneContent,
        model: completionModel,
        stop_reason: normalizeFinishReason(finalFinishReason),
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }

      yield { type: 'done', data: finalResponse } satisfies StreamEvent
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      yield { type: 'error', data: error } satisfies StreamEvent
    }
  }
}

// Re-export types that consumers of this module commonly need.
export type {
  ContentBlock,
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDef,
  StreamEvent,
}
