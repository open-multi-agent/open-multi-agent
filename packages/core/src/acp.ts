/**
 * @fileoverview `@open-multi-agent/core/acp` — orchestrate external coding agents
 * (Gemini CLI, Claude Code, Codex, …) over the Agent Client Protocol (ACP).
 *
 * Most users never import this module: set {@link AgentBackendConfig} on an
 * agent's `backend` field and OMA loads the backend for you. Import from here only
 * to construct a backend directly (advanced / programmatic use):
 *
 * ```ts
 * import { createAcpBackend } from '@open-multi-agent/core/acp'
 * const backend = createAcpBackend({ command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] })
 * ```
 *
 * Requires the optional peer dependency `@agentclientprotocol/sdk`.
 */

export { AcpBackend, createAcpBackend } from './agent/acp-backend.js'
export type { AcpBackendOptions, AcpConnection } from './agent/acp-backend.js'
export type { AgentBackend } from './agent/runner.js'
export type {
  AgentBackendConfig,
  AcpPermissionPolicy,
  AcpPermissionRequest,
} from './types.js'
