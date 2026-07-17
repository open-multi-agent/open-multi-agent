import { describe, expect, it } from 'vitest'
import { renderRunViewer } from '../src/dashboard/render-run-viewer.js'
import type { MaterializedSpan, StoredRun } from '../src/observability/store.js'

function runWithSpans(spans: MaterializedSpan[]): StoredRun {
  return {
    schemaVersion: 2,
    runId: 'large-run',
    attempts: [{
      attempt: 1,
      traceId: '1'.repeat(32),
      startedAt: new Date(1_000).toISOString(),
      endedAt: new Date(3_000).toISOString(),
      durationMs: 2_000,
      status: 'ok',
      incomplete: false,
    }],
    startedAt: new Date(1_000).toISOString(),
    endedAt: new Date(3_000).toISOString(),
    durationMs: 2_000,
    status: 'ok',
    agents: [],
    taskIds: [],
    models: [],
    providers: [],
    tokens: { input_tokens: 0, output_tokens: 0 },
    costs: [],
    incomplete: false,
    spans,
  }
}

function embeddedPayload(html: string): { spans: unknown[] } {
  const marker = 'id="oma-data">'
  const start = html.indexOf(marker) + marker.length
  return JSON.parse(html.slice(start, html.indexOf('</script>', start))) as { spans: unknown[] }
}

describe('renderRunViewer large and hostile fixtures', () => {
  it('serializes 2,000 spans and keeps batched rendering in the browser shell', () => {
    const traceId = '1'.repeat(32)
    const spans = Array.from({ length: 2_000 }, (_, index): MaterializedSpan => ({
      traceId,
      spanId: index.toString(16).padStart(16, '0'),
      kind: index % 2 ? 'llm' : 'tool',
      name: `operation-${index}`,
      startUnixMs: 1_000 + index,
      endUnixMs: 1_001 + index,
      durationMs: 1,
      status: 'ok',
      attributes: {},
      links: [],
      events: [],
      incomplete: false,
    }))
    const html = renderRunViewer({ run: runWithSpans(spans) })
    expect(embeddedPayload(html).spans).toHaveLength(2_000)
    expect(html).toContain('waterfallLimit: 500')
    expect(html).toContain('Load \' + Math.min(500')
  })

  it('keeps Unicode, SVG, script terminators, and long titles inside escaped data only', () => {
    const hostile = `分析🧪<svg onload=alert(1)></script>${'長'.repeat(4_000)}`
    const html = renderRunViewer({ result: {
      success: true,
      tasks: [{ id: 'hostile', title: hostile, status: 'pending', dependsOn: [] }],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    } })
    const payload = embeddedPayload(html) as { spans: unknown[]; tasks?: Array<{ title: string }> }
    expect(payload.tasks?.[0]?.title).toBe(hostile)
    expect(html.slice(0, html.indexOf('id="oma-data">'))).not.toContain('<svg onload')
    expect(html.match(/<script/gi)).toHaveLength(2)
    expect(html.toLowerCase().match(/<\/script>/g)).toHaveLength(2)
  })
})
