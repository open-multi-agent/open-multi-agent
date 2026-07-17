/** Backward-compatible wrapper over the unified OMA Run Viewer. */

import type { TeamRunResult } from '../types.js'
import { renderRunViewer } from './render-run-viewer.js'

export { escapeJsonForHtmlScript } from './render-run-viewer.js'

export function renderTeamRunDashboard(result: TeamRunResult): string {
  return renderRunViewer({ result })
}
