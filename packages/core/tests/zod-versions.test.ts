import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { z as z3 } from 'zod/v3'
import { ToolRegistry, defineTool, zodToJsonSchema } from '../src/tool/framework.js'
import { ToolExecutor } from '../src/tool/executor.js'
import { validateOutput } from '../src/agent/structured-output.js'
import type { ToolUseContext, ZodSchema } from '../src/types.js'

// `zod` is Zod 4 in this workspace and `zod/v3` is the Zod 3 API it bundles.
// `npm run test:zod3` re-runs the suite with `zod` aliased to `zod/v3`, where
// both imports resolve to Zod 3.
type AnyZ = typeof z | typeof z3
const rootIsZod4 = '_zod' in z.string()

const context: ToolUseContext = {
  agent: { name: 'test-agent', role: 'tester', model: 'test-model' },
}

const parityCases: Array<[string, (zz: AnyZ) => ZodSchema]> = [
  ['primitives', (zz) => zz.object({
    s: zz.string(),
    n: zz.number().int(),
    b: zz.boolean(),
    big: zz.bigint(),
    d: zz.date(),
    nul: zz.null(),
  })],
  ['literal and enum', (zz) => zz.object({ kind: zz.literal('a'), mode: zz.enum(['r', 'w']) })],
  ['arrays and tuples', (zz) => zz.object({
    tags: zz.array(zz.string()),
    pair: zz.tuple([zz.string(), zz.number()]),
  })],
  ['optional, default, nullable', (zz) => zz.object({
    path: zz.string(),
    limit: zz.number().optional(),
    mode: zz.string().default('r'),
    note: zz.string().nullable(),
    either: zz.union([zz.string(), zz.number()]).nullable(),
  })],
  ['record, union, discriminated union, intersection', (zz) => zz.object({
    counts: zz.record(zz.string(), zz.number()),
    value: zz.union([zz.string(), zz.number()]),
    shape: zz.discriminatedUnion('kind', [
      zz.object({ kind: zz.literal('circle'), r: zz.number() }),
      zz.object({ kind: zz.literal('square'), side: zz.number() }),
    ]),
    both: zz.intersection(zz.object({ a: zz.string() }), zz.object({ b: zz.string() })),
  })],
  ['effects and wrappers', (zz) => zz.object({
    refined: zz.string().refine((v) => v.length > 0),
    transformed: zz.string().transform((v) => v.length),
    preprocessed: zz.preprocess((v) => String(v), zz.string()),
    piped: zz.string().pipe(zz.string()),
    branded: zz.string().brand<'Id'>(),
    caught: zz.number().catch(0),
    frozen: zz.object({ x: zz.number() }).readonly(),
  })],
  ['descriptions', (zz) => zz.object({
    path: zz.string().describe('File path'),
    limit: zz.number().optional().describe('Line limit'),
    inner: zz.string().describe('Inner').optional(),
  }).describe('Read a file')],
  ['wildcards', (zz) => zz.array(zz.union([zz.never(), zz.void()]))],
]

enum NumericEnum { Low = 1, High = 2 }
enum StringEnum { Low = 'low', High = 'high' }
enum MixedEnum { Low = 'low', High = 2 }

// A numeric member also compiles to a reverse mapping (`NumericEnum[1] === 'Low'`)
// that Zod rejects. Each case: the enum, then its Zod 3 `nativeEnum()` and Zod 4
// `enum()` conversions.
const nativeEnumCases = [
  ['numeric', NumericEnum, { enum: [1, 2] }, { enum: [1, 2] }],
  ['string', StringEnum, { enum: ['low', 'high'] }, { type: 'string', enum: ['low', 'high'] }],
  ['mixed', MixedEnum, { enum: ['low', 2] }, { enum: ['low', 2] }],
] as const

describe('zodToJsonSchema across Zod majors', () => {
  it.each(parityCases)('converts %s identically', (_name, build) => {
    expect(zodToJsonSchema(build(z))).toEqual(zodToJsonSchema(build(z3)))
  })

  it('converts a representative Zod 4 schema', () => {
    const schema = z.object({
      path: z.string().describe('File path'),
      limit: z.number().optional(),
      mode: z.enum(['r', 'w']).default('r'),
      tags: z.array(z.string()),
    })
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        limit: { type: 'number' },
        mode: { type: 'string', enum: ['r', 'w'], default: 'r' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['path', 'tags'],
    })
  })

  it('marks a key required exactly when Zod rejects the object without it', () => {
    const children: Record<string, ZodSchema> = {
      string: z.string(),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
      nullish: z.string().nullish(),
      default: z.string().default('d'),
      catch: z.string().catch('c'),
      any: z.any(),
      unknown: z.unknown(),
      undefined: z.undefined(),
      unionWithUndefined: z.union([z.string(), z.undefined()]),
      optionalTransform: z.string().optional().transform((v) => v),
    }
    for (const [name, child] of Object.entries(children)) {
      const objectSchema = z.object({ key: child })
      const required = (zodToJsonSchema(objectSchema).required as string[] | undefined) ?? []
      expect({ name, required: required.includes('key') })
        .toEqual({ name, required: !objectSchema.safeParse({}).success })
    }
  })

  it.each([['Zod 4', z], ['Zod 3', z3]] as const)('keeps null valid for a nullable enum with %s', (_name, zz) => {
    const schema = zz.object({ mode: zz.enum(['r', 'w']).nullable(), note: zz.string().nullable() })
    expect(schema.safeParse({ mode: null, note: null }).success).toBe(true)
    expect(zodToJsonSchema(schema).properties).toEqual({
      // `type: [..., 'null']` beside `enum` would reject null, so the enum is wrapped.
      mode: { anyOf: [{ type: 'string', enum: ['r', 'w'] }, { type: 'null' }] },
      note: { type: ['string', 'null'] },
    })
  })

  it.each(nativeEnumCases)('lists only the values Zod accepts for a %s TypeScript enum', (_name, nativeEnum, zod3Json, zod4Json) => {
    const conversions: Array<[ZodSchema, object]> = [[z3.nativeEnum(nativeEnum), zod3Json]]
    if (rootIsZod4) conversions.push([z.enum(nativeEnum), zod4Json])
    const candidates = [...new Set([...Object.keys(nativeEnum), ...Object.values(nativeEnum)])]
    for (const [schema, expected] of conversions) {
      const json = zodToJsonSchema(schema)
      expect(json).toEqual(expected)
      expect(new Set(json.enum as unknown[]))
        .toEqual(new Set(candidates.filter((v) => schema.safeParse(v).success)))
    }
  })

  it.skipIf(!rootIsZod4)('converts Zod 4 multi-value literals and enum objects', () => {
    expect(zodToJsonSchema(z.literal(['a', 'b']))).toEqual({ enum: ['a', 'b'] })
    expect(zodToJsonSchema(z.enum({ Low: 1, High: 2 }))).toEqual({ enum: [1, 2] })
    expect(zodToJsonSchema(z.enum({ Low: 'low', High: 'high' }))).toEqual({ type: 'string', enum: ['low', 'high'] })
  })
})

describe('validation with either Zod major', () => {
  it.each([['Zod 4', z], ['Zod 3', z3]] as const)('runs %s tool schemas through ToolExecutor', async (_name, zz) => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'read',
      description: 'Reads a file.',
      inputSchema: zz.object({ path: zz.string() }),
      outputSchema: zz.string().regex(/^\d+$/),
      execute: async (input) => ({ data: String(input.path.length) }),
    }))
    const executor = new ToolExecutor(registry)

    const ok = await executor.execute('read', { path: 'a.txt' }, context)
    const bad = await executor.execute('read', { path: 42 }, context)

    expect(ok.isError).toBeFalsy()
    expect(ok.data).toBe('5')
    expect(bad.isError).toBe(true)
    expect(String(bad.data)).toMatch(/^Invalid input for tool "read":\n  • path: \S/)
    expect(registry.toToolDefs()[0]!.inputSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
  })

  it.each([['Zod 4', z], ['Zod 3', z3]] as const)('validates %s structured output', (_name, zz) => {
    const schema = zz.object({ answer: zz.string().transform((v) => v.toUpperCase()) })
    expect(validateOutput(schema, { answer: 'yes' })).toEqual({ answer: 'YES' })
    expect(() => validateOutput(schema, { answer: 1 })).toThrow(/^Output validation failed:\n  - answer: \S/)
  })
})

describe('public types across Zod majors', () => {
  it('infer tool types from Zod 3 and Zod 4 schemas and reject zod/mini', () => {
    const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
    expect(loaded.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(
      loaded.config,
      ts.sys,
      fileURLToPath(new URL('..', import.meta.url)),
      { noEmit: true, rootDir: '.' },
      configPath,
    )
    const fixture = fileURLToPath(new URL('./fixtures/zod-versions.ts', import.meta.url))
    const program = ts.createProgram([fixture], parsed.options)
    const formatted = ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    })
    expect(formatted).toBe('')
  })
})
