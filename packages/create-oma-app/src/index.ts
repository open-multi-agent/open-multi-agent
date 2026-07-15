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
    -h, --help            show this help

  With no options, interactive terminals ask for a template and provider.
  Non-interactive callers keep the legacy defaults: demo + cloud.
`)
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
  console.log()
  console.log('  Next steps:')
  console.log()
  console.log(`    ${cyan(`cd ${projectName}`)}`)
  console.log(`    ${cyan('npm install')}`)
  if (providerId === 'cloud') {
    console.log(`    ${cyan('cp .env.example .env')}   ${dim('# then add your API key')}`)
  }
  console.log(`    ${cyan('npm run dev')}`)
  console.log()
  console.log(dim(`  ${templateId} is ready. Run npm run demo for the bundled five-minute fixture.`))
  console.log()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
