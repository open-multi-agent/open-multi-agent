import { z } from 'zod'
import { defineTool } from './framework.js'
import type { ToolDefinition } from '../types.js'

interface MCPToolDescriptor {
  name: string
  description?: string
  /** MCP tool JSON Schema; same shape LLM APIs expect for object parameters. */
  inputSchema?: Record<string, unknown>
}

interface MCPListToolsResponse {
  tools?: MCPToolDescriptor[]
  nextCursor?: string
}

interface MCPCallToolResponse {
  content?: Array<Record<string, unknown>>
  structuredContent?: unknown
  isError?: boolean
  toolResult?: unknown
}

interface MCPClientLike {
  connect(transport: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<void>
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<MCPListToolsResponse>
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<MCPCallToolResponse>
  close?: () => Promise<void>
}

type MCPClientConstructor = new (
  info: { name: string; version: string },
  options: { capabilities: Record<string, unknown> },
) => MCPClientLike

type StdioTransportConstructor = new (config: {
  command: string
  args?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
}) => { close?: () => Promise<void> }

interface MCPModules {
  Client: MCPClientConstructor
  StdioClientTransport: StdioTransportConstructor
}

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000

async function loadMCPModules(): Promise<MCPModules> {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js') as Promise<{
      Client: MCPClientConstructor
    }>,
    import('@modelcontextprotocol/sdk/client/stdio.js') as Promise<{
      StdioClientTransport: StdioTransportConstructor
    }>,
  ])
  return { Client, StdioClientTransport }
}

export interface ConnectMCPToolsConfig {
  command: string
  args?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
  /**
   * Optional segment prepended to MCP tool names for the framework tool (and LLM) name.
   * Example: prefix `github` + MCP tool `search_issues` → `github_search_issues`.
   */
  namePrefix?: string
  /**
   * Timeout (ms) for MCP connect and each `tools/list` page. Defaults to 60000.
   */
  requestTimeoutMs?: number
  /**
   * Client metadata sent to the MCP server.
   */
  clientName?: string
  clientVersion?: string
}

export interface ConnectedMCPTools {
  tools: ToolDefinition[]
  disconnect: () => Promise<void>
}

/**
 * Build an LLM-safe tool name: MCP and prior examples used `prefix/name`, but
 * Anthropic and other providers reject `/` in tool names.
 */
function normalizeToolName(rawName: string, namePrefix?: string): string {
  const trimmedPrefix = namePrefix?.trim()
  const base =
    trimmedPrefix !== undefined && trimmedPrefix !== ''
      ? `${trimmedPrefix}_${rawName}`
      : rawName
  return base.replace(/\//g, '_')
}

function assertUniqueNormalizedToolNames(
  tools: readonly MCPToolDescriptor[],
  namePrefix?: string,
): void {
  const seen = new Map<string, string>()
  for (const tool of tools) {
    const normalized = normalizeToolName(tool.name, namePrefix)
    const previous = seen.get(normalized)
    if (previous !== undefined) {
      throw new Error(
        `Duplicate MCP tool name after normalization: "${normalized}" ` +
          `from "${previous}" and "${tool.name}".`,
      )
    }
    seen.set(normalized, tool.name)
  }
}

/** MCP `tools/list` JSON Schema; forwarded to the LLM as-is (runtime validation stays `z.any()`). */
function mcpLlmInputSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (schema !== undefined && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema
  }
  return { type: 'object' }
}

function contentBlockToText(block: Record<string, unknown>): string | undefined {
  const typ = block.type
  if (typ === 'text' && typeof block.text === 'string') {
    return block.text
  }
  if (typ === 'image' && typeof block.data === 'string') {
    const mime =
      typeof block.mimeType === 'string' ? block.mimeType : 'image/*'
    return `[image ${mime}; base64 length=${block.data.length}]`
  }
  if (typ === 'audio' && typeof block.data === 'string') {
    const mime =
      typeof block.mimeType === 'string' ? block.mimeType : 'audio/*'
    return `[audio ${mime}; base64 length=${block.data.length}]`
  }
  if (
    typ === 'resource' &&
    block.resource !== null &&
    typeof block.resource === 'object'
  ) {
    const r = block.resource as Record<string, unknown>
    const uri = typeof r.uri === 'string' ? r.uri : ''
    if (typeof r.text === 'string') {
      return `[resource ${uri}]\n${r.text}`
    }
    if (typeof r.blob === 'string') {
      const mime = typeof r.mimeType === 'string' ? r.mimeType : ''
      return `[resource ${uri}; mimeType=${mime}; blob base64 length=${r.blob.length}]`
    }
    return `[resource ${uri}]`
  }
  if (typ === 'resource_link') {
    const uri = typeof block.uri === 'string' ? block.uri : ''
    const name = typeof block.name === 'string' ? block.name : ''
    const desc =
      typeof block.description === 'string' ? block.description : ''
    const head = `[resource_link name=${JSON.stringify(name)} uri=${JSON.stringify(uri)}]`
    return desc === '' ? head : `${head}\n${desc}`
  }
  return undefined
}

function toToolResultData(result: MCPCallToolResponse): string {
  if ('toolResult' in result && result.toolResult !== undefined) {
    try {
      return JSON.stringify(result.toolResult, null, 2)
    } catch {
      return String(result.toolResult)
    }
  }

  const lines: string[] = []
  for (const block of result.content ?? []) {
    if (block === null || typeof block !== 'object') continue
    const rec = block as Record<string, unknown>
    const line = contentBlockToText(rec)
    if (line !== undefined) {
      lines.push(line)
      continue
    }
    try {
      lines.push(
        `[${String(rec.type ?? 'unknown')}]\n${JSON.stringify(rec, null, 2)}`,
      )
    } catch {
      lines.push('[mcp content block]')
    }
  }

  if (lines.length > 0) {
    return lines.join('\n')
  }

  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent, null, 2)
    } catch {
      return String(result.structuredContent)
    }
  }

  try {
    return JSON.stringify(result)
  } catch {
    return 'MCP tool completed with non-text output.'
  }
}

async function listAllMcpTools(
  client: MCPClientLike,
  requestOpts: { timeout: number },
): Promise<MCPToolDescriptor[]> {
  const acc: MCPToolDescriptor[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(
      cursor !== undefined ? { cursor } : {},
      requestOpts,
    )
    acc.push(...(page.tools ?? []))
    cursor =
      typeof page.nextCursor === 'string' && page.nextCursor !== ''
        ? page.nextCursor
        : undefined
  } while (cursor !== undefined)
  return acc
}

/**
 * Connect to an MCP server over stdio and convert exposed MCP tools into
 * open-multi-agent ToolDefinitions.
 */
export async function connectMCPTools(
  config: ConnectMCPToolsConfig,
): Promise<ConnectedMCPTools> {
  const { Client, StdioClientTransport } = await loadMCPModules()

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env,
    cwd: config.cwd,
  })

  const client = new Client(
    {
      name: config.clientName ?? 'open-multi-agent',
      version: config.clientVersion ?? '0.0.0',
    },
    { capabilities: {} },
  )

  const requestOpts = {
    timeout: config.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  }

  try {
    await client.connect(transport, requestOpts)

    const mcpTools = await listAllMcpTools(client, requestOpts)
    assertUniqueNormalizedToolNames(mcpTools, config.namePrefix)

    const tools: ToolDefinition[] = mcpTools.map((tool) =>
      defineTool({
        name: normalizeToolName(tool.name, config.namePrefix),
        description: tool.description ?? `MCP tool: ${tool.name}`,
        inputSchema: z.any(),
        llmInputSchema: mcpLlmInputSchema(tool.inputSchema),
        execute: async (input: Record<string, unknown>, context) => {
          try {
            const result = await client.callTool(
              {
                name: tool.name,
                arguments: input,
              },
              undefined,
              {
                ...requestOpts,
                signal: context.abortSignal,
              },
            )
            return {
              data: toToolResultData(result),
              isError: result.isError === true,
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            return {
              data: `MCP tool "${tool.name}" failed: ${message}`,
              isError: true,
            }
          }
        },
      }),
    )

    return {
      tools,
      disconnect: async () => {
        await client.close?.()
      },
    }
  } catch (error) {
    await Promise.allSettled([
      client.close?.() ?? Promise.resolve(),
      transport.close?.() ?? Promise.resolve(),
    ])
    throw error
  }
}
