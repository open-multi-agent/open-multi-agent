/**
 * Phase 1 (#223): assert that every shipped adapter declares both
 *   - `name` — used as the value stamped onto inbound `ReasoningBlock.provenance`
 *   - `capabilities.echoesReasoning` — `'never'` or `'own-issued'`
 *
 * No outbound behaviour is asserted here; that is Phase 2 territory.
 *
 * The AI SDK adapter is exercised in tests/ai-sdk-adapter.test.ts; it requires
 * the optional `ai` peer dependency at construction time and is therefore
 * excluded from this contract suite to avoid coupling Phase 1 verification
 * to peer-dep installation.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/sdk', () => {
  const ctor = vi.fn(() => ({ messages: { create: vi.fn(), stream: vi.fn() } }))
  return { default: ctor, Anthropic: ctor }
})

vi.mock('openai', () => {
  const OpenAICtor: any = vi.fn(() => ({
    chat: { completions: { create: vi.fn() } },
  }))
  OpenAICtor.AzureOpenAI = vi.fn(() => ({
    chat: { completions: { create: vi.fn() } },
  }))
  return { default: OpenAICtor, OpenAI: OpenAICtor, AzureOpenAI: OpenAICtor.AzureOpenAI }
})

vi.mock('@google/genai', () => {
  return { GoogleGenAI: vi.fn(() => ({ models: { generateContent: vi.fn() } })) }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn(() => ({ send: vi.fn() })),
    ConverseCommand: vi.fn(),
    ConverseStreamCommand: vi.fn(),
  }
})

import { AnthropicAdapter } from '../src/llm/anthropic.js'
import { OpenAIAdapter } from '../src/llm/openai.js'
import { AzureOpenAIAdapter } from '../src/llm/azure-openai.js'
import { CopilotAdapter } from '../src/llm/copilot.js'
import { DeepSeekAdapter } from '../src/llm/deepseek.js'
import { GrokAdapter } from '../src/llm/grok.js'
import { QiniuAdapter } from '../src/llm/qiniu.js'
import { MiniMaxAdapter } from '../src/llm/minimax.js'
import { MiMoAdapter } from '../src/llm/mimo.js'
import { HunyuanAdapter } from '../src/llm/hunyuan.js'
import { GeminiAdapter } from '../src/llm/gemini.js'
import { BedrockAdapter } from '../src/llm/bedrock.js'

describe('LLMAdapter Phase 1 capability contract', () => {
  it.each([
    ['anthropic', () => new AnthropicAdapter('dummy-key'), 'own-issued' as const],
    ['gemini', () => new GeminiAdapter('dummy-key'), 'own-issued' as const],
    ['openai', () => new OpenAIAdapter('dummy-key'), 'never' as const],
    ['azure-openai', () => new AzureOpenAIAdapter('dummy-key', 'https://example.openai.azure.com'), 'never' as const],
    ['copilot', () => new CopilotAdapter('dummy-token'), 'never' as const],
    ['deepseek', () => new DeepSeekAdapter('dummy-key'), 'tool-use-only' as const],
    ['grok', () => new GrokAdapter('dummy-key'), 'never' as const],
    ['qiniu', () => new QiniuAdapter('dummy-key'), 'never' as const],
    ['minimax', () => new MiniMaxAdapter('dummy-key'), 'never' as const],
    ['mimo', () => new MiMoAdapter('dummy-key'), 'tool-use-only' as const],
    ['hunyuan', () => new HunyuanAdapter('dummy-key'), 'tool-use-only' as const],
    ['bedrock', () => new BedrockAdapter('us-east-1'), 'never' as const],
  ])('%s declares the documented name and capabilities', (expectedName, factory, expectedEcho) => {
    const adapter = factory()
    expect(adapter.name).toBe(expectedName)
    expect(adapter.capabilities).toBeDefined()
    expect(adapter.capabilities?.echoesReasoning).toBe(expectedEcho)
  })

  it('OpenAI subclasses inherit `capabilities` from OpenAIAdapter (except DeepSeek)', () => {
    // Sanity check: most subclasses don't redeclare `capabilities` and rely
    // on inheritance so any future adjustment to the parent's value
    // propagates. DeepSeek is the deliberate exception — see the next test.
    const parent = new OpenAIAdapter('dummy-key').capabilities
    expect(new GrokAdapter('dummy-key').capabilities).toEqual(parent)
    expect(new QiniuAdapter('dummy-key').capabilities).toEqual(parent)
    expect(new MiniMaxAdapter('dummy-key').capabilities).toEqual(parent)
  })

  it('DeepSeek, MiMo and Hunyuan override `capabilities` to `tool-use-only`', () => {
    // DeepSeek and MiMo thinking modes require `reasoning_content` to be
    // echoed back on follow-up requests with prior tool-use turns; without
    // this override they would inherit OpenAI's `'never'` and hit 400 on the
    // second turn of a tool-using agent. Hunyuan's hy3-preview interleaved
    // thinking has the same backfill requirement (quality, not a hard 400).
    expect(new DeepSeekAdapter('dummy-key').capabilities).toEqual({
      echoesReasoning: 'tool-use-only',
    })
    expect(new MiMoAdapter('dummy-key').capabilities).toEqual({
      echoesReasoning: 'tool-use-only',
    })
    expect(new HunyuanAdapter('dummy-key').capabilities).toEqual({
      echoesReasoning: 'tool-use-only',
    })
    expect(new DeepSeekAdapter('dummy-key').capabilities).not.toEqual(
      new OpenAIAdapter('dummy-key').capabilities,
    )
    expect(new MiMoAdapter('dummy-key').capabilities).not.toEqual(
      new OpenAIAdapter('dummy-key').capabilities,
    )
    expect(new HunyuanAdapter('dummy-key').capabilities).not.toEqual(
      new OpenAIAdapter('dummy-key').capabilities,
    )
  })
})

describe('fromOpenAICompletion provenance stamping (Phase 1, #223)', () => {
  it('stamps the provided provenance onto extracted ReasoningBlock', async () => {
    const { fromOpenAICompletion } = await import('../src/llm/openai-common.js')

    const completion: any = {
      id: 'cmpl_test',
      model: 'gpt-test',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'final answer',
            reasoning_content: 'plan first',
            tool_calls: undefined,
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }

    const result = fromOpenAICompletion(completion, undefined, 'openai')
    expect(result.content[0]).toEqual({
      type: 'reasoning',
      text: 'plan first',
      provenance: 'openai',
    })

    const azureResult = fromOpenAICompletion(completion, undefined, 'azure-openai')
    expect(azureResult.content[0]).toEqual({
      type: 'reasoning',
      text: 'plan first',
      provenance: 'azure-openai',
    })
  })

  it('omits provenance when caller passes undefined (backwards compatibility)', async () => {
    const { fromOpenAICompletion } = await import('../src/llm/openai-common.js')

    const completion: any = {
      id: 'cmpl_test',
      model: 'gpt-test',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'plan',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }

    const result = fromOpenAICompletion(completion)
    expect(result.content[0]).toEqual({ type: 'reasoning', text: 'plan' })
  })
})
