#!/usr/bin/env node
/**
 * create-oma-app — scaffold a runnable multi-agent demo on @open-multi-agent/core.
 *
 * Usage:
 *   npm create oma-app@latest [project-name]
 *
 * One command from zero to a live coordinator-driven agent DAG. The copy logic
 * lives in scaffold.ts; this file is the interactive CLI. Zero runtime
 * dependencies — Node.js built-ins only, so `npm create oma-app` stays a fast,
 * clean one-shot whose own deps never reach the generated project or core.
 */
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline'
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

async function main(): Promise<void> {
  console.log()
  console.log(`  ${bold('create-oma-app')}${dim(' — scaffold a multi-agent demo')}`)
  console.log()

  // 1. Resolve the project directory name (argv, else one prompt).
  let projectName = process.argv[2]
  if (!projectName) projectName = await prompt(`  Project name: ${dim('(oma-demo)')} `)
  projectName = (projectName || 'oma-demo').trim()
  const dirName = basename(projectName)
  const targetDir = resolve(process.cwd(), projectName)

  // 2. Refuse to overwrite a non-empty directory without confirmation.
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

  // 3. Scaffold. Use the basename for the package name so a path-y project
  //    name (e.g. ./apps/my-demo) still yields a clean npm name.
  scaffold({ targetDir, projectName: dirName })

  // 4. Next steps.
  console.log()
  console.log(`  ${green('✓')} Created ${bold(dirName)}`)
  console.log()
  console.log('  Next steps:')
  console.log()
  console.log(`    ${cyan(`cd ${projectName}`)}`)
  console.log(`    ${cyan('npm install')}`)
  console.log(`    ${cyan('cp .env.example .env')}   ${dim('# then add your API key')}`)
  console.log(`    ${cyan('npm run dev')}`)
  console.log()
  console.log(dim('  One goal becomes a multi-agent DAG, then a dashboard of the run'))
  console.log(dim('  opens in your browser. OpenAI or any OpenAI-compatible endpoint'))
  console.log(dim('  (DeepSeek, Groq, Ollama, …) — see .env.example.'))
  console.log()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
