export const TEMPLATE_IDS = ['pr-review', 'security', 'demo'] as const
export const PROVIDER_IDS = ['cloud', 'ollama'] as const

export type TemplateId = (typeof TEMPLATE_IDS)[number]
export type ProviderId = (typeof PROVIDER_IDS)[number]

export interface CliOptions {
  readonly projectName?: string
  readonly templateId?: TemplateId
  readonly providerId?: ProviderId
  readonly help: boolean
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`)
  return value
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let projectName: string | undefined
  let templateId: TemplateId | undefined
  let providerId: ProviderId | undefined
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--template' || arg === '-t') {
      const value = readValue(argv, i, arg)
      if (!TEMPLATE_IDS.includes(value as TemplateId)) {
        throw new Error(`Unknown template "${value}". Use: ${TEMPLATE_IDS.join(', ')}.`)
      }
      templateId = value as TemplateId
      i += 1
      continue
    }
    if (arg === '--provider' || arg === '-p') {
      const value = readValue(argv, i, arg)
      if (!PROVIDER_IDS.includes(value as ProviderId)) {
        throw new Error(`Unknown provider "${value}". Use: ${PROVIDER_IDS.join(', ')}.`)
      }
      providerId = value as ProviderId
      i += 1
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option "${arg}". Run with --help for usage.`)
    if (projectName) throw new Error(`Unexpected second project name "${arg}".`)
    projectName = arg
  }

  return { projectName, templateId, providerId, help }
}
