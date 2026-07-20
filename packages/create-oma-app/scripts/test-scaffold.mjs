/**
 * End-to-end scaffold smoke test for create-oma-app.
 *
 * Why this exists: the unit tests (tests/scaffold.test.ts) call scaffold()
 * directly. They never prove the PACKED tarball — the exact bytes that hit npm —
 * generates a project that actually installs and runs. This does, in an isolated
 * temp dir that never touches the repo working tree. (That isolation is the
 * whole point: scaffolds belong OUTSIDE the repo, not in its working copy.)
 *
 * The chain it proves, with NO API key and NO real LLM call:
 *   build → pack scaffolder → unpack → run the packed CLI → assert structure →
 *   install → every `npm run demo` completes with deterministic adapters →
 *   real Cloud/Ollama runs still reach their configuration gates.
 *
 * Core is installed from a freshly packed LOCAL tarball, not from npm, so the
 * test validates THIS commit's code and stays green during the release window
 * when the template pins a core version that isn't published yet.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pkgDir, '..', '..')
const PROJECT = 'oma-e2e-demo'

/** Run a command inheriting stdio; throw a clear error on non-zero exit. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8', ...opts })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.status})`)
  return res
}

/** npm pack a workspace into `dest`; return the absolute tarball path. */
function pack(workspace, dest) {
  const res = spawnSync('npm', ['pack', '-w', workspace, '--json', `--pack-destination=${dest}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`npm pack ${workspace} failed:\n${res.stderr}`)
  return join(dest, JSON.parse(res.stdout)[0].filename)
}

let work
try {
  console.log('• building core + create-oma-app')
  run('npm', ['run', 'build', '-w', '@open-multi-agent/core', '-w', 'create-oma-app'], { cwd: repoRoot })

  work = mkdtempSync(join(tmpdir(), 'oma-scaffold-e2e-'))
  console.log(`• workdir: ${work}`)

  console.log('• packing core + scaffolder')
  const coreTarball = pack('@open-multi-agent/core', work)
  const scaffoldTarball = pack('create-oma-app', work)

  console.log('• unpacking the scaffolder tarball (the published bytes)')
  run('tar', ['-xzf', scaffoldTarball, '-C', work])
  const cli = join(work, 'package', 'dist', 'index.js')

  console.log('• checking packed CLI help')
  const help = spawnSync('node', [cli, '--help'], { cwd: work, encoding: 'utf8' })
  if (help.status !== 0 || !help.stdout.includes('--no-install') || !help.stdout.includes('--no-run')) {
    throw new Error(`packed CLI help is missing post-scaffold opt-outs\n${help.stdout ?? ''}${help.stderr ?? ''}`)
  }

  console.log(`• generating legacy project "${PROJECT}" via the packed CLI`)
  // Passing the name skips the interactive prompt; the empty temp dir means no
  // overwrite confirmation — so the CLI runs fully non-interactively.
  run('node', [cli, PROJECT], { cwd: work })

  console.log('• generating every template/runtime combination')
  for (const template of ['demo', 'pr-review', 'security']) {
    for (const provider of ['cloud', 'ollama']) {
      const project = `oma-e2e-${template}-${provider}`
      run('node', [cli, project, '--template', template, '--provider', provider], { cwd: work })
      const generated = join(work, project)
      for (const f of ['package.json', 'src/index.ts', 'src/runtime.ts', 'src/demo-adapter.ts', 'src/report.ts', '.gitignore', '.env.example', 'tsconfig.json', 'README.md']) {
        if (!existsSync(join(generated, f))) throw new Error(`${project} is missing ${f}`)
      }
      if (provider === 'ollama' && !existsSync(join(generated, '.env'))) throw new Error(`${project} is missing its local .env`)
      const generatedPkg = JSON.parse(readFileSync(join(generated, 'package.json'), 'utf8'))
      if (template !== 'demo' && !generatedPkg.dependencies?.zod) throw new Error(`${project} is missing zod`)
    }
  }

  console.log('• asserting generated structure')
  const proj = join(work, PROJECT)
  for (const f of ['package.json', 'src/index.ts', '.gitignore', '.env.example', 'tsconfig.json', 'README.md']) {
    if (!existsSync(join(proj, f))) throw new Error(`generated project is missing ${f}`)
  }
  const pkg = JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8'))
  if (pkg.name !== PROJECT) throw new Error(`project name not stamped (got "${pkg.name}")`)
  if (!pkg.dependencies?.['@open-multi-agent/core']) {
    throw new Error('generated project does not depend on @open-multi-agent/core')
  }

  console.log('• installing and running every no-key demo (core from the local tarball)')
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  delete env.OMA_MODEL
  delete env.OPENAI_BASE_URL
  env.OLLAMA_HOST = 'http://127.0.0.1:1'

  for (const template of ['demo', 'pr-review', 'security']) {
    const cloudProj = join(work, `oma-e2e-${template}-cloud`)
    run('npm', ['install', '--no-audit', '--no-fund', coreTarball], { cwd: cloudProj })
    const demo = spawnSync('npm', ['run', 'demo'], { cwd: cloudProj, env, encoding: 'utf8' })
    const output = `${demo.stdout ?? ''}${demo.stderr ?? ''}`
    if (demo.status !== 0 || !/Simulated model responses/.test(output) || !/demo-fixture/.test(output)) {
      throw new Error(`expected ${template} no-key demo to succeed with a simulation notice; got exit ${demo.status}.\n${output}`)
    }

    if (template === 'demo') {
      const dashboard = readFileSync(join(cloudProj, 'dashboard.html'), 'utf8')
      if (!/Simulated model responses/.test(dashboard)) throw new Error('demo dashboard is missing its simulation label')
      continue
    }

    const reports = join(cloudProj, 'reports')
    const names = readdirSync(reports)
    const markdown = names.find((name) => name.endsWith('.md'))
    const json = names.find((name) => name.endsWith('.json'))
    const dashboard = names.find((name) => name.endsWith('.html'))
    if (!markdown || !json || !dashboard) throw new Error(`${template} demo did not write all report formats`)
    if (!/Demo mode/.test(readFileSync(join(reports, markdown), 'utf8'))) throw new Error(`${template} Markdown lacks demo disclosure`)
    if (!/"mode": "demo"/.test(readFileSync(join(reports, json), 'utf8'))) throw new Error(`${template} JSON lacks demo metadata`)
    if (!/Simulated model responses/.test(readFileSync(join(reports, dashboard), 'utf8'))) throw new Error(`${template} dashboard lacks demo disclosure`)
  }

  console.log('• running a real Cloud starter with NO API key — expecting the env gate')
  const cloudProj = join(work, 'oma-e2e-demo-cloud')
  const dev = spawnSync('npm', ['run', 'dev'], { cwd: cloudProj, env, encoding: 'utf8' })
  const devOutput = `${dev.stdout ?? ''}${dev.stderr ?? ''}`
  if (dev.status === 0 || !/Missing OPENAI_API_KEY/.test(devOutput)) {
    throw new Error(`expected a non-zero real run with "Missing OPENAI_API_KEY"; got exit ${dev.status}.\n${devOutput}`)
  }

  console.log('• installing an Ollama scaffold and expecting the local-service gate')
  const ollamaProj = join(work, 'oma-e2e-demo-ollama')
  run('npm', ['install', '--no-audit', '--no-fund', coreTarball], { cwd: ollamaProj })
  const localEnv = { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:1' }
  delete localEnv.OMA_MODEL
  const local = spawnSync('npm', ['run', 'dev'], { cwd: ollamaProj, env: localEnv, encoding: 'utf8' })
  const localOutput = `${local.stdout ?? ''}${local.stderr ?? ''}`
  if (local.status === 0 || !/Ollama is unavailable/.test(localOutput)) {
    throw new Error(`expected the Ollama availability gate; got exit ${local.status}.\n${localOutput}`)
  }

  console.log('\n✓ create-oma-app packs every starter, runs no-key demos, and preserves Cloud + Ollama gates')
} finally {
  if (work) rmSync(work, { recursive: true, force: true })
}
