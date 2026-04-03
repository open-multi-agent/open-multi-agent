/**
 * Quick smoke test for the Copilot adapter.
 *
 * Run:
 *   npx tsx examples/05-copilot-test.ts
 *
 * If GITHUB_COPILOT_TOKEN is not set, the adapter will start an interactive
 * OAuth2 device flow — you'll be prompted to sign in via your browser.
 */

import { OpenMultiAgent } from '../src/index.js'
import type { OrchestratorEvent } from '../src/types.js'

const orchestrator = new OpenMultiAgent({
  defaultModel: 'gpt-4o',
  defaultProvider: 'copilot',
  onProgress: (event: OrchestratorEvent) => {
    if (event.type === 'agent_start') {
      console.log(`[start]    agent=${event.agent}`)
    } else if (event.type === 'agent_complete') {
      console.log(`[complete] agent=${event.agent}`)
    }
  },
})

console.log('Testing Copilot adapter with gpt-4o...\n')

const result = await orchestrator.runAgent(
  {
    name: 'assistant',
    model: 'gpt-4o',
    provider: 'copilot',
    systemPrompt: 'You are a helpful assistant. Keep answers brief.',
    maxTurns: 1,
    maxTokens: 256,
  },
  'What is 2 + 2? Reply in one sentence.',
)

if (result.success) {
  console.log('\nAgent output:')
  console.log('─'.repeat(60))
  console.log(result.output)
  console.log('─'.repeat(60))
  console.log(`\nTokens: input=${result.tokenUsage.input_tokens}, output=${result.tokenUsage.output_tokens}`)
} else {
  console.error('Agent failed:', result.output)
  process.exit(1)
}
