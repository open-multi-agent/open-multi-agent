/**
 * create-oma-app scaffold core — copy the bundled template into a target directory,
 * restore the shipped dotfiles, and stamp the project name. No console output,
 * no prompts: the CLI in index.ts handles interaction so this stays testable.
 */
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderId, TemplateId } from './args.js'

/** Shared template base ships alongside dist/ (and src/) under the package root. */
export const TEMPLATE_DIR = fileURLToPath(new URL('../template', import.meta.url))
export const TEMPLATES_DIR = fileURLToPath(new URL('../templates', import.meta.url))

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
  readonly templateId?: TemplateId
  readonly providerId?: ProviderId
  /** Override the template source (tests). Defaults to the bundled template. */
  readonly templateDir?: string
  /** Override the template overlays root (tests). */
  readonly templatesDir?: string
}

/** Copy the shared base + selected overlay, restore dotfiles, and stamp metadata. */
export function scaffold({
  targetDir,
  projectName,
  templateId = 'demo',
  providerId = 'cloud',
  templateDir = TEMPLATE_DIR,
  templatesDir = TEMPLATES_DIR,
}: ScaffoldOptions): void {
  const overlay = join(templatesDir, templateId)
  if (!existsSync(overlay)) throw new Error(`Template "${templateId}" is not available.`)
  cpSync(templateDir, targetDir, { recursive: true })
  cpSync(overlay, targetDir, { recursive: true, force: true })

  restoreDotfile(targetDir, '_gitignore', '.gitignore')
  restoreDotfile(targetDir, '_env.example', '.env.example')
  restoreDotfile(targetDir, '_env.ollama', providerId === 'ollama' ? '.env' : '.env.ollama.example')

  const pkgPath = join(targetDir, 'package.json')
  const stamped = readFileSync(pkgPath, 'utf8')
    .replace(/__PROJECT_NAME__/g, toPackageName(projectName))
    .replace(/__OMA_RUNTIME__/g, providerId)
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
