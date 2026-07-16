import { describe, expect, it } from 'vitest'
import type {
  AgentBackendConfig,
  AgentConfig,
  ExternalAgentBackendConfig,
} from '../src/types.js'

interface CustomAcpBackendConfig extends AgentBackendConfig {
  readonly label: 'custom-acp'
}

describe('agent backend config types', () => {
  it('keeps AgentBackendConfig as the ACP interface while AgentConfig accepts all external backends', () => {
    const acp: CustomAcpBackendConfig = {
      label: 'custom-acp',
      kind: 'acp',
      command: 'npx',
      permission: 'reject',
    }
    const processBackend: ExternalAgentBackendConfig = {
      kind: 'process',
      command: process.execPath,
    }
    const agent: AgentConfig = {
      name: 'process-agent',
      backend: processBackend,
    }

    expect(acp.permission).toBe('reject')
    expect(agent.backend?.kind).toBe('process')
  })
})
