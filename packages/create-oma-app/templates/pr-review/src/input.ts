import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const execFileAsync = promisify(execFile)
export const MAX_DIFF_CHARS = 60_000

export interface ReviewInput {
  readonly label: string
  readonly evidence: string
  readonly incomplete: boolean
  readonly metadata: Record<string, unknown>
}

interface ReviewArgs {
  readonly demo: boolean
  readonly repo?: string
  readonly base?: string
  readonly pr?: string
}

export function parseReviewArgs(argv: readonly string[]): ReviewArgs {
  let demo = false
  let repo: string | undefined
  let base: string | undefined
  let pr: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--demo') demo = true
    else if (arg === '--repo' || arg === '--base' || arg === '--pr') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`)
      if (arg === '--repo') repo = value
      if (arg === '--base') base = value
      if (arg === '--pr') pr = value
      i += 1
    } else throw new Error(`Unknown option "${arg}".`)
  }
  if ([demo, Boolean(pr), Boolean(repo)].filter(Boolean).length > 1) {
    throw new Error('Use exactly one input mode: --demo, --pr, or --repo.')
  }
  if (base && (pr || demo)) throw new Error('--base can only be used with a local repository.')
  if (base?.startsWith('-')) throw new Error('--base must be a Git revision, not an option.')
  return { demo, repo, base, pr }
}

export function parsePullRequestRef(value: string): { owner: string; repo: string; number: number } {
  const url = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/)
  const short = value.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  const match = url ?? short
  if (!match) throw new Error('PR must be a GitHub pull URL or owner/repo#number.')
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) }
}

export function truncateDiff(diff: string, limit = MAX_DIFF_CHARS): { text: string; truncated: boolean } {
  if (diff.length <= limit) return { text: diff, truncated: false }
  const sections = diff.split(/(?=^diff --git )/m)
  let text = ''
  for (const section of sections) {
    if (text.length + section.length > limit) break
    text += section
  }
  if (!text) text = diff.slice(0, limit).replace(/\n[^\n]*$/, '\n')
  return { text: `${text}\n[DIFF TRUNCATED AT ${limit} CHARACTERS]\n`, truncated: true }
}

async function localInput(repoPath: string, base?: string): Promise<ReviewInput> {
  const cwd = resolve(repoPath)
  const args = base
    ? ['diff', '--no-ext-diff', '--unified=40', `${base}...HEAD`, '--']
    : ['diff', '--no-ext-diff', '--unified=40', 'HEAD', '--']
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }))
  } catch (error) {
    throw new Error(`Unable to read Git diff from ${cwd}. ${String(error)}`)
  }
  if (!stdout.trim()) throw new Error('The selected local Git diff is empty. Use --base, choose another repo, or run npm run demo.')
  const compact = truncateDiff(stdout)
  return {
    label: base ? `${cwd}: ${base}...HEAD` : `${cwd}: working tree vs HEAD`,
    evidence: compact.text,
    incomplete: compact.truncated,
    metadata: { source: 'local', repo: cwd, base: base ?? 'HEAD' },
  }
}

async function githubInput(reference: string): Promise<ReviewInput> {
  const { owner, repo, number } = parsePullRequestRef(reference)
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'create-oma-app-pr-review',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const metadataResponse = await fetch(url, { headers })
  if (!metadataResponse.ok) {
    throw new Error(`GitHub PR metadata failed: HTTP ${metadataResponse.status}. Check the PR and GITHUB_TOKEN.`)
  }
  const metadata = (await metadataResponse.json()) as {
    title?: string
    body?: string | null
    user?: { login?: string }
    base?: { ref?: string }
    head?: { ref?: string }
    changed_files?: number
  }
  const diffResponse = await fetch(url, { headers: { ...headers, Accept: 'application/vnd.github.v3.diff' } })
  if (!diffResponse.ok) throw new Error(`GitHub PR diff failed: HTTP ${diffResponse.status}.`)
  const compact = truncateDiff(await diffResponse.text())
  return {
    label: `${owner}/${repo}#${number}: ${metadata.title ?? 'Untitled PR'}`,
    evidence: compact.text,
    incomplete: compact.truncated,
    metadata: {
      source: 'github', owner, repo, number,
      title: metadata.title, description: metadata.body, author: metadata.user?.login,
      base: metadata.base?.ref, head: metadata.head?.ref, changedFiles: metadata.changed_files,
    },
  }
}

const DEMO_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,6 +1,12 @@
-export async function login(email: string) {
-  return db.query('SELECT * FROM users WHERE email = $1', [email])
+export async function login(email: string, password: string) {
+  const user = await db.query(\`SELECT * FROM users WHERE email = '\${email}'\`)
+  if (user && user.password === password) {
+    console.log('login', email, password)
+    return { token: signToken({ userId: user.id }) }
+  }
+  return null
 }
`

export async function collectReviewInput(argv: readonly string[]): Promise<ReviewInput> {
  const args = parseReviewArgs(argv)
  if (args.demo) return { label: 'Bundled vulnerable authentication patch', evidence: DEMO_DIFF, incomplete: false, metadata: { source: 'demo' } }
  if (args.pr) return githubInput(args.pr)
  return localInput(args.repo ?? resolve(process.cwd(), '..'), args.base)
}
