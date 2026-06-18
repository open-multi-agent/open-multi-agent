/**
 * create-oma scaffold core — copy the bundled template into a target directory,
 * restore the shipped dotfiles, and stamp the project name. No console output,
 * no prompts: the CLI in index.ts handles interaction so this stays testable.
 */
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** template/ ships alongside dist/ (and src/) one level under the package root. */
export const TEMPLATE_DIR = fileURLToPath(new URL('../template', import.meta.url))

/** Turn an arbitrary project name into a valid npm package name. */
export function toPackageName(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-~]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'oma-demo'
  )
}

/** True when `dir` exists and contains at least one entry. */
export function isNonEmptyDir(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).length > 0
}

export interface ScaffoldOptions {
  readonly targetDir: string
  readonly projectName: string
  /** Override the template source (tests). Defaults to the bundled template. */
  readonly templateDir?: string
}

/** Copy the template into `targetDir`, restore dotfiles, stamp the name. */
export function scaffold({ targetDir, projectName, templateDir = TEMPLATE_DIR }: ScaffoldOptions): void {
  cpSync(templateDir, targetDir, { recursive: true })
  restoreDotfile(targetDir, '_gitignore', '.gitignore')
  restoreDotfile(targetDir, '_env.example', '.env.example')

  const pkgPath = join(targetDir, 'package.json')
  const stamped = readFileSync(pkgPath, 'utf8').replace(/__PROJECT_NAME__/g, toPackageName(projectName))
  writeFileSync(pkgPath, stamped)
}

/**
 * Restore a shipped dotfile. npm strips/renames real dotfiles (notably
 * `.gitignore`) on publish, so the template ships them as `_gitignore` /
 * `_env.example` and we rename them on scaffold.
 */
function restoreDotfile(dir: string, from: string, to: string): void {
  const fromPath = join(dir, from)
  if (existsSync(fromPath)) renameSync(fromPath, join(dir, to))
}
