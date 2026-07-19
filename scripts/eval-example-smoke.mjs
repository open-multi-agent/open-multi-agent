import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const example = join(
  root,
  'packages',
  'core',
  'examples',
  'patterns',
  'eval-offline-regression.ts',
)

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [tsx, example], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1' },
  })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolve()
    else reject(new Error(`eval example failed with code ${code ?? 'null'} signal ${signal ?? 'none'}`))
  })
})

console.log('evaluation example smoke: 1 passed')
