/**
 * Quick smoke test for the Gemini adapter.
 *
 * Run:
 *   npx tsx examples/13-gemini.ts
 *
 * If GEMINI_API_KEY is not set, the adapter will not work.
 */

import { OpenMultiAgent } from '../src/index.js'
import type { OrchestratorEvent } from '../src/types.js'

const orchestrator = new OpenMultiAgent({
  defaultModel: 'gemini-2.5-flash',
  defaultProvider: 'gemini',
  onProgress: (event: OrchestratorEvent) => {
    if (event.type === 'agent_start') {
      console.log(`[start]    agent=${event.agent}`)
    } else if (event.type === 'agent_complete') {
      console.log(`[complete] agent=${event.agent}`)
    }
  },
})

console.log('Testing Gemini adapter with gemini-2.5-flash...\n')

const result = await orchestrator.runAgent(
  {
    name: 'assistant',
    model: 'gemini-2.5-flash',
    provider: 'gemini',
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
