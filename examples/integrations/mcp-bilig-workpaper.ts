/**
 * MCP Bilig WorkPaper Tools
 *
 * Connect Bilig's file-backed WorkPaper MCP server over stdio, register its
 * tools with open-multi-agent, and run a no-key proof of spreadsheet formula
 * readback and JSON persistence.
 *
 * Run:
 *   npx tsx examples/integrations/mcp-bilig-workpaper.ts
 *
 * Prerequisites:
 *   - @modelcontextprotocol/sdk installed
 *   - npm can execute @bilig/workpaper from the public registry
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolExecutor, ToolRegistry } from '../../src/index.js'
import type { ToolResult, ToolUseContext } from '../../src/index.js'
import { connectMCPTools } from '../../src/mcp.js'

type JsonRecord = Record<string, unknown>

const biligPackage = process.env.BILIG_WORKPAPER_PACKAGE ?? '@bilig/workpaper@latest'
const workDir = await mkdtemp(join(tmpdir(), 'oma-bilig-workpaper-'))
const workpaperPath = join(workDir, 'pricing.workpaper.json')

const context: ToolUseContext = {
  agent: {
    name: 'bilig-workpaper-proof',
    role: 'integration-example',
    model: 'direct-tool-execution',
  },
  cwd: workDir,
}

const { tools, disconnect } = await connectMCPTools({
  command: 'npm',
  args: [
    'exec',
    '--yes',
    '--package',
    biligPackage,
    '--',
    'bilig-workpaper-mcp',
    '--workpaper',
    workpaperPath,
    '--init-demo-workpaper',
    '--writable',
  ],
  namePrefix: 'bilig',
  requestTimeoutMs: 60_000,
})

const registry = new ToolRegistry()
for (const tool of tools) registry.register(tool)
const executor = new ToolExecutor(registry)
let initialDisconnected = false

try {
  const expectedTools = [
    'list_sheets',
    'read_range',
    'read_cell',
    'set_cell_contents',
    'get_cell_display_value',
    'export_workpaper_document',
    'validate_formula',
  ]
  const registered = tools.map((tool) => tool.name).sort()

  for (const tool of expectedTools) {
    const name = `bilig_${tool}`
    if (!registry.has(name)) {
      throw new Error(`Expected MCP tool ${name}; got ${registered.join(', ')}`)
    }
  }

  const sheets = await executeJson('bilig_list_sheets', {})
  const before = await executeJson('bilig_read_cell', {
    sheetName: 'Summary',
    address: 'B3',
  })
  const validation = await executeJson('bilig_validate_formula', {
    formula: '=SUM(1,2)',
  })
  const write = await executeJson('bilig_set_cell_contents', {
    sheetName: 'Inputs',
    address: 'B3',
    value: 0.4,
  })
  const after = await executeJson('bilig_read_cell', {
    sheetName: 'Summary',
    address: 'B3',
  })
  const display = await executeJson('bilig_get_cell_display_value', {
    sheetName: 'Summary',
    address: 'B3',
  })
  const exported = await executeJson('bilig_export_workpaper_document', {
    includeConfig: true,
  })

  const formulaOutputBefore = readCellNumber(before)
  const formulaOutputAfter = readCellNumber(after)

  assertEqual(formulaOutputBefore, 60_000, 'baseline Summary!B3')
  assertEqual(formulaOutputAfter, 96_000, 'recalculated Summary!B3')
  assertEqual(readString(display, 'displayValue'), '96000', 'display value')
  assertEqual(readBoolean(validation, 'valid'), true, 'formula validation')
  assertEqual(readNestedBoolean(write, ['checks', 'persisted']), true, 'persisted write')
  assertEqual(readNestedBoolean(write, ['checks', 'restoredMatchesAfter']), true, 'restored readback')

  if (readNumber(exported, 'serializedBytes') <= 0) {
    throw new Error('Expected exported WorkPaper JSON bytes to be greater than zero')
  }

  await disconnectInitial()

  const restarted = await connectMCPTools({
    command: 'npm',
    args: [
      'exec',
      '--yes',
      '--package',
      biligPackage,
      '--',
      'bilig-workpaper-mcp',
      '--workpaper',
      workpaperPath,
    ],
    namePrefix: 'bilig',
    requestTimeoutMs: 60_000,
  })

  try {
    const readCell = restarted.tools.find((tool) => tool.name === 'bilig_read_cell')
    if (readCell === undefined) {
      throw new Error('Expected bilig_read_cell after reconnect')
    }
    const restored = parseJsonResult(
      await readCell.execute(
        {
          sheetName: 'Summary',
          address: 'B3',
        },
        context,
      ),
      'bilig_read_cell after reconnect',
    )

    assertEqual(readCellNumber(restored), 96_000, 'persisted Summary!B3')
  } finally {
    await restarted.disconnect()
  }

  console.log(JSON.stringify(
    {
      ok: true,
      package: biligPackage,
      workpaperPath,
      registeredTools: registered,
      sheetCount: Array.isArray(sheets.sheets) ? sheets.sheets.length : undefined,
      formulaOutputBefore,
      formulaOutputAfter,
      displayValue: display.displayValue,
      persisted: readNestedBoolean(write, ['checks', 'persisted']),
      exportedBytes: exported.serializedBytes,
    },
    null,
    2,
  ))
} finally {
  await disconnectInitial().catch(() => undefined)
}

async function disconnectInitial(): Promise<void> {
  if (initialDisconnected) {
    return
  }
  initialDisconnected = true
  await disconnect()
}

async function executeJson(toolName: string, input: JsonRecord): Promise<JsonRecord> {
  return parseJsonResult(
    await executor.execute(toolName, input, context),
    toolName,
  )
}

function parseJsonResult(result: ToolResult, label: string): JsonRecord {
  if (result.isError === true) {
    throw new Error(`${label} failed: ${result.data}`)
  }

  try {
    const parsed: unknown = JSON.parse(result.data)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonRecord
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} returned non-JSON output: ${detail}\n${result.data}`)
  }

  throw new Error(`${label} returned JSON that was not an object`)
}

function readNumber(record: JsonRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'number') {
    throw new Error(`Expected ${key} to be a number; got ${JSON.stringify(value)}`)
  }
  return value
}

function readCellNumber(record: JsonRecord): number {
  const value = record.value
  if (typeof value === 'number') {
    return value
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as JsonRecord).value === 'number'
  ) {
    return (value as JsonRecord).value as number
  }
  throw new Error(`Expected cell value to be numeric; got ${JSON.stringify(value)}`)
}

function readString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new Error(`Expected ${key} to be a string; got ${JSON.stringify(value)}`)
  }
  return value
}

function readBoolean(record: JsonRecord, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${key} to be a boolean; got ${JSON.stringify(value)}`)
  }
  return value
}

function readNestedBoolean(record: JsonRecord, path: string[]): boolean {
  let value: unknown = record
  for (const key of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Expected ${path.join('.')} to exist`)
    }
    value = (value as JsonRecord)[key]
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${path.join('.')} to be a boolean; got ${JSON.stringify(value)}`)
  }
  return value
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
  }
}
