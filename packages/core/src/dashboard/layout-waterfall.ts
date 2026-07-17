import type { RunViewerSpan } from './run-viewer-model.js'

export type WaterfallHierarchyIssue = 'unparented' | 'cycle'

export interface WaterfallRow {
  readonly key: string
  readonly attempt: number
  readonly depth: number
  readonly parentKey?: string
  readonly hasChildren: boolean
  readonly offsetPercent?: number
  readonly widthPercent?: number
  readonly timingKnown: boolean
  readonly hierarchyIssue?: WaterfallHierarchyIssue
}

export interface WaterfallAttemptLayout {
  readonly attempt: number
  readonly startUnixMs?: number
  readonly endUnixMs?: number
  readonly durationMs?: number
  readonly rows: readonly WaterfallRow[]
}

export interface WaterfallLayout {
  readonly attempts: readonly WaterfallAttemptLayout[]
  readonly issueCount: number
}

interface MutableNode {
  readonly span: RunViewerSpan
  parentKey?: string
  issue?: WaterfallHierarchyIssue
}

function compareSpans(a: RunViewerSpan, b: RunViewerSpan): number {
  return (a.startUnixMs ?? Number.MAX_SAFE_INTEGER) - (b.startUnixMs ?? Number.MAX_SAFE_INTEGER)
    || a.key.localeCompare(b.key)
}

function breakCycles(nodes: Map<string, MutableNode>): void {
  for (const node of [...nodes.values()].sort((a, b) => a.span.key.localeCompare(b.span.key))) {
    const seen = new Set<string>([node.span.key])
    let current = node
    while (current.parentKey) {
      if (seen.has(current.parentKey)) {
        node.parentKey = undefined
        node.issue = 'cycle'
        break
      }
      seen.add(current.parentKey)
      const parent = nodes.get(current.parentKey)
      if (!parent) break
      current = parent
    }
  }
}

function attemptLayout(attempt: number, input: readonly RunViewerSpan[]): WaterfallAttemptLayout {
  const spans = [...input].sort(compareSpans)
  const nodes = new Map<string, MutableNode>(spans.map((span) => [span.key, {
    span,
    ...(span.parentKey ? { parentKey: span.parentKey } : {}),
  }]))
  for (const node of nodes.values()) {
    if (node.parentKey && !nodes.has(node.parentKey)) {
      node.parentKey = undefined
      node.issue = 'unparented'
    }
  }
  breakCycles(nodes)

  const children = new Map<string, MutableNode[]>()
  const roots: MutableNode[] = []
  for (const node of nodes.values()) {
    if (node.parentKey) {
      const list = children.get(node.parentKey) ?? []
      list.push(node)
      children.set(node.parentKey, list)
    } else {
      roots.push(node)
    }
  }
  roots.sort((a, b) => compareSpans(a.span, b.span))
  for (const list of children.values()) list.sort((a, b) => compareSpans(a.span, b.span))

  const knownStarts = spans.flatMap((span) => span.startUnixMs === undefined ? [] : [span.startUnixMs])
  const knownEnds = spans.flatMap((span) => {
    if (span.endUnixMs !== undefined) return [span.endUnixMs]
    if (span.startUnixMs !== undefined && span.durationMs !== undefined) return [span.startUnixMs + span.durationMs]
    return []
  })
  const startUnixMs = knownStarts.length > 0 ? Math.min(...knownStarts) : undefined
  const endUnixMs = knownEnds.length > 0 ? Math.max(...knownEnds) : startUnixMs
  const durationMs = startUnixMs !== undefined && endUnixMs !== undefined
    ? Math.max(0, endUnixMs - startUnixMs)
    : undefined
  const scaleDuration = Math.max(1, durationMs ?? 1)

  const rows: WaterfallRow[] = []
  const visit = (node: MutableNode, depth: number): void => {
    const { span } = node
    const timingKnown = span.startUnixMs !== undefined
    const offsetPercent = timingKnown && startUnixMs !== undefined
      ? Math.max(0, Math.min(100, ((span.startUnixMs! - startUnixMs) / scaleDuration) * 100))
      : undefined
    const actualDuration = span.durationMs
      ?? (span.startUnixMs !== undefined && span.endUnixMs !== undefined
        ? Math.max(0, span.endUnixMs - span.startUnixMs)
        : undefined)
    const widthPercent = timingKnown && actualDuration !== undefined
      ? Math.max(0.35, Math.min(100 - (offsetPercent ?? 0), (actualDuration / scaleDuration) * 100))
      : undefined
    const childRows = children.get(span.key) ?? []
    rows.push({
      key: span.key,
      attempt,
      depth,
      ...(node.parentKey ? { parentKey: node.parentKey } : {}),
      hasChildren: childRows.length > 0,
      ...(offsetPercent !== undefined ? { offsetPercent } : {}),
      ...(widthPercent !== undefined ? { widthPercent } : {}),
      timingKnown,
      ...(node.issue ? { hierarchyIssue: node.issue } : {}),
    })
    for (const child of childRows) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  return {
    attempt,
    ...(startUnixMs !== undefined ? { startUnixMs } : {}),
    ...(endUnixMs !== undefined ? { endUnixMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    rows,
  }
}

export function layoutWaterfall(spans: readonly RunViewerSpan[]): WaterfallLayout {
  const byAttempt = new Map<number, RunViewerSpan[]>()
  for (const span of spans) {
    const list = byAttempt.get(span.attempt) ?? []
    list.push(span)
    byAttempt.set(span.attempt, list)
  }
  const attempts = [...byAttempt]
    .sort(([a], [b]) => a - b)
    .map(([attempt, attemptSpans]) => attemptLayout(attempt, attemptSpans))
  return {
    attempts,
    issueCount: attempts.reduce((count, attempt) =>
      count + attempt.rows.filter((row) => row.hierarchyIssue !== undefined).length, 0),
  }
}
