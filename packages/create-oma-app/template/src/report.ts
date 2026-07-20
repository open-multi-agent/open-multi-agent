import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderTeamRunDashboard } from '@open-multi-agent/core'
import type { TeamRunResult } from '@open-multi-agent/core'

export type ReportMode = 'demo' | 'live'

export interface ReportPaths {
  readonly markdown: string
  readonly json: string
  readonly dashboard: string
}

export function writeReports(
  kind: string,
  structured: unknown,
  markdown: string,
  run: TeamRunResult,
  mode: ReportMode,
): ReportPaths {
  const dir = resolve('reports')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const prefix = join(dir, `${kind}-${stamp}`)
  const paths = {
    markdown: `${prefix}.md`,
    json: `${prefix}.json`,
    dashboard: `${prefix}.html`,
  }
  const notice = mode === 'demo'
    ? '> **Demo mode:** Simulated model responses; no model API was called. OMA orchestration and report generation ran locally.\n\n'
    : ''
  const payload = typeof structured === 'object' && structured !== null
    ? { ...structured, metadata: { mode } }
    : { result: structured, metadata: { mode } }
  writeFileSync(paths.markdown, `${notice}${markdown.trim()}\n`)
  writeFileSync(paths.json, `${JSON.stringify(payload, null, 2)}\n`)
  writeFileSync(paths.dashboard, decorateDashboard(renderTeamRunDashboard(run), mode))
  return paths
}

export function writeDashboard(path: string, run: TeamRunResult, mode: ReportMode): string {
  const target = resolve(path)
  writeFileSync(target, decorateDashboard(renderTeamRunDashboard(run), mode))
  return target
}

export function openDashboard(path: string): void {
  const target = resolve(path)
  if (!process.stdout.isTTY || process.env.CI) {
    console.log(`Open the dashboard: ${target}`)
    return
  }

  try {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]
    const result = spawnSync(command, args, { stdio: 'ignore' })
    if (result.error || result.status !== 0) console.log(`Open the dashboard: ${target}`)
  } catch {
    console.log(`Open the dashboard: ${target}`)
  }
}

function decorateDashboard(html: string, mode: ReportMode): string {
  if (mode !== 'demo') return html
  const title = 'OMA Demo — Simulated model responses'
  const banner = '<div role="status" style="position:relative;z-index:9999;padding:10px 16px;background:#5b3b00;color:#fff4cc;font:600 14px/1.4 system-ui;text-align:center">Demo mode — simulated model responses; no model API was called.</div>'
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(/<body([^>]*)>/i, `<body$1>${banner}`)
}
