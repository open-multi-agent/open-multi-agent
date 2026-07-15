import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderTeamRunDashboard } from '@open-multi-agent/core'
import type { TeamRunResult } from '@open-multi-agent/core'

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
  writeFileSync(paths.markdown, `${markdown.trim()}\n`)
  writeFileSync(paths.json, `${JSON.stringify(structured, null, 2)}\n`)
  writeFileSync(paths.dashboard, renderTeamRunDashboard(run))
  return paths
}
