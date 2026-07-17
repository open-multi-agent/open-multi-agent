import { describe, expect, it } from 'vitest'
import { layoutWaterfall } from '../src/dashboard/layout-waterfall.js'
import type { RunViewerSpan } from '../src/dashboard/run-viewer-model.js'

function span(
  key: string,
  options: Partial<RunViewerSpan> = {},
): RunViewerSpan {
  const [traceId, spanId] = key.split(':') as [string, string]
  return {
    key,
    traceId,
    spanId,
    attempt: 1,
    kind: 'agent',
    name: spanId,
    status: 'ok',
    incomplete: false,
    startUnixMs: 1_000,
    endUnixMs: 1_100,
    durationMs: 100,
    facts: [],
    events: [],
    links: [],
    ...options,
  }
}

describe('layoutWaterfall', () => {
  it('builds parent-child rows and proportional geometry in stable order', () => {
    const root = span('t:r', { kind: 'run', name: 'root', startUnixMs: 1_000, endUnixMs: 2_000, durationMs: 1_000 })
    const left = span('t:a', { parentKey: root.key, startUnixMs: 1_100, endUnixMs: 1_300, durationMs: 200 })
    const right = span('t:b', { parentKey: root.key, startUnixMs: 1_400, endUnixMs: 1_900, durationMs: 500 })
    const layout = layoutWaterfall([right, root, left])
    expect(layout.attempts[0]?.rows.map((row) => [row.key, row.depth])).toEqual([
      ['t:r', 0], ['t:a', 1], ['t:b', 1],
    ])
    expect(layout.attempts[0]?.rows[1]).toMatchObject({ offsetPercent: 10, widthPercent: 20 })
    expect(layout.attempts[0]?.rows[2]).toMatchObject({ offsetPercent: 40, widthPercent: 50 })
  })

  it('groups attempts and gives zero-duration spans a visible minimum width', () => {
    const layout = layoutWaterfall([
      span('a:one', { attempt: 2, startUnixMs: 2_000, endUnixMs: 2_000, durationMs: 0 }),
      span('b:one', { attempt: 1, startUnixMs: 1_000, endUnixMs: 1_100, durationMs: 100 }),
    ])
    expect(layout.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2])
    expect(layout.attempts[1]?.rows[0]?.widthPercent).toBe(0.35)
  })

  it('marks missing parents and breaks cycles deterministically', () => {
    const orphan = span('t:orphan', { parentKey: 't:missing' })
    const first = span('t:a', { parentKey: 't:b' })
    const second = span('t:b', { parentKey: 't:a' })
    const layout = layoutWaterfall([second, orphan, first])
    const rows = layout.attempts[0]!.rows
    expect(rows.find((row) => row.key === orphan.key)?.hierarchyIssue).toBe('unparented')
    expect(rows.some((row) => row.hierarchyIssue === 'cycle')).toBe(true)
    expect(layout.issueCount).toBe(2)
    expect(new Set(rows.map((row) => row.key))).toEqual(new Set(['t:orphan', 't:a', 't:b']))
  })

  it('leaves missing timing explicit instead of fabricating geometry', () => {
    const unknown = span('t:unknown', {
      startUnixMs: undefined,
      endUnixMs: undefined,
      durationMs: undefined,
    })
    expect(layoutWaterfall([unknown]).attempts[0]?.rows[0]).toMatchObject({ timingKnown: false })
    expect(layoutWaterfall([unknown]).attempts[0]?.rows[0]).not.toHaveProperty('offsetPercent')
  })

  it('keeps start-only incomplete spans visible without inventing duration', () => {
    const incomplete = span('t:incomplete', {
      incomplete: true,
      status: 'in_progress',
      startUnixMs: 1_050,
      endUnixMs: undefined,
      durationMs: undefined,
    })
    const row = layoutWaterfall([
      span('t:root', { kind: 'run', startUnixMs: 1_000, endUnixMs: 1_200, durationMs: 200 }),
      incomplete,
    ]).attempts[0]!.rows.find((value) => value.key === incomplete.key)!
    expect(row).toMatchObject({ timingKnown: true, offsetPercent: 25 })
    expect(row).not.toHaveProperty('widthPercent')
  })
})
