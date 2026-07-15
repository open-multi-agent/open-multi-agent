import { existsSync, readFileSync } from 'node:fs'

export interface RuntimeConfig {
  readonly runtime: 'cloud' | 'ollama'
  readonly model: string
  readonly baseURL?: string
  readonly apiKey: string
}

export function loadEnv(path = '.env'): void {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !(key in process.env)) process.env[key] = value
  }
}

interface OllamaTagsResponse {
  readonly models?: ReadonlyArray<{ readonly name?: string; readonly model?: string }>
}

export async function resolveRuntime(): Promise<RuntimeConfig> {
  loadEnv()
  if (process.env.OMA_RUNTIME === 'ollama') {
    const host = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '')
    let payload: OllamaTagsResponse
    try {
      const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      payload = (await response.json()) as OllamaTagsResponse
    } catch (error) {
      throw new Error(`Ollama is unavailable at ${host}. Start Ollama and try again. (${String(error)})`)
    }
    const model = process.env.OMA_MODEL ?? payload.models?.[0]?.name ?? payload.models?.[0]?.model
    if (!model) throw new Error('Ollama has no installed models. Run `ollama pull llama3.1` and try again.')
    return { runtime: 'ollama', model, baseURL: `${host}/v1`, apiKey: 'ollama' }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'Missing OPENAI_API_KEY. Copy .env.example to .env and add a cloud or OpenAI-compatible provider key.',
    )
  }
  return {
    runtime: 'cloud',
    model: process.env.OMA_MODEL ?? 'gpt-5.4',
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey,
  }
}
