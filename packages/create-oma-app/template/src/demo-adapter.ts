import type {
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
} from '@open-multi-agent/core'

export const DEMO_MODEL = 'demo-fixture'
export const DEMO_NOTICE =
  'DEMO MODE — Simulated model responses. OMA orchestration, scheduling, aggregation, and reporting run locally for real. No model API is called.'

export type DemoResponse = string | ((messages: readonly LLMMessage[]) => string)

export function messageText(messages: readonly LLMMessage[]): string {
  return messages
    .flatMap((message) => message.content)
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export function createDemoAdapter(name: string, scripted: DemoResponse): LLMAdapter {
  return {
    name: `demo-fixture:${name}`,
    async chat(messages: LLMMessage[], _options: LLMChatOptions): Promise<LLMResponse> {
      const text = typeof scripted === 'function' ? scripted(messages) : scripted
      return {
        id: `demo-fixture-${name}`,
        content: [{ type: 'text', text }],
        model: DEMO_MODEL,
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
    async *stream() {},
  }
}
