import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  loadEvalReport,
  loadEvalSet,
  loadGatePolicy,
  writeEvalReport,
} from '../src/eval/file.js'
import type { EvalRunReport } from '../src/eval/report.js'

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'oma-eval-file-'))
}

function reportFixture(): EvalRunReport {
  return {
    schemaVersion: 1,
    evalRunId: 'eval-run-1',
    startedAtUnixMs: Date.UTC(2026, 6, 18),
    durationMs: 2_500,
    evalSet: { name: 'set<&"\'', version: '1.0.0' },
    metadata: { prompt_version: 'v2' },
    caseCount: 4,
    repeats: 1,
    records: [
      {
        schemaVersion: 1,
        recordId: 'record-1',
        evalRunId: 'eval-run-1',
        source: 'offline',
        timestampUnixMs: 1,
        evalSet: { name: 'set<&"\'', version: '1.0.0' },
        caseId: 'passing<&"\'',
        repeat: 1,
        scorer: { name: 'exact<&"\'' },
        status: 'scored',
        score: 1,
        metadata: {},
        usage: { durationMs: 100 },
      },
      {
        schemaVersion: 1,
        recordId: 'record-2',
        evalRunId: 'eval-run-1',
        source: 'offline',
        timestampUnixMs: 2,
        evalSet: { name: 'set<&"\'', version: '1.0.0' },
        caseId: 'failed',
        repeat: 1,
        scorer: { name: 'exact<&"\'' },
        status: 'scored',
        score: 0,
        pass: false,
        reason: 'mismatch <&"\'',
        metadata: {},
        usage: { durationMs: 200 },
      },
      {
        schemaVersion: 1,
        recordId: 'record-3',
        evalRunId: 'eval-run-1',
        source: 'offline',
        timestampUnixMs: 3,
        evalSet: { name: 'set<&"\'', version: '1.0.0' },
        caseId: 'scorer-error',
        repeat: 1,
        scorer: { name: 'exact<&"\'' },
        status: 'scorer_error',
        metadata: {},
        error: {
          kind: 'unknown',
          name: 'Error',
          message: 'judge <&"\' failed',
        },
      },
      {
        schemaVersion: 1,
        recordId: 'record-4',
        evalRunId: 'eval-run-1',
        source: 'offline',
        timestampUnixMs: 4,
        evalSet: { name: 'set<&"\'', version: '1.0.0' },
        caseId: 'target-error',
        repeat: 1,
        scorer: { name: '_target' },
        status: 'target_error',
        metadata: {},
        error: {
          kind: 'unknown',
          name: 'Error',
          message: 'target failed',
        },
      },
    ],
    aggregates: [
      {
        scorer: { name: 'exact<&"\'', version: '1' },
        scoredCount: 2,
        errorCount: 1,
        avg: 0.5,
        p50: 0,
        p95: 1,
        min: 0,
        max: 1,
        passRate: 0.5,
        byTag: {
          edge: {
            scorer: { name: 'exact<&"\'', version: '1' },
            scoredCount: 1,
            errorCount: 1,
            avg: 0,
            p50: 0,
            p95: 0,
            min: 0,
            max: 0,
            passRate: 0,
          },
        },
      },
    ],
    totals: {
      tokens: { input_tokens: 10, output_tokens: 5 },
      costs: [{ amount: 0.01, currency: 'USD' }],
      targetErrors: 1,
    },
  }
}

describe('loadEvalSet', () => {
  it('loads a valid file through defineEvalSet and deeply freezes the result', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'set.json')
    await writeFile(path, JSON.stringify({
      name: 'fixture',
      version: '1',
      cases: [{ id: 'a', input: 'hello', tags: ['smoke'] }],
    }), 'utf8')

    const set = await loadEvalSet(path)

    expect(set.name).toBe('fixture')
    expect(Object.isFrozen(set)).toBe(true)
    expect(Object.isFrozen(set.cases)).toBe(true)
    expect(Object.isFrozen(set.cases[0])).toBe(true)
  })

  it('reports the path for invalid JSON', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'broken.json')
    await writeFile(path, '{', 'utf8')

    await expect(loadEvalSet(path)).rejects.toThrow(`Invalid EvalSet JSON in ${resolve(path)}`)
  })

  it('reports the path and first validation issue', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'invalid.json')
    await writeFile(path, JSON.stringify({ name: 'fixture', version: '', cases: [] }), 'utf8')

    await expect(loadEvalSet(path)).rejects.toThrow(`Invalid EvalSet in ${resolve(path)}: version:`)
  })

  it('reports duplicate case ids with the file path', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'duplicate.json')
    await writeFile(path, JSON.stringify({
      name: 'fixture',
      version: '1',
      cases: [{ id: 'a', input: 1 }, { id: 'a', input: 2 }],
    }), 'utf8')

    await expect(loadEvalSet(path)).rejects.toThrow(
      `Invalid EvalSet in ${resolve(path)}: EvalSet case id "a" must be unique.`,
    )
  })
})

describe('loadGatePolicy', () => {
  it('loads, validates, and freezes a gate policy', async () => {
    const path = join(await temporaryDirectory(), 'gate.json')
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      thresholds: [{ scorer: 'exact', metric: 'passRate', min: 1 }],
      baseline: { maxRegression: 0.05 },
    }), 'utf8')

    const policy = await loadGatePolicy(path)

    expect(policy).toEqual({
      schemaVersion: 1,
      thresholds: [{ scorer: 'exact', metric: 'passRate', min: 1 }],
      baseline: { maxRegression: 0.05 },
    })
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.thresholds)).toBe(true)
  })

  it('rejects malformed JSON and reports schema issue paths', async () => {
    const directory = await temporaryDirectory()
    const broken = join(directory, 'broken-gate.json')
    const invalid = join(directory, 'invalid-gate.json')
    await writeFile(broken, '{', 'utf8')
    await writeFile(invalid, JSON.stringify({
      schemaVersion: 1,
      thresholds: [{ scorer: 'exact', metric: 'avg' }],
    }), 'utf8')

    await expect(loadGatePolicy(broken)).rejects.toThrow(
      `Invalid GatePolicy JSON in ${resolve(broken)}`,
    )
    await expect(loadGatePolicy(invalid)).rejects.toThrow(
      `Invalid GatePolicy in ${resolve(invalid)}: thresholds.0:`,
    )
  })
})

describe('loadEvalReport', () => {
  it('round-trips and freezes an authoritative report', async () => {
    const path = join(await temporaryDirectory(), 'report.json')
    const fixture = reportFixture()
    await writeFile(path, JSON.stringify(fixture), 'utf8')

    const loaded = await loadEvalReport(path)

    expect(loaded).toEqual(fixture)
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.records)).toBe(true)
  })

  it('rejects malformed JSON and unsupported schema versions', async () => {
    const directory = await temporaryDirectory()
    const broken = join(directory, 'broken-report.json')
    const invalid = join(directory, 'invalid-report.json')
    await writeFile(broken, '{', 'utf8')
    await writeFile(invalid, JSON.stringify({ ...reportFixture(), schemaVersion: 2 }), 'utf8')

    await expect(loadEvalReport(broken)).rejects.toThrow(
      `Invalid EvalRunReport JSON in ${resolve(broken)}`,
    )
    await expect(loadEvalReport(invalid)).rejects.toThrow(
      `Invalid EvalRunReport in ${resolve(invalid)}: schemaVersion:`,
    )
  })
})

describe('writeEvalReport', () => {
  it('writes authoritative JSON that round-trips without changes', async () => {
    const report = reportFixture()
    const path = join(await temporaryDirectory(), 'nested', 'report.json')

    await writeEvalReport(report, { format: 'json', path })

    const raw = await readFile(path, 'utf8')
    expect(raw).toBe(JSON.stringify(report, null, 2))
    expect(JSON.parse(raw)).toEqual(report)
  })

  it('writes Markdown aggregates, tag breakdowns, failure details, and totals', async () => {
    const path = join(await temporaryDirectory(), 'report.md')

    await writeEvalReport(reportFixture(), { format: 'markdown', path })

    const markdown = await readFile(path, 'utf8')
    expect(markdown).toContain('# Evaluation Report: set<&"\'@1.0.0')
    expect(markdown).toContain('## Scorer aggregates')
    expect(markdown).toContain('## Aggregates by tag')
    expect(markdown).toContain('## Failed samples')
    expect(markdown).toContain('mismatch <&"\'')
    expect(markdown).toContain('- Target errors: 1')
    expect(markdown).toContain('- Tokens: 10 input, 5 output')
  })

  it('truncates long failure reasons in human-readable output', async () => {
    const fixture = reportFixture()
    const longReason = 'x'.repeat(300)
    const report: EvalRunReport = {
      ...fixture,
      records: fixture.records.map((record) =>
        record.recordId === 'record-2' ? { ...record, reason: longReason } : record),
    }
    const path = join(await temporaryDirectory(), 'report.md')

    await writeEvalReport(report, { format: 'markdown', path })

    const markdown = await readFile(path, 'utf8')
    expect(markdown).toContain(`${'x'.repeat(199)}…`)
    expect(markdown).not.toContain(longReason)
  })

  it('writes conservative JUnit XML with escaped names, failures, errors, and counts', async () => {
    const path = join(await temporaryDirectory(), 'report.junit.xml')

    await writeEvalReport(reportFixture(), { format: 'junit', path })

    const xml = await readFile(path, 'utf8')
    expect(xml).toContain('name="set&lt;&amp;&quot;&apos;@1.0.0" tests="4" failures="1" errors="2" time="2.500"')
    expect(xml).toContain('name="passing&lt;&amp;&quot;&apos;#r1 · exact&lt;&amp;&quot;&apos;"')
    expect(xml).toContain('<failure message="mismatch &lt;&amp;&quot;&apos;">')
    expect(xml).toContain('<error message="judge &lt;&amp;&quot;&apos; failed">')
    expect(xml).toContain('<testcase')
  })
})
