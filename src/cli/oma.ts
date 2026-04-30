#!/usr/bin/env node
/**
 * Thin shell/CI wrapper over OpenMultiAgent — no interactive session, cwd binding,
 * approvals, or persistence.
 *
 * Exit codes:
 *   0 — finished; team run succeeded
 *   1 — finished; team run reported failure (agents/tasks)
 *   2 — invalid usage, I/O, or JSON validation
 *   3 — unexpected runtime error (including LLM errors)
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OpenMultiAgent } from '../orchestrator/orchestrator.js'
import { renderTeamRunDashboard } from '../dashboard/render-team-run-dashboard.js'
import type { SupportedProvider } from '../llm/adapter.js'
import type { AgentRunResult, CoordinatorConfig, OrchestratorConfig, TeamConfig, TeamRunResult } from '../types.js'

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const EXIT = {
  SUCCESS: 0,
  RUN_FAILED: 1,
  USAGE: 2,
  INTERNAL: 3,
} as const

class OmaValidationError extends Error {
  override readonly name = 'OmaValidationError'
  constructor(message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Provider helper (static reference data)
// ---------------------------------------------------------------------------

const PROVIDER_REFERENCE: ReadonlyArray<{
  id: SupportedProvider
  apiKeyEnv: readonly string[]
  baseUrlSupported: boolean
  notes?: string
}> = [
  { id: 'anthropic', apiKeyEnv: ['ANTHROPIC_API_KEY'], baseUrlSupported: true },
  { id: 'azure-openai', apiKeyEnv: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT'], baseUrlSupported: true, notes: 'Azure OpenAI requires endpoint URL (e.g., https://my-resource.openai.azure.com) and API key. Optional: AZURE_OPENAI_API_VERSION (defaults to 2024-10-21). Prefer setting deployment on agent.model; AZURE_OPENAI_DEPLOYMENT is a fallback when model is blank.' },
  { id: 'openai', apiKeyEnv: ['OPENAI_API_KEY'], baseUrlSupported: true, notes: 'Set baseURL for Ollama / vLLM / LM Studio; apiKey may be a placeholder.' },
  { id: 'gemini', apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], baseUrlSupported: false },
  { id: 'grok', apiKeyEnv: ['XAI_API_KEY'], baseUrlSupported: true },
  { id: 'minimax', apiKeyEnv: ['MINIMAX_API_KEY'], baseUrlSupported: true, notes: 'Global endpoint: https://api.minimax.io/v1 (default). China endpoint: https://api.minimaxi.com/v1. Set MINIMAX_BASE_URL to choose, or pass baseURL in agent config.' },
  { id: 'deepseek', apiKeyEnv: ['DEEPSEEK_API_KEY'], baseUrlSupported: true, notes: 'OpenAI-compatible endpoint at https://api.deepseek.com/v1. Models: deepseek-chat (V3), deepseek-reasoner (thinking).' },
  { id: 'qiniu', apiKeyEnv: ['QINIU_API_KEY'], baseUrlSupported: true, notes: 'OpenAI-compatible endpoint at https://api.qnaigc.com/v1. Set provider to qiniu and choose a model available to your key.' },
  {
    id: 'copilot',
    apiKeyEnv: ['GITHUB_COPILOT_TOKEN', 'GITHUB_TOKEN'],
    baseUrlSupported: false,
    notes: 'If no token env is set, Copilot adapter may start an interactive OAuth device flow (avoid in CI).',
  },
  {
    id: 'bedrock',
    apiKeyEnv: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    baseUrlSupported: false,
    notes: 'No API key. Credentials via AWS SDK default provider chain (env vars, shared config, IAM role). Set AWS_REGION or pass region as the fourth arg to createAdapter; defaults to us-east-1. Requires npm install @aws-sdk/client-bedrock-runtime.',
  },
]

// ---------------------------------------------------------------------------
// argv / JSON helpers
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): {
  _: string[]
  flags: Set<string>
  kv: Map<string, string>
} {
  const _ = argv.slice(2)
  const flags = new Set<string>()
  const kv = new Map<string, string>()
  let i = 0
  while (i < _.length) {
    const a = _[i]!
    if (a === '--') {
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        kv.set(a.slice(2, eq), a.slice(eq + 1))
        i++
        continue
      }
      const key = a.slice(2)
      const next = _[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        kv.set(key, next)
        i += 2
      } else {
        flags.add(key)
        i++
      }
      continue
    }
    i++
  }
  return { _, flags, kv }
}

function getOpt(kv: Map<string, string>, flags: Set<string>, key: string): string | undefined {
  if (flags.has(key)) return ''
  return kv.get(key)
}

function readJson(path: string): unknown {
  const abs = resolve(path)
  const raw = readFileSync(abs, 'utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${abs}: ${e.message}`)
    }
    throw e
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asTeamConfig(v: unknown, label: string): TeamConfig {
  if (!isObject(v)) throw new OmaValidationError(`${label}: expected a JSON object`)
  const name = v['name']
  const agents = v['agents']
  if (typeof name !== 'string' || !name) throw new OmaValidationError(`${label}.name: non-empty string required`)
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new OmaValidationError(`${label}.agents: non-empty array required`)
  }
  for (const a of agents) {
    if (!isObject(a)) throw new OmaValidationError(`${label}.agents[]: each agent must be an object`)
    if (typeof a['name'] !== 'string' || !a['name']) throw new OmaValidationError(`agent.name required`)
    if (typeof a['model'] !== 'string' || !a['model']) {
      throw new OmaValidationError(`agent.model required for "${String(a['name'])}"`)
    }
  }
  // `sharedMemoryStore` is a runtime MemoryStore instance and cannot survive
  // JSON round-tripping. Reject it here with a clear pointer to the SDK path,
  // otherwise the plain object would reach `new SharedMemory(...)` and crash on
  // the first read/write.
  if ('sharedMemoryStore' in v) {
    throw new OmaValidationError(
      `${label}.sharedMemoryStore: SDK-only; cannot be set from JSON config. ` +
        'Use `sharedMemory: true` for the default in-memory store, or wire a ' +
        'custom MemoryStore in TypeScript via `orchestrator.createTeam()`.',
    )
  }
  return v as unknown as TeamConfig
}

function asOrchestratorPartial(v: unknown, label: string): OrchestratorConfig {
  if (!isObject(v)) throw new OmaValidationError(`${label}: expected a JSON object`)
  return v as OrchestratorConfig
}

function asCoordinatorPartial(v: unknown, label: string): CoordinatorConfig {
  if (!isObject(v)) throw new OmaValidationError(`${label}: expected a JSON object`)
  return v as CoordinatorConfig
}

function asTaskSpecs(v: unknown, label: string): ReadonlyArray<{
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
}> {
  if (!Array.isArray(v)) throw new OmaValidationError(`${label}: expected a JSON array`)
  const out: Array<{
    title: string
    description: string
    assignee?: string
    dependsOn?: string[]
    memoryScope?: 'dependencies' | 'all'
    maxRetries?: number
    retryDelayMs?: number
    retryBackoff?: number
  }> = []
  let i = 0
  for (const item of v) {
    if (!isObject(item)) throw new OmaValidationError(`${label}[${i}]: object expected`)
    if (typeof item['title'] !== 'string' || typeof item['description'] !== 'string') {
      throw new OmaValidationError(`${label}[${i}]: title and description strings required`)
    }
    const row: (typeof out)[0] = {
      title: item['title'],
      description: item['description'],
    }
    if (typeof item['assignee'] === 'string') row.assignee = item['assignee']
    if (Array.isArray(item['dependsOn'])) {
      row.dependsOn = item['dependsOn'].filter((x): x is string => typeof x === 'string')
    }
    if (item['memoryScope'] === 'all' || item['memoryScope'] === 'dependencies') {
      row.memoryScope = item['memoryScope']
    }
    if (typeof item['maxRetries'] === 'number') row.maxRetries = item['maxRetries']
    if (typeof item['retryDelayMs'] === 'number') row.retryDelayMs = item['retryDelayMs']
    if (typeof item['retryBackoff'] === 'number') row.retryBackoff = item['retryBackoff']
    out.push(row)
    i++
  }
  return out
}

export interface CliJsonOptions {
  readonly pretty: boolean
  readonly includeMessages: boolean
}

export function serializeAgentResult(r: AgentRunResult, includeMessages: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    success: r.success,
    output: r.output,
    tokenUsage: r.tokenUsage,
    toolCalls: r.toolCalls,
    structured: r.structured,
    loopDetected: r.loopDetected,
    budgetExceeded: r.budgetExceeded,
  }
  if (includeMessages) base['messages'] = r.messages
  return base
}

export function serializeTeamRunResult(result: TeamRunResult, opts: CliJsonOptions): Record<string, unknown> {
  const agentResults: Record<string, unknown> = {}
  for (const [k, v] of result.agentResults) {
    agentResults[k] = serializeAgentResult(v, opts.includeMessages)
  }
  return {
    success: result.success,
    goal: result.goal,
    tasks: result.tasks,
    totalTokenUsage: result.totalTokenUsage,
    agentResults,
  }
}

function printJson(data: unknown, pretty: boolean): void {
  const s = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  process.stdout.write(`${s}\n`)
}

function help(): string {
  return [
    'open-multi-agent CLI (oma)',
    '',
    'Usage:',
    '  oma run --goal <text> --team <team.json> [--orchestrator <orch.json>] [--coordinator <coord.json>]',
    '  oma task --file <tasks.json> [--team <team.json>]',
    '  oma provider [list | template <provider>]',
    '',
    'Flags:',
    '  --pretty              Pretty-print JSON to stdout',
    '  --include-messages    Include full LLM message arrays in run output (large)',
    '  --dashboard           Write team-run DAG HTML dashboard to oma-dashboards/',
    '',
    'team.json may be a TeamConfig object, or { "team": TeamConfig, "orchestrator": { ... } }.',
    'tasks.json: { "team": TeamConfig, "tasks": [ ... ], "orchestrator"?: { ... } }.',
    '  Optional --team overrides the embedded team object.',
    '',
    'Exit codes: 0 success, 1 run failed, 2 usage/validation, 3 internal',
  ].join('\n')
}

const DEFAULT_MODEL_HINT: Record<SupportedProvider, string> = {
  anthropic: 'claude-opus-4-6',
  'azure-openai': 'gpt-4',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  grok: 'grok-2-latest',
  copilot: 'gpt-4o',
  minimax: 'MiniMax-M2.7',
  deepseek: 'deepseek-chat',
  qiniu: 'deepseek-v3',
  bedrock: 'anthropic.claude-3-5-haiku-20241022-v1:0',
}

async function cmdProvider(sub: string | undefined, arg: string | undefined, pretty: boolean): Promise<number> {
  if (sub === undefined || sub === 'list') {
    printJson({ providers: PROVIDER_REFERENCE }, pretty)
    return EXIT.SUCCESS
  }
  if (sub === 'template') {
    const id = arg as SupportedProvider | undefined
    const row = PROVIDER_REFERENCE.find((p) => p.id === id)
    if (!id || !row) {
      printJson(
        {
          error: {
            kind: 'usage',
            message: `usage: oma provider template <${PROVIDER_REFERENCE.map((p) => p.id).join('|')}>`,
          },
        },
        pretty,
      )
      return EXIT.USAGE
    }
    printJson(
      {
        orchestrator: {
          defaultProvider: id,
          defaultModel: DEFAULT_MODEL_HINT[id],
        },
        agent: {
          name: 'worker',
          model: DEFAULT_MODEL_HINT[id],
          provider: id,
          systemPrompt: 'You are a helpful assistant.',
        },
        env: Object.fromEntries(row.apiKeyEnv.map((k) => [k, `<set ${k} in environment>`])),
        notes: row.notes,
      },
      pretty,
    )
    return EXIT.SUCCESS
  }
  printJson({ error: { kind: 'usage', message: `unknown provider subcommand: ${sub}` } }, pretty)
  return EXIT.USAGE
}

function mergeOrchestrator(base: OrchestratorConfig, ...partials: OrchestratorConfig[]): OrchestratorConfig {
  let o: OrchestratorConfig = { ...base }
  for (const p of partials) {
    o = { ...o, ...p }
  }
  return o
}

async function writeRunTeamDashboardFile(html: string): Promise<string> {
  const directory = join(process.cwd(), 'oma-dashboards')
  await mkdir(directory, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-')
  const filePath = join(directory, `runTeam-${stamp}.html`)
  await writeFile(filePath, html, 'utf8')
  return filePath
}

async function main(): Promise<number> {
  const argv = parseArgs(process.argv)
  const cmd = argv._[0]
  const pretty = argv.flags.has('pretty')
  const includeMessages = argv.flags.has('include-messages')
  const dashboard = argv.flags.has('dashboard')

  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`${help()}\n`)
    return EXIT.SUCCESS
  }

  if (cmd === 'provider') {
    return cmdProvider(argv._[1], argv._[2], pretty)
  }

  const jsonOpts: CliJsonOptions = { pretty, includeMessages }

  try {
    if (cmd === 'run') {
      const goal = getOpt(argv.kv, argv.flags, 'goal')
      const teamPath = getOpt(argv.kv, argv.flags, 'team')
      const orchPath = getOpt(argv.kv, argv.flags, 'orchestrator')
      const coordPath = getOpt(argv.kv, argv.flags, 'coordinator')
      if (!goal || !teamPath) {
        printJson({ error: { kind: 'usage', message: '--goal and --team are required' } }, pretty)
        return EXIT.USAGE
      }

      const teamRaw = readJson(teamPath)
      let teamCfg: TeamConfig
      let orchParts: OrchestratorConfig[] = []
      if (isObject(teamRaw) && teamRaw['team'] !== undefined) {
        teamCfg = asTeamConfig(teamRaw['team'], 'team')
        if (teamRaw['orchestrator'] !== undefined) {
          orchParts.push(asOrchestratorPartial(teamRaw['orchestrator'], 'orchestrator'))
        }
      } else {
        teamCfg = asTeamConfig(teamRaw, 'team')
      }
      if (orchPath) {
        orchParts.push(asOrchestratorPartial(readJson(orchPath), 'orchestrator file'))
      }

      const orchestrator = new OpenMultiAgent(mergeOrchestrator({}, ...orchParts))
      const team = orchestrator.createTeam(teamCfg.name, teamCfg)
      let coordinator: CoordinatorConfig | undefined
      if (coordPath) {
        coordinator = asCoordinatorPartial(readJson(coordPath), 'coordinator file')
      }
      const result = await orchestrator.runTeam(team, goal, coordinator ? { coordinator } : undefined)
      if (dashboard) {
        const html = renderTeamRunDashboard(result)
        try {
          await writeRunTeamDashboardFile(html)
        } catch (err) {
          process.stderr.write(
            `oma: failed to write runTeam dashboard: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
      await orchestrator.shutdown()
      const payload = { command: 'run' as const, ...serializeTeamRunResult(result, jsonOpts) }
      printJson(payload, pretty)
      return result.success ? EXIT.SUCCESS : EXIT.RUN_FAILED
    }

    if (cmd === 'task') {
      const file = getOpt(argv.kv, argv.flags, 'file')
      const teamOverride = getOpt(argv.kv, argv.flags, 'team')
      if (!file) {
        printJson({ error: { kind: 'usage', message: '--file is required' } }, pretty)
        return EXIT.USAGE
      }
      const doc = readJson(file)
      if (!isObject(doc)) {
        throw new OmaValidationError('tasks file root must be an object')
      }
      const orchParts: OrchestratorConfig[] = []
      if (doc['orchestrator'] !== undefined) {
        orchParts.push(asOrchestratorPartial(doc['orchestrator'], 'orchestrator'))
      }
      const teamCfg = teamOverride
        ? asTeamConfig(readJson(teamOverride), 'team (--team)')
        : asTeamConfig(doc['team'], 'team')

      const tasks = asTaskSpecs(doc['tasks'], 'tasks')
      if (tasks.length === 0) {
        throw new OmaValidationError('tasks array must not be empty')
      }

      const orchestrator = new OpenMultiAgent(mergeOrchestrator({}, ...orchParts))
      const team = orchestrator.createTeam(teamCfg.name, teamCfg)
      const result = await orchestrator.runTasks(team, tasks)
      await orchestrator.shutdown()
      const payload = { command: 'task' as const, ...serializeTeamRunResult(result, jsonOpts) }
      printJson(payload, pretty)
      return result.success ? EXIT.SUCCESS : EXIT.RUN_FAILED
    }

    printJson({ error: { kind: 'usage', message: `unknown command: ${cmd}` } }, pretty)
    return EXIT.USAGE
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const { kind, exit } = classifyCliError(e, message)
    printJson({ error: { kind, message } }, pretty)
    return exit
  }
}

function classifyCliError(e: unknown, message: string): { kind: string; exit: number } {
  if (e instanceof OmaValidationError) return { kind: 'validation', exit: EXIT.USAGE }
  if (message.includes('Invalid JSON')) return { kind: 'validation', exit: EXIT.USAGE }
  if (message.includes('ENOENT') || message.includes('EACCES')) return { kind: 'io', exit: EXIT.USAGE }
  return { kind: 'runtime', exit: EXIT.INTERNAL }
}

const isMain = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return fileURLToPath(import.meta.url) === resolve(argv1)
  } catch {
    return false
  }
})()

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e)
      process.stdout.write(`${JSON.stringify({ error: { kind: 'internal', message } })}\n`)
      process.exit(EXIT.INTERNAL)
    })
}
