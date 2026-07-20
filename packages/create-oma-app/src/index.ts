#!/usr/bin/env node
/**
 * create-oma-app — scaffold production multi-agent starters on @open-multi-agent/core.
 *
 * Usage:
 *   npm create oma-app@latest [project-name]
 *
 * One command from zero to a live production starter or teaching DAG. The copy logic
 * lives in scaffold.ts; this file is the interactive CLI. Zero runtime
 * dependencies — Node.js built-ins only, so `npm create oma-app` stays a fast,
 * clean one-shot whose own deps never reach the generated project or core.
 */
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs, type ProviderId, type TemplateId } from './args.js'
import { resolvePostScaffoldActions, runPostScaffold } from './post-scaffold.js'
import { isNonEmptyDir, scaffold } from './scaffold.js'

// Minimal ANSI styling — no dependency.
const ESC = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
}
const bold = (s: string): string => `${ESC.bold}${s}${ESC.reset}`
const dim = (s: string): string => `${ESC.dim}${s}${ESC.reset}`
const cyan = (s: string): string => `${ESC.cyan}${s}${ESC.reset}`
const green = (s: string): string => `${ESC.green}${s}${ESC.reset}`

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close()
      res(answer.trim())
    })
  })
}

function printHelp(): void {
  console.log(`
  create-oma-app — scaffold a production-ready multi-agent starter

  Usage:
    npm create oma-app@latest [project-name] -- [options]

  Options:
    -t, --template <id>   pr-review | security | demo
    -p, --provider <id>   cloud | ollama
        --no-install      scaffold only; skip dependency installation and demo
        --no-run          install dependencies but skip the demo
    -h, --help            show this help

  With no options, interactive terminals ask for a template and provider.
  Interactive terminals then install dependencies and run a no-key local demo.
  Non-interactive callers keep the legacy scaffold-only defaults: demo + cloud.
`)
}

function shellPath(path: string): string {
  return JSON.stringify(path)
}

function printManualSteps(projectName: string, providerId: ProviderId, includeInstall = true): void {
  console.log()
  console.log('  Next steps:')
  console.log()
  console.log(`    ${cyan(`cd ${shellPath(projectName)}`)}`)
  if (includeInstall) console.log(`    ${cyan('npm install --no-audit --no-fund')}`)
  console.log(`    ${cyan('npm run demo')}   ${dim('# deterministic; no API key or model call')}`)
  if (providerId === 'cloud') {
    console.log(`    ${cyan('cp .env.example .env')}   ${dim('# add your key for a real run')}`)
  }
  console.log(`    ${cyan('npm run dev')}    ${dim('# real Cloud/Ollama model')}`)
}

async function chooseTemplate(): Promise<TemplateId> {
  console.log('  Choose a template:')
  console.log(`    ${cyan('1')} PR Review Agent ${dim('(recommended)')}`)
  console.log(`    ${cyan('2')} Security Analysis Agent`)
  console.log(`    ${cyan('3')} Multi-agent DAG Demo`)
  const answer = await prompt(`  Template: ${dim('(1)')} `)
  if (!answer || answer === '1' || answer === 'pr-review') return 'pr-review'
  if (answer === '2' || answer === 'security') return 'security'
  if (answer === '3' || answer === 'demo') return 'demo'
  throw new Error('Choose 1, 2, or 3.')
}

async function chooseProvider(): Promise<ProviderId> {
  console.log()
  console.log('  Choose a runtime:')
  console.log(`    ${cyan('1')} Cloud / OpenAI-compatible ${dim('(recommended)')}`)
  console.log(`    ${cyan('2')} Local / Ollama`)
  const answer = await prompt(`  Runtime: ${dim('(1)')} `)
  if (!answer || answer === '1' || answer === 'cloud') return 'cloud'
  if (answer === '2' || answer === 'ollama') return 'ollama'
  throw new Error('Choose 1 or 2.')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  console.log()
  console.log(`  ${bold('create-oma-app')}${dim(' — scaffold a multi-agent starter')}`)
  console.log()

  // 1. Resolve the project directory name (argv, else one prompt).
  let projectName = options.projectName
  if (!projectName) projectName = await prompt(`  Project name: ${dim('(oma-demo)')} `)
  projectName = (projectName || 'oma-demo').trim()
  const dirName = basename(projectName)
  const targetDir = resolve(process.cwd(), projectName)

  // 2. Resolve template/provider. Preserve legacy defaults for CI/non-TTY use.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const templateId = options.templateId ?? (interactive ? await chooseTemplate() : 'demo')
  const providerId = options.providerId ?? (interactive ? await chooseProvider() : 'cloud')

  // 3. Refuse to overwrite a non-empty directory without confirmation.
  if (isNonEmptyDir(targetDir)) {
    console.log()
    console.log(`  ${ESC.yellow}!${ESC.reset} ${bold(dirName)} already exists and is not empty.`)
    const answer = (await prompt(`  Write into it anyway? ${dim('(y/N)')} `)).toLowerCase()
    if (answer !== 'y' && answer !== 'yes') {
      console.log(`  ${ESC.red}✗${ESC.reset} Aborted.`)
      process.exitCode = 1
      return
    }
  }

  // 4. Scaffold. Use the basename for the package name so a path-y project
  //    name (e.g. ./apps/my-demo) still yields a clean npm name.
  scaffold({ targetDir, projectName: dirName, templateId, providerId })

  // 5. Next steps.
  console.log()
  console.log(`  ${green('✓')} Created ${bold(dirName)} ${dim(`(${templateId}, ${providerId})`)}`)

  const actions = resolvePostScaffoldActions({
    interactive,
    noInstall: options.noInstall,
    noRun: options.noRun,
  })

  if (!actions.install) {
    printManualSteps(projectName, providerId)
    console.log()
    return
  }

  console.log()
  console.log(dim('  Installing dependencies…'))
  if (actions.runDemo) console.log(dim('  A deterministic no-key demo will run after installation.'))
  console.log()

  const post = runPostScaffold(targetDir, actions)
  if (!post.ok) {
    console.log()
    console.error(`  ${ESC.red}✗${ESC.reset} ${post.failedStep === 'install' ? 'Dependency installation' : 'Demo run'} failed.`)
    if (post.error) console.error(dim(`  ${post.error.message}`))
    console.error(dim('  The generated project was kept; resume with:'))
    printManualSteps(projectName, providerId, post.failedStep === 'install')
    process.exitCode = 1
    return
  }

  console.log()
  console.log(`  ${green('✓')} ${actions.runDemo ? 'No-key demo complete.' : 'Dependencies installed.'}`)
  console.log(dim('  npm run demo uses scripted model responses; OMA orchestration runs locally for real.'))
  if (providerId === 'cloud') {
    console.log(dim(`  For a real model run: cd ${shellPath(projectName)}, copy .env.example to .env, then npm run dev.`))
  } else {
    console.log(dim(`  For a real Ollama run: start Ollama, then cd ${shellPath(projectName)} and run npm run dev.`))
  }
  console.log()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
