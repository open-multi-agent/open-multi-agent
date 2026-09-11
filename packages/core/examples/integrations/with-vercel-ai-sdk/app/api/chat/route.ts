import { streamText, convertToModelMessages, createUIMessageStreamResponse, toUIMessageStream, type UIMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { OpenMultiAgent } from '@open-multi-agent/core'
import type { AgentConfig } from '@open-multi-agent/core'

export const maxDuration = 360

// --- DeepSeek via OpenAI-compatible API ---
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_MODEL = 'deepseek-flash'

const deepseek = createOpenAICompatible({
  name: 'deepseek',
  baseURL: `${DEEPSEEK_BASE_URL}/v1`,
  apiKey: process.env.DEEPSEEK_API_KEY,
})

const researcher: AgentConfig = {
  name: 'researcher',
  model: DEEPSEEK_MODEL,
  provider: 'openai',
  baseURL: DEEPSEEK_BASE_URL,
  apiKey: process.env.DEEPSEEK_API_KEY,
  systemPrompt: `You are a research specialist. Given a topic, provide thorough, factual research
with key findings, relevant data points, and important context.
Be concise but comprehensive. Output structured notes, not prose.`,
  maxTurns: 3,
  temperature: 0.2,
}

const writer: AgentConfig = {
  name: 'writer',
  model: DEEPSEEK_MODEL,
  provider: 'openai',
  baseURL: DEEPSEEK_BASE_URL,
  apiKey: process.env.DEEPSEEK_API_KEY,
  systemPrompt: `You are an expert writer. Using research from team members (available in shared memory),
write a well-structured, engaging article with clear headings and concise paragraphs.
Do not repeat raw research — synthesize it into readable prose.`,
  maxTurns: 3,
  temperature: 0.4,
}

function extractText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json()
  const lastText = extractText(messages.at(-1)!)

  // --- Phase 1: OMA multi-agent orchestration ---
  const orchestrator = new OpenMultiAgent({
    defaultModel: DEEPSEEK_MODEL,
    defaultProvider: 'openai',
    defaultBaseURL: DEEPSEEK_BASE_URL,
    defaultApiKey: process.env.DEEPSEEK_API_KEY,
  })

  const team = orchestrator.createTeam('research-writing', {
    name: 'research-writing',
    agents: [researcher, writer],
    sharedMemory: true,
  })

  const teamResult = await orchestrator.runTeam(
    team,
    `Research and write an article about: ${lastText}`,
    // Execution routing sends a short goal down the single-agent path. An
    // explicit mode outranks the router, so this keeps the demo on the
    // researcher + writer team topology.
    { mode: 'team' },
  )

  // The team path publishes the synthesized answer under 'coordinator'; the
  // single-agent path publishes it under the winning agent's own name. Read
  // both so this route survives whichever topology runs.
  const teamOutput =
    teamResult.agentResults.get('coordinator')?.output
    ?? teamResult.agentResults.get('writer')?.output
    ?? ''

  // A failed run still leaves the coordinator's unparsed plan under
  // 'coordinator', so check `success` rather than testing for an empty string.
  if (!teamResult.success || teamOutput === '') {
    return new Response(
      `The agent team did not produce an article: ${
        teamResult.errorInfo?.message ?? teamResult.status?.code ?? 'unknown error'
      }`,
      { status: 500 },
    )
  }

  // --- Phase 2: Stream result via Vercel AI SDK ---
  const result = streamText({
    model: deepseek(DEEPSEEK_MODEL),
    system: `You are presenting research from a multi-agent team (researcher + writer).
The team has already done the work. Your only job is to relay their output to the user
in a well-formatted way. Keep the content faithful to the team output below.
At the very end, add a one-line note that this was produced by a researcher agent
and a writer agent collaborating via open-multi-agent.

## Team Output
${teamOutput}`,
    messages: await convertToModelMessages(messages),
  })

  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })
}
