/**
 * @fileoverview `@open-multi-agent/core/process` — run generic local processes
 * as OMA agent backends.
 *
 * Most users never import this module: set {@link AgentBackendConfig} on an
 * agent's `backend` field and OMA loads the backend for you. Import from here
 * only to construct a backend directly (advanced / programmatic use):
 *
 * ```ts
 * import { createProcessBackend } from '@open-multi-agent/core/process'
 * const backend = createProcessBackend({ command: 'node', args: ['agent.js'] })
 * ```
 */

export { ProcessBackend, createProcessBackend } from './agent/process-backend.js'
export type { ProcessBackendOptions } from './agent/process-backend.js'
export type { AgentBackend } from './agent/runner.js'
export type {
  AgentBackendConfig,
  ProcessAgentBackendConfig,
  ProcessBackendInputMode,
} from './types.js'
