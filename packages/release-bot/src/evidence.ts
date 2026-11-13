import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandRunner } from './command.js'
import {
  releaseEvidenceSchema,
  type ChangedFile,
  type ReleaseCommit,
  type ReleaseEvidence,
} from './schema.js'

interface PackageManifest {
  readonly version?: unknown
  readonly files?: unknown
}

interface PublishedManifest {
  readonly version: string
  /** Whether a repository-relative path reaches this package's npm tarball. */
  readonly ships: (repoPath: string) => boolean
}

const PUBLISHED_WORKSPACES = {
  core: 'packages/core',
  otel: 'packages/otel',
  createOmaApp: 'packages/create-oma-app',
} as const

type PublishedWorkspace = keyof typeof PUBLISHED_WORKSPACES

/**
 * Build output named in a manifest's `files` field, mapped to the
 * package-relative inputs that produce it. Every published workspace runs
 * `tsc` with its `tsconfig.json` (rootDir `src`, outDir `dist`) before
 * publishing. A leading slash anchors an input to the package root.
 */
const BUILD_OUTPUT_INPUTS: Readonly<Record<string, readonly string[]>> = {
  dist: ['/src', '/tsconfig.json'],
}

/** npm packs these from the package root even when `files` omits them. */
const ALWAYS_SHIPPED_ROOT_FILE = /^(?:package\.json|(?:readme|license|licence|copying)(?:\..+)?)$/i

interface FilesEntry {
  readonly body: string
  readonly anchored: boolean
}

/**
 * Return a predicate over package-relative paths that is true when a path
 * ships in the npm tarball or compiles into something that does. Entries
 * follow the gitignore-style rules npm applies to `files`: an entry with a
 * leading or inner slash is anchored to the package root, and a bare name
 * matches in the root and in every directory npm walks to reach an anchored
 * entry (which is how `README.md` also ships `template/README.md`). Without a
 * `files` field npm ships the whole package, so every path counts.
 */
export function shippedPathMatcher(files: readonly string[] | undefined): (path: string) => boolean {
  if (files === undefined) return () => true
  const entries = files
    .flatMap(entry => BUILD_OUTPUT_INPUTS[normalizeFilesEntry(entry)] ?? [entry])
    .map(parseFilesEntry)
  const walkedDirectories = new Set([''])
  for (const { body, anchored } of entries) {
    if (!anchored) continue
    const segments = body.split('/')
    for (let end = 1; end < segments.length; end++) walkedDirectories.add(segments.slice(0, end).join('/'))
  }
  return path => ALWAYS_SHIPPED_ROOT_FILE.test(path) || entries.some(({ body, anchored }) => anchored
    ? path === body || path.startsWith(`${body}/`)
    : path.split('/').some((segment, index, segments) =>
        segment === body && walkedDirectories.has(segments.slice(0, index).join('/'))))
}

function parseFilesEntry(entry: string): FilesEntry {
  if (entry.startsWith('!') || /[*?[\]{}]/.test(entry)) {
    throw new Error(`Unsupported "files" entry "${entry}": globs and negations need explicit support in shippedPathMatcher.`)
  }
  const trimmed = entry.replace(/^\.\//, '').replace(/\/+$/, '')
  const body = normalizeFilesEntry(entry)
  if (body === '' || body === '.') {
    throw new Error(`Unsupported "files" entry "${entry}": it does not name a file or directory.`)
  }
  return { body, anchored: trimmed.includes('/') }
}

function normalizeFilesEntry(entry: string): string {
  return entry.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

export type ReleaseReviewRisk = 'critical' | 'high' | 'medium' | 'low'

export interface ReleaseReviewTarget extends ChangedFile {
  readonly risk: ReleaseReviewRisk
  readonly reasons: readonly string[]
}

export const DEFAULT_RELEASE_REVIEW_TARGET_LIMIT = 16

interface RankedReviewTarget extends ReleaseReviewTarget {
  readonly score: number
  readonly surface: ReviewSurface
}

type ReviewSurface =
  | 'public-contract'
  | 'release-automation'
  | 'workflow'
  | 'persistence'
  | 'provider'
  | 'core-runtime'
  | 'scaffolder'
  | 'otel'
  | 'documentation'
  | 'tests'
  | 'other'

const REVIEW_SURFACE_ORDER: readonly ReviewSurface[] = [
  'public-contract',
  'release-automation',
  'workflow',
  'persistence',
  'provider',
  'core-runtime',
  'scaffolder',
  'otel',
]

/**
 * Select a deterministic, risk-ranked subset of changed files for model review.
 * The fixed surface seed prevents a large refactor in one subsystem from
 * crowding every other release-critical surface out of the bounded bundle.
 */
export function selectReleaseReviewTargets(
  evidence: ReleaseEvidence,
  limit = DEFAULT_RELEASE_REVIEW_TARGET_LIMIT,
): readonly ReleaseReviewTarget[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('Release review target limit must be a non-negative integer.')
  }
  if (limit === 0) return []

  const ranked = evidence.changedFiles
    .map(rankReviewTarget)
    .sort(compareReviewTargets)
  const selected: RankedReviewTarget[] = []
  const selectedPaths = new Set<string>()

  const select = (target: RankedReviewTarget | undefined) => {
    if (!target || selected.length >= limit || selectedPaths.has(target.path)) return
    selected.push(target)
    selectedPaths.add(target.path)
  }

  for (const surface of REVIEW_SURFACE_ORDER) {
    select(ranked.find(target => target.surface === surface && target.risk !== 'low'))
  }
  for (const target of ranked) select(target)

  return selected
    .sort(compareReviewTargets)
    .map(({ score: _score, surface: _surface, ...target }) => target)
}

function rankReviewTarget(file: ChangedFile): RankedReviewTarget {
  const path = file.path
  const reasons: string[] = []
  let score = 10
  let surface: ReviewSurface = 'other'

  const setRank = (nextScore: number, nextSurface: ReviewSurface, reason: string) => {
    if (nextScore > score) {
      score = nextScore
      surface = nextSurface
    }
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  if (
    path === 'packages/core/src/index.ts'
    || path === 'packages/core/src/types.ts'
    || path === 'packages/core/src/errors.ts'
    || /^packages\/core\/src\/(?:acp|process|mcp|ai-sdk|classifiers)\.ts$/.test(path)
    || /^packages\/core\/src\/(?:observability|eval)\/(?:index|file)\.ts$/.test(path)
  ) {
    setRank(180, 'public-contract', 'published API or type contract')
  }
  if (/^packages\/(?:core|otel|create-oma-app)\/package\.json$/.test(path)) {
    setRank(175, 'public-contract', 'published package manifest')
  }
  if (/^\.github\/workflows\/(?:publish|release-bot|ci|release-smoke)\.yml$/.test(path)) {
    setRank(170, 'workflow', 'release or CI authority boundary')
  }
  if (path === '.github/RELEASING.md') {
    setRank(165, 'workflow', 'release contract')
  }
  if (/^packages\/release-bot\/src\/(?:apply-plan|prepare|publisher|registry|github|schema|orchestrator|tools|evidence)\.ts$/.test(path)) {
    setRank(160, 'release-automation', 'release decision or mutation boundary')
  }
  if (/^packages\/core\/src\/(?:memory|approval|observability)\//.test(path)) {
    setRank(150, 'persistence', 'durability, approval, or trace contract')
  }
  if (/^packages\/core\/src\/llm\//.test(path)) {
    setRank(145, 'provider', 'provider wire behavior')
  }
  if (/^packages\/core\/src\//.test(path)) {
    setRank(130, 'core-runtime', 'published core runtime')
  }
  if (/^packages\/create-oma-app\/(?:src|template|templates)\//.test(path)) {
    setRank(125, 'scaffolder', 'generated-project behavior')
  }
  if (/^packages\/otel\/src\//.test(path)) {
    setRank(125, 'otel', 'published OpenTelemetry adapter')
  }
  if (path === 'package-lock.json') {
    setRank(100, 'public-contract', 'resolved dependency graph')
  }
  if (path === 'CHANGELOG.md' || path === 'README.md' || path === 'README_zh.md' || path.startsWith('docs/')) {
    setRank(70, 'documentation', 'user-facing documentation')
  }
  if (/\/(?:tests?|examples)\//.test(path) || /\.test\.[cm]?[jt]s$/.test(path)) {
    setRank(35, 'tests', 'test or example coverage')
  }

  const additions = file.additions ?? 0
  const deletions = file.deletions ?? 0
  if (deletions > 0) {
    score += Math.min(12, 2 + Math.floor(Math.log2(deletions + 1)))
    reasons.push('deletions can narrow existing behavior')
  }
  score += Math.min(8, Math.floor(Math.log2(additions + deletions + 1)))

  const risk: ReleaseReviewRisk = score >= 160
    ? 'critical'
    : score >= 120
      ? 'high'
      : score >= 60
        ? 'medium'
        : 'low'

  return { ...file, risk, reasons, score, surface }
}

function compareReviewTargets(a: RankedReviewTarget, b: RankedReviewTarget): number {
  return b.score - a.score || a.path.localeCompare(b.path)
}

export async function collectReleaseEvidence(
  repoRoot: string,
  runner: CommandRunner,
  generatedAt = new Date().toISOString(),
): Promise<ReleaseEvidence> {
  const [baseTagResult, headResult, manifests] = await Promise.all([
    runner.run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { cwd: repoRoot }),
    runner.run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    readPublishedManifests(repoRoot),
  ])

  const baseTag = baseTagResult.stdout.trim()
  if (!/^v\d+\.\d+\.\d+$/.test(baseTag)) {
    throw new Error(`Latest core tag is not a stable release tag: "${baseTag}".`)
  }

  const baseSha = (await runner.run('git', ['rev-list', '-n', '1', baseTag], { cwd: repoRoot })).stdout.trim()
  const headSha = headResult.stdout.trim()
  const range = `${baseSha}..${headSha}`

  // --no-renames lists a moved file under both its old and new path, so moving
  // a file out of a shipped directory still counts as a change to that package.
  const [logResult, namesResult, statsResult, changelog] = await Promise.all([
    runner.run('git', ['log', '--format=%H%x1f%s%x1f%b%x1e', range], { cwd: repoRoot }),
    runner.run('git', ['diff', '--no-renames', '--name-only', '-z', range], { cwd: repoRoot }),
    runner.run('git', ['diff', '--no-renames', '--numstat', '-z', range], { cwd: repoRoot }),
    readFile(join(repoRoot, 'CHANGELOG.md'), 'utf8'),
  ])

  const paths = namesResult.stdout.split('\0').filter(Boolean)
  const stats = parseNumstat(statsResult.stdout)
  const changedFiles = paths.map(path => ({
    path,
    additions: stats.get(path)?.additions ?? null,
    deletions: stats.get(path)?.deletions ?? null,
  }))

  return releaseEvidenceSchema.parse({
    schemaVersion: 1,
    generatedAt,
    baseTag,
    baseSha,
    headSha,
    versions: {
      core: manifests.core.version,
      otel: manifests.otel.version,
      createOmaApp: manifests.createOmaApp.version,
    },
    commits: parseLog(logResult.stdout),
    changedFiles,
    changelogUnreleased: extractUnreleased(changelog),
    // A published workspace counts as changed only when a path that reaches its
    // npm tarball changed. Tests, examples, and agent guidance files do not.
    workspaceChanges: {
      core: paths.some(manifests.core.ships),
      otel: paths.some(manifests.otel.ships),
      createOmaApp: paths.some(manifests.createOmaApp.ships),
      docs: paths.some(path => path === 'README.md' || path.startsWith('docs/')),
      workflows: paths.some(path => path.startsWith('.github/workflows/')),
    },
  })
}

/** Read the HEAD manifest of every published workspace. */
export async function readPublishedManifests(
  repoRoot: string,
): Promise<Record<PublishedWorkspace, PublishedManifest>> {
  const [core, otel, createOmaApp] = await Promise.all([
    readPublishedManifest(repoRoot, PUBLISHED_WORKSPACES.core),
    readPublishedManifest(repoRoot, PUBLISHED_WORKSPACES.otel),
    readPublishedManifest(repoRoot, PUBLISHED_WORKSPACES.createOmaApp),
  ])
  return { core, otel, createOmaApp }
}

async function readPublishedManifest(repoRoot: string, workspace: string): Promise<PublishedManifest> {
  const path = join(repoRoot, workspace, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as PackageManifest
  if (typeof manifest.version !== 'string') {
    throw new Error(`Manifest has no string version: ${path}`)
  }
  const { files } = manifest
  const isFileList = Array.isArray(files) && files.every((entry): entry is string => typeof entry === 'string')
  if (files !== undefined && !isFileList) {
    throw new Error(`Manifest "files" is not a list of strings: ${path}`)
  }
  const shipsWithinPackage = shippedPathMatcher(isFileList ? files : undefined)
  const prefix = `${workspace}/`
  return {
    version: manifest.version,
    ships: repoPath => repoPath.startsWith(prefix) && shipsWithinPackage(repoPath.slice(prefix.length)),
  }
}

function parseLog(output: string): ReleaseCommit[] {
  return output
    .split('\x1e')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [sha = '', subject = '', ...body] = record.split('\x1f')
      return { sha, subject, body: body.join('\x1f').trim() }
    })
}

function parseNumstat(output: string): Map<string, Pick<ChangedFile, 'additions' | 'deletions'>> {
  const result = new Map<string, Pick<ChangedFile, 'additions' | 'deletions'>>()
  const fields = output.split('\0').filter(Boolean)
  for (const field of fields) {
    const [rawAdditions = '-', rawDeletions = '-', path = ''] = field.split('\t')
    if (!path) continue
    result.set(path, {
      additions: rawAdditions === '-' ? null : Number(rawAdditions),
      deletions: rawDeletions === '-' ? null : Number(rawDeletions),
    })
  }
  return result
}

export function extractUnreleased(changelog: string): string {
  const match = /^## Unreleased[ \t]*(?:\n|$)/m.exec(changelog)
  if (!match) throw new Error('CHANGELOG.md is missing the "## Unreleased" section.')
  const bodyStart = match.index + match[0].length
  const remainder = changelog.slice(bodyStart)
  const next = /^## /m.exec(remainder)
  return remainder.slice(0, next?.index ?? remainder.length).trim()
}
