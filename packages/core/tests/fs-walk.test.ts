import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { collectFiles } from '../src/tool/built-in/fs-walk.js'
import { detectSymlinkSupport } from './helpers/symlink-support.js'

const symlinksSupported = await detectSymlinkSupport()

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fs-walk-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('collectFiles', () => {
  it('collects regular files and recurses real directories', async () => {
    await writeFile(join(dir, 'top.ts'), '')
    const sub = join(dir, 'nested')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'deep.ts'), '')

    const files = await collectFiles(dir, undefined, undefined)

    expect(files).toContain(join(dir, 'top.ts'))
    expect(files).toContain(join(sub, 'deep.ts'))
  })

  it.skipIf(!symlinksSupported)('skips symlinked directories', async () => {
    const root = join(dir, 'root')
    const outside = join(dir, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'safe.ts'), '')
    await writeFile(join(outside, 'secret.ts'), '')
    await symlink(outside, join(root, 'linked-outside'))

    const files = await collectFiles(root, undefined, undefined)

    expect(files).toContain(join(root, 'safe.ts'))
    expect(files.some((f) => f.includes('linked-outside'))).toBe(false)
    expect(files.some((f) => f.includes('secret.ts'))).toBe(false)
  })

  it.skipIf(!symlinksSupported)('skips symlinks to files', async () => {
    const root = join(dir, 'root')
    const outside = join(dir, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'safe.ts'), '')
    await writeFile(join(outside, 'secret.ts'), '')
    await symlink(join(outside, 'secret.ts'), join(root, 'linked-secret.ts'))

    const files = await collectFiles(root, undefined, undefined)

    expect(files).toContain(join(root, 'safe.ts'))
    expect(files).not.toContain(join(root, 'linked-secret.ts'))
  })

  it('honours SKIP_DIRS and does not descend into them', async () => {
    const root = join(dir, 'root')
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg.ts'), '')
    await writeFile(join(root, '.git', 'object.ts'), '')
    await writeFile(join(root, 'src', 'app.ts'), '')

    const files = await collectFiles(root, undefined, undefined)

    expect(files).toContain(join(root, 'src', 'app.ts'))
    expect(files.some((f) => f.includes('node_modules'))).toBe(false)
    expect(files.some((f) => f.includes('.git'))).toBe(false)
  })
})
