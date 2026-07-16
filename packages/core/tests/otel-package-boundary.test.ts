import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('optional OTel package boundary', () => {
  it('keeps the core import and runtime dependency set independent from OpenTelemetry', async () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@opentelemetry/'))).toEqual([])

    const core = await import('../src/index.js')
    expect(core.OpenMultiAgent).toBeTypeOf('function')
    expect(core.BatchingTraceSink).toBeTypeOf('function')
  })

  // The workspace hoists @opentelemetry/*, so a stray core import would still
  // resolve here; scan the source instead of relying on module resolution.
  it('keeps OpenTelemetry references out of core source files', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return walk(path)
        return entry.name.endsWith('.ts') ? [path] : []
      })
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const offenders = walk(srcDir).filter((file) => readFileSync(file, 'utf8').includes('@opentelemetry'))
    expect(offenders).toEqual([])
  })
})
