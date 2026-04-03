/**
 * @fileoverview open-multi-agent — public API surface.
 *
 * Import from `'open-multi-agent'` to access everything you need:
 *
 * ```ts
 * import { OpenMultiAgent, Agent, Team, defineTool } from 'open-multi-agent'
 * ```
 *
 * ## Quickstart
 *
 * ### Single agent
 * ```ts
 * const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-opus-4-6' })
 * const result = await orchestrator.runAgent(
 *   { name: 'assistant', model: 'claude-opus-4-6' },
 *   'Explain monads in one paragraph.',
 * )
 * console.log(result.output)
 * ```
 *
 * ### Multi-agent team (auto-orchestrated)
 * ```ts
 * const orchestrator = new OpenMultiAgent()
 * const team = orchestrator.createTeam('writers', {
 *   name: 'writers',
 *   agents: [
 *     { name: 'researcher', model: 'claude-opus-4-6', systemPrompt: 'You research topics thoroughly.' },
 *     { name: 'writer',     model: 'claude-opus-4-6', systemPrompt: 'You write clear documentation.' },
 *   ],
 *   sharedMemory: true,
 * })
 * const result = await orchestrator.runTeam(team, 'Write a guide on TypeScript generics.')
 * console.log(result.agentResults.get('coordinator')?.output)
 * ```
 *
 * ### Custom tools
 * ```ts
 * import { z } from 'zod'
 *
 * const myTool = defineTool({
 *   name: 'fetch_data',
 *   description: 'Fetch JSON data from a URL.',
 *   inputSchema: z.object({ url: z.string().url() }),
 *   execute: async ({ url }) => {
 *     const res = await fetch(url)
 *     return { data: await res.text() }
 *   },
 * })
 * ```
 */

// ---------------------------------------------------------------------------
// Orchestrator (primary entry point)
// ---------------------------------------------------------------------------

export { OpenMultiAgent, executeWithRetry, computeRetryDelay } from './orchestrator/orchestrator.js'
export { Scheduler } from './orchestrator/scheduler.js'
export type { SchedulingStrategy } from './orchestrator/scheduler.js'

// ---------------------------------------------------------------------------
// Agent layer
// ---------------------------------------------------------------------------

export { Agent } from './agent/agent.js'
export { buildStructuredOutputInstruction, extractJSON, validateOutput } from './agent/structured-output.js'
export { AgentPool, Semaphore } from './agent/pool.js'
export type { PoolStatus } from './agent/pool.js'

// ---------------------------------------------------------------------------
// Team layer
// ---------------------------------------------------------------------------

export { Team } from './team/team.js'
export { MessageBus } from './team/messaging.js'
export type { Message } from './team/messaging.js'

// ---------------------------------------------------------------------------
// Task layer
// ---------------------------------------------------------------------------

export { TaskQueue } from './task/queue.js'
export { createTask, isTaskReady, getTaskDependencyOrder, validateTaskDependencies } from './task/task.js'
export type { TaskQueueEvent } from './task/queue.js'

// ---------------------------------------------------------------------------
// Tool system
// ---------------------------------------------------------------------------

export { defineTool, ToolRegistry, zodToJsonSchema } from './tool/framework.js'
export { ToolExecutor } from './tool/executor.js'
export type { ToolExecutorOptions, BatchToolCall } from './tool/executor.js'
export {
  registerBuiltInTools,
  BUILT_IN_TOOLS,
  bashTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
} from './tool/built-in/index.js'

// ---------------------------------------------------------------------------
// LLM adapters
// ---------------------------------------------------------------------------

export { createAdapter } from './llm/adapter.js'
export type { SupportedProvider } from './llm/adapter.js'

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export { InMemoryStore } from './memory/store.js'
export { SharedMemory } from './memory/shared.js'

// ---------------------------------------------------------------------------
// Types — all public interfaces re-exported for consumer type-checking
// ---------------------------------------------------------------------------

export type {
  // Content blocks
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  ContentBlock,

  // LLM
  LLMMessage,
  LLMResponse,
  LLMAdapter,
  LLMChatOptions,
  LLMStreamOptions,
  LLMToolDef,
  TokenUsage,
  StreamEvent,

  // Tools
  ToolDefinition,
  ToolResult,
  ToolUseContext,
  AgentInfo,
  TeamInfo,

  // Agent
  AgentConfig,
  AgentState,
  AgentRunResult,
  ToolCallRecord,

  // Team
  TeamConfig,
  TeamRunResult,

  // Task
  Task,
  TaskStatus,

  // Orchestrator
  OrchestratorConfig,
  OrchestratorEvent,

  // Trace
  TraceEventType,
  TraceEventBase,
  TraceEvent,
  LLMCallTrace,
  ToolCallTrace,
  TaskTrace,
  AgentTrace,

  // Memory
  MemoryEntry,
  MemoryStore,
} from './types.js'

export { generateRunId } from './utils/trace.js'
