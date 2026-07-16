import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PACKAGE_VERSION } from '../src/version.js'

describe('package version constant', () => {
  it('matches package.json so the default instrumentationVersion cannot drift on release', () => {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }
    expect(PACKAGE_VERSION).toBe(manifest.version)
  })
})
