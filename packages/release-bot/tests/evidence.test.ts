import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeCommandRunner } from '../src/command.js'
import { collectReleaseEvidence, readPublishedManifests, shippedPathMatcher } from '../src/evidence.js'

const roots: string[] = []
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('release evidence collection', () => {
  it('anchors evidence to the latest stable core tag and exact HEAD', async () => {
    const root = await createRepository()
    const runner = new NodeCommandRunner()
    const evidence = await collectReleaseEvidence(root, runner, '2026-08-10T00:00:00.000Z')

    expect(evidence.baseTag).toBe('v1.14.0')
    expect(evidence.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(evidence.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(evidence.headSha).not.toBe(evidence.baseSha)
    expect(evidence.versions).toEqual({ core: '1.14.0', otel: '0.1.1', createOmaApp: '0.7.0' })
    expect(evidence.commits).toHaveLength(1)
    expect(evidence.commits[0]).toMatchObject({
      subject: 'feat(core): resume interrupted turns',
      body: 'Adds stable tool call replay.',
    })
    expect(evidence.changedFiles).toContainEqual({
      path: 'packages/core/src/recovery.ts',
      additions: 1,
      deletions: 0,
    })
    expect(evidence.workspaceChanges).toEqual({
      core: true,
      otel: false,
      createOmaApp: false,
      docs: true,
      workflows: false,
    })
  })

  it('reports otel unchanged when only its agent guidance and tests changed', async () => {
    const root = await createRepository({
      'packages/otel/AGENTS.md': '# otel agent rules\n',
      'packages/otel/CLAUDE.md': '@AGENTS.md\n',
      'packages/otel/tests/sink.test.ts': 'export {}\n',
    })
    const evidence = await collectReleaseEvidence(root, new NodeCommandRunner())

    expect(evidence.changedFiles.map(file => file.path)).toContain('packages/otel/AGENTS.md')
    expect(evidence.workspaceChanges.otel).toBe(false)
  })

  it('reports otel changed when its source changed', async () => {
    const root = await createRepository({
      'packages/otel/src/sink.ts': 'export const sink = 2\n',
    })
    const evidence = await collectReleaseEvidence(root, new NodeCommandRunner())

    expect(evidence.workspaceChanges.otel).toBe(true)
  })

  it('reports otel changed when a source file moves out of src', async () => {
    const root = await createRepository({
      'packages/otel/src/sink.ts': null,
      'packages/otel/tests/fixtures/sink.ts': BASELINE['packages/otel/src/sink.ts'],
    })
    const evidence = await collectReleaseEvidence(root, new NodeCommandRunner())

    expect(evidence.changedFiles).toContainEqual({ path: 'packages/otel/src/sink.ts', additions: 0, deletions: 1 })
    expect(evidence.workspaceChanges.otel).toBe(true)
  })

  it('applies the same shipped-path rule to core and create-oma-app', async () => {
    const unshipped = await createRepository({
      'packages/core/AGENTS.md': '# core agent rules\n',
      'packages/core/examples/basic.ts': 'export {}\n',
      'packages/create-oma-app/tests/scaffold.test.ts': 'export {}\n',
      'packages/create-oma-app/template/package.json': '{}\n',
    })
    expect((await collectReleaseEvidence(unshipped, new NodeCommandRunner())).workspaceChanges).toMatchObject({
      core: false,
      createOmaApp: false,
    })

    const shipped = await createRepository({
      'packages/core/README.md': '# core, revised\n',
      'packages/create-oma-app/templates/demo/src/index.ts': 'export {}\n',
    })
    expect((await collectReleaseEvidence(shipped, new NodeCommandRunner())).workspaceChanges).toMatchObject({
      core: true,
      createOmaApp: true,
    })
  })
})

describe('shipped path matcher', () => {
  const otel = shippedPathMatcher(['dist', 'README.md', 'LICENSE'])

  it('maps dist to the sources and tsconfig that compile into it', () => {
    expect(otel('src/index.ts')).toBe(true)
    expect(otel('src/exporters/span.ts')).toBe(true)
    expect(otel('tsconfig.json')).toBe(true)
    expect(otel('tsconfig.lint.json')).toBe(false)
    expect(otel('tests/fixtures/src/index.ts')).toBe(false)
  })

  it('counts the manifest and listed files but not tests or agent guidance', () => {
    expect(otel('package.json')).toBe(true)
    expect(otel('README.md')).toBe(true)
    expect(otel('LICENSE')).toBe(true)
    expect(otel('AGENTS.md')).toBe(false)
    expect(otel('CLAUDE.md')).toBe(false)
    expect(otel('tests/sink.test.ts')).toBe(false)
    expect(otel('vitest.config.ts')).toBe(false)
  })

  it('follows npm gitignore-style anchoring for files entries', () => {
    const matcher = shippedPathMatcher(['template/_env.example', 'templates/', 'README.md'])
    expect(matcher('template/_env.example')).toBe(true)
    expect(matcher('template/package.json')).toBe(false)
    expect(matcher('nested/template/_env.example')).toBe(false)
    expect(matcher('templates/demo/package.json')).toBe(true)
    expect(matcher('templates/demo/README.md')).toBe(true)
    // npm walks template/ to reach template/_env.example, so the bare README.md
    // entry also packs template/README.md, but not READMEs in unwalked folders.
    expect(matcher('template/README.md')).toBe(true)
    expect(matcher('template/src/README.md')).toBe(false)
    expect(matcher('examples/README.md')).toBe(false)
  })

  it('ships npm always-included root files even when files omits them', () => {
    const matcher = shippedPathMatcher(['dist'])
    expect(matcher('package.json')).toBe(true)
    expect(matcher('README.md')).toBe(true)
    expect(matcher('LICENSE')).toBe(true)
    expect(matcher('README_zh.md')).toBe(false)
    expect(matcher('docs/README.md')).toBe(false)
  })

  it('counts every path when the manifest has no files field', () => {
    const matcher = shippedPathMatcher(undefined)
    expect(matcher('tests/anything.test.ts')).toBe(true)
  })

  it('refuses files entries it cannot evaluate exactly', () => {
    expect(() => shippedPathMatcher(['dist/**/*.js'])).toThrow(/globs and negations/)
    expect(() => shippedPathMatcher(['dist', '!dist/internal'])).toThrow(/globs and negations/)
    expect(() => shippedPathMatcher(['./'])).toThrow(/does not name a file or directory/)
  })
})

describe('repository published manifests', () => {
  it('derive shipped paths that match what each package publishes', async () => {
    const manifests = await readPublishedManifests(repoRoot)

    expect(manifests.otel.ships('packages/otel/src/index.ts')).toBe(true)
    expect(manifests.otel.ships('packages/otel/package.json')).toBe(true)
    expect(manifests.otel.ships('packages/otel/AGENTS.md')).toBe(false)
    expect(manifests.otel.ships('packages/otel/CLAUDE.md')).toBe(false)
    expect(manifests.otel.ships('packages/otel/tests/otel-sink.test.ts')).toBe(false)
    expect(manifests.otel.ships('packages/core/src/index.ts')).toBe(false)

    expect(manifests.core.ships('packages/core/src/index.ts')).toBe(true)
    expect(manifests.core.ships('packages/core/README.md')).toBe(true)
    expect(manifests.core.ships('packages/core/README_zh.md')).toBe(false)
    expect(manifests.core.ships('packages/core/examples/README.md')).toBe(false)
    expect(manifests.core.ships('packages/core/AGENTS.md')).toBe(false)

    expect(manifests.createOmaApp.ships('packages/create-oma-app/src/scaffold.ts')).toBe(true)
    expect(manifests.createOmaApp.ships('packages/create-oma-app/template/_gitignore')).toBe(true)
    expect(manifests.createOmaApp.ships('packages/create-oma-app/template/README.md')).toBe(true)
    expect(manifests.createOmaApp.ships('packages/create-oma-app/templates/demo/src/index.ts')).toBe(true)
    expect(manifests.createOmaApp.ships('packages/create-oma-app/scripts/test-scaffold.mjs')).toBe(false)
  })

  it.each(['core', 'otel', 'create-oma-app'])('%s compiles src into dist, as the dist mapping assumes', async workspace => {
    const tsconfig = JSON.parse(await readFile(join(repoRoot, 'packages', workspace, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { rootDir?: string, outDir?: string }
    }
    expect(tsconfig.compilerOptions).toMatchObject({ rootDir: 'src', outDir: 'dist' })
  })
})

const BASELINE = {
  'packages/core/package.json': manifest({ name: '@open-multi-agent/core', version: '1.14.0', files: ['dist', 'README.md', 'LICENSE'] }),
  'packages/core/README.md': '# core\n',
  'packages/core/src/index.ts': 'export {}\n',
  'packages/otel/package.json': manifest({ name: '@open-multi-agent/otel', version: '0.1.1', files: ['dist', 'README.md', 'LICENSE'] }),
  'packages/otel/src/sink.ts': 'export const sink = 1\n',
  'packages/create-oma-app/package.json': manifest({
    name: 'create-oma-app',
    version: '0.7.0',
    files: ['dist', 'template/_env.example', 'templates', 'README.md', 'LICENSE'],
  }),
  'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n## 1.14.0 - 2026-08-01\n\n- Initial.\n',
} as const

const DEFAULT_CHANGES: Record<string, string> = {
  'packages/core/src/recovery.ts': 'export const recovery = true\n',
  'docs/checkpoint.md': 'Recovery is resumable.\n',
}

/**
 * Commit BASELINE, tag it v1.14.0, then commit `changes` on top. A null value
 * deletes the path.
 */
async function createRepository(changes: Record<string, string | null> = DEFAULT_CHANGES): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oma-release-evidence-'))
  roots.push(root)
  const runner = new NodeCommandRunner()
  await runner.run('git', ['init'], { cwd: root })
  await runner.run('git', ['config', 'user.name', 'OMA Test'], { cwd: root })
  await runner.run('git', ['config', 'user.email', 'oma-test@example.com'], { cwd: root })

  for (const [path, value] of Object.entries(BASELINE)) await writeText(root, path, value)
  await runner.run('git', ['add', '.'], { cwd: root })
  await runner.run('git', ['commit', '-m', 'chore: baseline'], { cwd: root })
  await runner.run('git', ['tag', 'v1.14.0'], { cwd: root })

  for (const [path, value] of Object.entries(changes)) {
    if (value === null) await rm(join(root, path))
    else await writeText(root, path, value)
  }
  await runner.run('git', ['add', '-A'], { cwd: root })
  await runner.run('git', ['commit', '-m', 'feat(core): resume interrupted turns', '-m', 'Adds stable tool call replay.'], { cwd: root })
  return root
}

function manifest(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeText(root: string, path: string, value: string): Promise<void> {
  const absolute = join(root, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, value)
}
