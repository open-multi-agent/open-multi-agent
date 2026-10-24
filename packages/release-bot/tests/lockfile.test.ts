import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertWorkspacesLinked, findUnlinkedWorkspaceEntries } from '../src/lockfile.js'

const WORKSPACE_LINKS = {
  'node_modules/@open-multi-agent/core': { resolved: 'packages/core', link: true },
  'node_modules/@open-multi-agent/otel': { resolved: 'packages/otel', link: true },
  'node_modules/@open-multi-agent/release-bot': { resolved: 'packages/release-bot', link: true },
  'node_modules/create-oma-app': { resolved: 'packages/create-oma-app', link: true },
} as const

const WORKSPACES = {
  'packages/core': { name: '@open-multi-agent/core', version: '1.22.0' },
  // npm omits `name` when it matches the folder name.
  'packages/create-oma-app': { version: '0.8.11' },
  'packages/otel': { name: '@open-multi-agent/otel', version: '0.1.4', dependencies: { '@open-multi-agent/core': '^1.11.0' } },
  'packages/release-bot': { name: '@open-multi-agent/release-bot', version: '0.0.0', dependencies: { '@open-multi-agent/core': '*' } },
} as const

function lockfile(extra: Record<string, unknown> = {}): unknown {
  return {
    name: 'open-multi-agent',
    lockfileVersion: 3,
    packages: {
      '': { name: 'open-multi-agent', workspaces: ['packages/*'] },
      ...WORKSPACE_LINKS,
      'node_modules/zod': { version: '4.6.7', resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz' },
      // A nested third-party package is not a workspace copy.
      'packages/core/node_modules/openai': { version: '6.49.0', resolved: 'https://registry.npmjs.org/openai/-/openai-6.49.0.tgz' },
      ...WORKSPACES,
      ...extra,
    },
  }
}

describe('workspace link check', () => {
  it('passes a lockfile that links every workspace', () => {
    expect(findUnlinkedWorkspaceEntries(lockfile())).toEqual([])
    expect(() => assertWorkspacesLinked(lockfile())).not.toThrow()
  })

  it('reports the published core that release PR #638 nested under otel', () => {
    const released = lockfile({
      'packages/otel/node_modules/@open-multi-agent/core': {
        version: '1.21.3',
        resolved: 'https://registry.npmjs.org/@open-multi-agent/core/-/core-1.21.3.tgz',
        license: 'MIT',
        dependencies: { zod: '^3.23.0' },
      },
    })

    expect(findUnlinkedWorkspaceEntries(released)).toEqual([{
      path: 'packages/otel/node_modules/@open-multi-agent/core',
      name: '@open-multi-agent/core',
      version: '1.21.3',
      resolved: 'https://registry.npmjs.org/@open-multi-agent/core/-/core-1.21.3.tgz',
      workspacePath: 'packages/core',
      workspaceVersion: '1.22.0',
    }])
    expect(() => assertWorkspacesLinked(released)).toThrow(
      'package-lock.json installs workspace packages instead of linking them: '
      + 'packages/otel/node_modules/@open-multi-agent/core@1.21.3 from '
      + 'https://registry.npmjs.org/@open-multi-agent/core/-/core-1.21.3.tgz (workspace packages/core is 1.22.0).',
    )
  })

  it('reports a root copy of an unscoped workspace and a link to the wrong folder', () => {
    const broken = lockfile({
      'node_modules/create-oma-app': {
        version: '0.8.10',
        resolved: 'https://registry.npmjs.org/create-oma-app/-/create-oma-app-0.8.10.tgz',
      },
      'node_modules/@open-multi-agent/otel': { resolved: 'packages/otel-old', link: true },
    })

    expect(findUnlinkedWorkspaceEntries(broken).map(entry => [entry.path, entry.workspacePath])).toEqual([
      ['node_modules/@open-multi-agent/otel', 'packages/otel'],
      ['node_modules/create-oma-app', 'packages/create-oma-app'],
    ])
  })

  it('fails closed when the lockfile has no packages map', () => {
    expect(() => findUnlinkedWorkspaceEntries({ lockfileVersion: 1, dependencies: {} })).toThrow(
      /no "packages" map/,
    )
  })
})

// The release bot runs this check after it regenerates the lockfile, but a
// release branch can also be edited by hand, and #638 reached main that way.
// Reading the committed lockfile here makes every PR's CI enforce it.
describe('repository lockfile invariant', () => {
  const committed = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../../package-lock.json', import.meta.url)),
    'utf8',
  )) as { packages: Record<string, unknown> }

  it('links every workspace package instead of installing a published copy', () => {
    expect(findUnlinkedWorkspaceEntries(committed)).toEqual([])
  })

  it('still records the workspace links the check depends on', () => {
    for (const [path, link] of Object.entries(WORKSPACE_LINKS)) {
      expect(committed.packages[path], path).toEqual(link)
    }
  })
})
