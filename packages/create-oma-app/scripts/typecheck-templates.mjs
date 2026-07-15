import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'oma-template-typecheck-'))
try {
  symlinkSync(join(pkgDir, '..', '..', 'node_modules'), join(work, 'node_modules'), 'dir')
  for (const template of ['demo', 'pr-review', 'security']) {
    const target = join(work, template)
    cpSync(join(pkgDir, 'template'), target, { recursive: true })
    cpSync(join(pkgDir, 'templates', template), target, { recursive: true, force: true })
    const result = spawnSync('tsc', ['-p', join(target, 'tsconfig.json')], { cwd: pkgDir, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${template} generated project failed typecheck`)
    console.log(`✓ ${template} generated project typechecks`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
