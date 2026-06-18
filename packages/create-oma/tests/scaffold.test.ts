import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isNonEmptyDir, scaffold, TEMPLATE_DIR, toPackageName } from '../src/scaffold.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'create-oma-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('scaffold', () => {
  it('generates a project that depends only on @open-multi-agent/core', () => {
    const target = join(tmp, 'my-demo')
    scaffold({ targetDir: target, projectName: 'My Demo' })

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    // The 3-dependency promise extends here: the generated project is just core.
    expect(Object.keys(pkg.dependencies)).toEqual(['@open-multi-agent/core'])
    expect(Object.keys(pkg.devDependencies)).toEqual(['tsx'])
    expect(pkg.name).toBe('my-demo') // stamped + sanitized
  })

  it('restores dotfiles and ships the demo + env example', () => {
    const target = join(tmp, 'd')
    scaffold({ targetDir: target, projectName: 'd' })

    expect(existsSync(join(target, '.gitignore'))).toBe(true)
    expect(existsSync(join(target, '.env.example'))).toBe(true)
    expect(existsSync(join(target, '_gitignore'))).toBe(false)
    expect(existsSync(join(target, '_env.example'))).toBe(false)
    expect(existsSync(join(target, 'src/index.ts'))).toBe(true)
    expect(existsSync(join(target, 'README.md'))).toBe(true)
  })

  // Landmine #1: a short, simple goal hits runTeam's single-agent short-circuit,
  // which would kill the multi-agent DAG. isSimpleGoal returns false once the
  // goal exceeds 200 chars (packages/core/src/orchestrator/orchestrator.ts), so
  // we pin the demo goal well above that.
  it('demo goal is long enough to bypass the single-agent short-circuit', () => {
    const demo = readFileSync(join(TEMPLATE_DIR, 'src', 'index.ts'), 'utf8')
    const match = demo.match(/const goal = `([\s\S]*?)`/)
    expect(match).not.toBeNull()
    expect(match![1].length).toBeGreaterThan(200)
  })

  // Landmine #2: a default tool preset would give the "no tools" demo agents
  // filesystem/bash access and write to disk. Assert the demo declares neither.
  it('demo agents declare no tools and set no default preset', () => {
    const demo = readFileSync(join(TEMPLATE_DIR, 'src', 'index.ts'), 'utf8')
    expect(demo).not.toMatch(/\btools\s*:/)
    expect(demo).not.toMatch(/toolPreset/)
  })

  it('isNonEmptyDir distinguishes empty, non-empty, and missing dirs', () => {
    expect(isNonEmptyDir(tmp)).toBe(false) // freshly created, empty
    writeFileSync(join(tmp, 'x'), '1')
    expect(isNonEmptyDir(tmp)).toBe(true)
    expect(isNonEmptyDir(join(tmp, 'does-not-exist'))).toBe(false)
  })

  it('toPackageName sanitizes to a valid npm name', () => {
    expect(toPackageName('My Demo')).toBe('my-demo')
    expect(toPackageName('   ')).toBe('oma-demo')
    expect(toPackageName('@scope/Foo')).toBe('scope-foo')
    expect(toPackageName('Cool_App!')).toBe('cool-app')
  })
})
