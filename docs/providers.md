# Providers

`open-multi-agent` keeps the agent config shape stable across hosted, cloud, and local providers. Change `provider`, `model`, and the relevant credential; the rest of your team definition stays the same.

```typescript
const agent = {
  name: 'my-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful assistant.',
}
```

## Built-In Provider Shortcuts

The framework ships a wired-in provider name for each of these. Set `provider` and the env var, and the adapter handles the endpoint.

> Under the hood, Anthropic, Gemini, and Bedrock use provider-specific APIs. The other built-in shortcuts are pre-configured wrappers around OpenAI-compatible endpoints; same wire format as the OpenAI-compatible table below, with the `baseURL` already supplied.

| Provider | Config | Env var | Example model | Notes |
|----------|--------|---------|---------------|-------|
| Anthropic (Claude) | `provider: 'anthropic'` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Native Anthropic SDK. |
| Gemini | `provider: 'gemini'` | `GEMINI_API_KEY` | `gemini-2.5-pro` | Native Google GenAI SDK. Requires `npm install @google/genai`. |
| OpenAI (GPT) | `provider: 'openai'` | `OPENAI_API_KEY` | `gpt-4o` | |
| Azure OpenAI | `provider: 'azure-openai'` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` | `gpt-4` | Optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`. |
| GitHub Copilot | `provider: 'copilot'` | `GITHUB_COPILOT_TOKEN` (falls back to `GITHUB_TOKEN`) | `gpt-4o` | Custom token-exchange flow on top of OpenAI protocol. |
| Grok (xAI) | `provider: 'grok'` | `XAI_API_KEY` | `grok-4` | OpenAI-compatible; endpoint is `api.x.ai/v1`. |
| DeepSeek | `provider: 'deepseek'` | `DEEPSEEK_API_KEY` | `deepseek-chat` | OpenAI-compatible. `deepseek-chat` (V3, coding) or `deepseek-reasoner` (thinking mode). |
| MiniMax (global) | `provider: 'minimax'` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | OpenAI-compatible. |
| MiniMax (China) | `provider: 'minimax'` + `MINIMAX_BASE_URL` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | Set `MINIMAX_BASE_URL=https://api.minimaxi.com/v1`. |
| Qiniu | `provider: 'qiniu'` | `QINIU_API_KEY` | `deepseek-v3` | OpenAI-compatible. Endpoint `https://api.qnaigc.com/v1`; multiple model families, see [Qiniu AI docs](https://developer.qiniu.com/aitokenapi/12882/ai-inference-api). |
| AWS Bedrock | `provider: 'bedrock'` | none (AWS SDK credential chain) | `anthropic.claude-3-5-haiku-20241022-v1:0` | No API key. Set `AWS_REGION` or pass `region` as the 4th arg to `createAdapter`. Credentials come from env vars, shared config, or IAM role. Newer Claude models can require a cross-region inference profile prefix such as `us.`. Also supports Llama, Mistral, and Cohere. See [`providers/bedrock`](../examples/providers/bedrock.ts). Requires `npm install @aws-sdk/client-bedrock-runtime`. |

## OpenAI-Compatible Providers

No bundled shortcut is needed when a server speaks OpenAI Chat Completions. Use `provider: 'openai'` and point `baseURL` at the service.

| Service | Config | Env var | Example model | Notes |
|---------|--------|---------|---------------|-------|
| Ollama (local) | `provider: 'openai'` + `baseURL: 'http://localhost:11434/v1'` | none | `llama3.1` | |
| vLLM (local) | `provider: 'openai'` + `baseURL` | none | server-loaded | |
| LM Studio (local) | `provider: 'openai'` + `baseURL` | none | server-loaded | |
| llama.cpp server (local) | `provider: 'openai'` + `baseURL` | none | server-loaded | |
| OpenRouter | `provider: 'openai'` + `baseURL: 'https://openrouter.ai/api/v1'` + `apiKey` | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` | |
| Groq | `provider: 'openai'` + `baseURL: 'https://api.groq.com/openai/v1'` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | |
| Mistral | `provider: 'openai'` + `baseURL: 'https://api.mistral.ai/v1'` | `MISTRAL_API_KEY` | `mistral-large-latest` | See [`providers/mistral`](../examples/providers/mistral.ts). |

Other services can be connected the same way if they implement the OpenAI Chat Completions API, but they are not listed as verified providers here. For services where the key is not `OPENAI_API_KEY`, pass it explicitly via `apiKey`; otherwise the `openai` adapter falls back to `OPENAI_API_KEY`.

## Local Model Tool-Calling

The framework supports tool-calling with local models served by Ollama, vLLM, LM Studio, or llama.cpp. Tool-calling is handled natively through the OpenAI-compatible API.

Verified local models include Gemma 4, Llama 3.1, Qwen 3, Mistral, and Phi-4. Ollama publishes its tool-capable models at [ollama.com/search?c=tools](https://ollama.com/search?c=tools).

If a local model returns tool calls as text instead of the `tool_calls` wire format, the framework automatically extracts them from the text output. This helps with thinking models or misconfigured local servers.

Use `timeoutMs` on `AgentConfig` for slow local inference:

```typescript
const localAgent = {
  name: 'local',
  model: 'llama3.1',
  provider: 'openai',
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  tools: ['bash', 'file_read'],
  timeoutMs: 120_000,
}
```

Highly quantized MoE models on consumer hardware can fall into repetition loops or hallucinate tool-call schemas under default sampling. `AgentConfig` exposes `topK`, `minP`, `frequencyPenalty`, `presencePenalty`, `parallelToolCalls`, and `extraBody` for server-specific knobs such as vLLM's `repetition_penalty`. See [`providers/local-quantized`](../examples/providers/local-quantized.ts) for a complete setup.

## Troubleshooting

- Model not calling tools? Confirm it appears in Ollama's [Tools category](https://ollama.com/search?c=tools).
- Using Ollama? Update to the latest version with `ollama update`.
- Proxy interfering with local servers? Use `no_proxy=localhost`.
