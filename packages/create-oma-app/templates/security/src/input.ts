import { execFile } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'

const MAX_FILE_BYTES = 1_000_000
const MAX_SCAN_BYTES = 20_000_000
const MAX_EVIDENCE_CHARS = 60_000
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '.cache'])
const TEXT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml', '.env', '.md', '.py', '.go', '.rs', '.java', '.rb', '.php', '.sh'])

const SECRET_PATTERNS = [
  { type: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { type: 'github-token', regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { type: 'generic-secret', regex: /\b(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{8,}/gi },
] as const

export interface SecretSignal {
  readonly path: string
  readonly line: number
  readonly type: string
}

export interface SecurityInput {
  readonly label: string
  readonly evidence: string
  readonly incomplete: boolean
  readonly metadata: Record<string, unknown>
}

interface SecurityArgs {
  readonly demo: boolean
  readonly repo?: string
  readonly onlineAudit: boolean
}

export function parseSecurityArgs(argv: readonly string[]): SecurityArgs {
  let demo = false
  let repo: string | undefined
  let onlineAudit = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--demo') demo = true
    else if (arg === '--online-audit') onlineAudit = true
    else if (arg === '--repo') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--repo requires a value.')
      repo = value
      i += 1
    } else throw new Error(`Unknown option "${arg}".`)
  }
  if (demo && repo) throw new Error('Use --demo or --repo, not both.')
  if (demo && onlineAudit) throw new Error('--online-audit cannot be used with --demo.')
  return { demo, repo, onlineAudit }
}

export function redactSecrets(text: string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0
    redacted = redacted.replace(pattern.regex, `[REDACTED ${pattern.type}]`)
  }
  return redacted
}

function listFiles(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue
      const path = resolve(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  visit(root)
  return files.sort()
}

function isTextCandidate(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || /^(Dockerfile|Makefile|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(name)
}

function collectSecretSignals(path: string, text: string): SecretSignal[] {
  const signals: SecretSignal[] = []
  for (const [index, line] of text.split('\n').entries()) {
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0
      if (pattern.regex.test(line)) signals.push({ path, line: index + 1, type: pattern.type })
    }
  }
  return signals
}

function runNpmAudit(cwd: string): Promise<string> {
  return new Promise((resolveAudit, reject) => {
    execFile(
      'npm', ['audit', '--json', '--ignore-scripts'],
      { cwd, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stdout.trim()) {
          resolveAudit(stdout.slice(0, 30_000))
          return
        }
        if (error) reject(new Error(`npm audit failed without JSON output: ${stderr || error.message}`))
        else resolveAudit('{}')
      },
    )
  })
}

const DEMO_EVIDENCE = `FILE: src/server.ts
app.get('/admin/users', async (req, res) => {
  const query = \`SELECT * FROM users WHERE name = '\${req.query.name}'\`
  res.json(await db.query(query))
})

FILE: .env.example
ADMIN_API_KEY=[REDACTED generic-secret]

SECRET SIGNALS:
- .env.example:1 generic-secret

DEPENDENCY MANIFEST:
{"scripts":{"start":"node src/server.js"},"dependencies":{"express":"^4.17.0"}}`

export async function collectSecurityInput(argv: readonly string[]): Promise<SecurityInput> {
  const args = parseSecurityArgs(argv)
  if (args.demo) return { label: 'Bundled vulnerable service fixture', evidence: DEMO_EVIDENCE, incomplete: false, metadata: { source: 'demo', onlineAudit: false } }

  const root = resolve(args.repo ?? resolve(process.cwd(), '..'))
  if (!lstatSync(root).isDirectory()) throw new Error(`Repository path is not a directory: ${root}`)
  const files = listFiles(root)
  let scannedBytes = 0
  let evidence = ''
  let incomplete = false
  const secretSignals: SecretSignal[] = []
  const selectedFiles: string[] = []

  for (const absolute of files) {
    if (!isTextCandidate(absolute)) continue
    const size = lstatSync(absolute).size
    if (size > MAX_FILE_BYTES || scannedBytes + size > MAX_SCAN_BYTES) {
      incomplete = true
      continue
    }
    scannedBytes += size
    const path = relative(root, absolute)
    const text = readFileSync(absolute, 'utf8')
    const newSignals = collectSecretSignals(path, text)
    if (secretSignals.length + newSignals.length > 500) incomplete = true
    secretSignals.push(...newSignals.slice(0, Math.max(0, 500 - secretSignals.length)))
    const highSignal = /(?:^|\/)(?:package(?:-lock)?\.json|[^/]*(?:auth|route|server|api|config|security)[^/]*)$/i.test(path)
      || /\.(?:js|jsx|ts|tsx|py|go|rs|java|rb|php)$/i.test(path)
    if (!highSignal || /^\.env(?:\.|$)/.test(path)) continue
    const block = `\nFILE: ${path}\n${redactSecrets(text)}\n`
    if (evidence.length + block.length > MAX_EVIDENCE_CHARS) {
      incomplete = true
      continue
    }
    evidence += block
    selectedFiles.push(path)
  }

  evidence += `\nSECRET SIGNALS (values never included):\n${secretSignals.map((s) => `- ${s.path}:${s.line} ${s.type}`).join('\n') || '- none'}\n`
  let auditIncluded = false
  if (args.onlineAudit) {
    evidence += `\nNPM AUDIT JSON:\n${redactSecrets(await runNpmAudit(root))}\n`
    auditIncluded = true
  }
  if (!evidence.trim()) throw new Error(`No supported text files were found in ${root}.`)
  return {
    label: root,
    evidence,
    incomplete,
    metadata: { source: 'local', repo: root, filesScanned: files.length, filesIncluded: selectedFiles.length, scannedBytes, secretSignals, onlineAudit: auditIncluded },
  }
}
