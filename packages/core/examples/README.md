# Examples

Runnable scripts demonstrating `open-multi-agent`. Organized by category — pick one that matches what you're trying to do.

All scripts run with `npx tsx packages/core/examples/<category>/<name>.ts`. Scripts that call a model require the corresponding API key in your environment. The full applications (see the apps section below) are the exception: they have their own `package.json` and start scripts.

---

## basics — start here

The four core execution modes. Read these first.

| Example | What it shows |
|---------|---------------|
| [`basics/single-agent`](basics/single-agent.ts) | One agent with bash + file tools, then streaming via the `Agent` class. |
| [`basics/team-collaboration`](basics/team-collaboration.ts) | `runTeam()` coordinator pattern — goal in, results out. |
| [`basics/task-pipeline`](basics/task-pipeline.ts) | `runTasks()` with explicit task DAG and dependencies. |
| [`basics/multi-model-team`](basics/multi-model-team.ts) | Different models per agent in one team. |

## providers — model & adapter examples

One example per supported provider. All follow the same three-agent (architect / developer / reviewer) shape so they're easy to compare.

| Example | Provider | Env var |
|---------|----------|---------|
| [`providers/ollama`](providers/ollama.ts) | Ollama (local) + Claude | `ANTHROPIC_API_KEY` |
| [`providers/gemma4-local`](providers/gemma4-local.ts) | Gemma 4 via Ollama (100% local) | — |
| [`providers/local-quantized`](providers/local-quantized.ts) | Quantized MoE on vLLM / llama-server with tuned sampling (`topK` / `minP` / `frequencyPenalty` / `parallelToolCalls` / `extraBody.repetition_penalty`) | — |
| [`providers/copilot`](providers/copilot.ts) | GitHub Copilot (GPT-4o + Claude) | `GITHUB_TOKEN` |
| [`providers/azure-openai`](providers/azure-openai.ts) | Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` (+ optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`) |
| [`providers/bedrock`](providers/bedrock.ts) | AWS Bedrock (Claude via Converse API) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| [`providers/grok`](providers/grok.ts) | xAI Grok | `XAI_API_KEY` |
| [`providers/gemini`](providers/gemini.ts) | Google Gemini | `GEMINI_API_KEY` |
| [`providers/minimax`](providers/minimax.ts) | MiniMax M3 | `MINIMAX_API_KEY` |
| [`providers/mimo`](providers/mimo.ts) | MiMo V2.5 Pro | `MIMO_API_KEY` |
| [`providers/hunyuan`](providers/hunyuan.ts) | Tencent Hunyuan (MaaS, hy3) | `HUNYUAN_API_KEY` |
| [`providers/deepseek`](providers/deepseek.ts) | DeepSeek Chat | `DEEPSEEK_API_KEY` |
| [`providers/openrouter`](providers/openrouter.ts) | OpenRouter (OpenAI-compatible) | `OPENROUTER_API_KEY` |
| [`providers/groq`](providers/groq.ts) | Groq (OpenAI-compatible) | `GROQ_API_KEY` |
| [`providers/mistral`](providers/mistral.ts) | Mistral (OpenAI-compatible) | `MISTRAL_API_KEY` |
| [`providers/zhipu`](providers/zhipu.ts) | Zhipu GLM (OpenAI-compatible) | `ZHIPU_API_KEY` |
| [`providers/doubao`](providers/doubao.ts) | Doubao / ByteDance (OpenAI-compatible) | `ARK_API_KEY` |
| [`providers/qiniu`](providers/qiniu.ts) | Qiniu (OpenAI-compatible) | `QINIU_API_KEY` |
| [`providers/qwen`](providers/qwen.ts) | Qwen / DashScope (OpenAI-compatible) | `DASHSCOPE_API_KEY` |
| [`providers/moonshot`](providers/moonshot.ts) | Moonshot AI / Kimi (OpenAI-compatible) | `MOONSHOT_API_KEY` |

## patterns — orchestration patterns

Reusable shapes for common multi-agent problems.

| Example | Pattern |
|---------|---------|
| [`patterns/fan-out-aggregate`](patterns/fan-out-aggregate.ts) | MapReduce-style fan-out via `AgentPool.runParallel()`. |
| [`patterns/structured-output`](patterns/structured-output.ts) | Zod-validated JSON output from an agent. |
| [`patterns/task-retry`](patterns/task-retry.ts) | Per-task retry with exponential backoff. |
| [`patterns/multi-perspective-code-review`](patterns/multi-perspective-code-review.ts) | Multiple reviewer agents in parallel, then synthesis. |
| [`patterns/research-aggregation`](patterns/research-aggregation.ts) | Multi-source research collated by a synthesis agent. |
| [`patterns/cost-tiered-pipeline`](patterns/cost-tiered-pipeline.ts) | Run the same four-stage pipeline twice to compare flagship vs tiered model cost. |
| [`patterns/agent-handoff`](patterns/agent-handoff.ts) | Synchronous sub-agent delegation via `delegate_to_agent`. |
| [`patterns/plan-replay`](patterns/plan-replay.ts) | Pin a coordinator plan with `createPlanArtifact`, then replay it with `runFromPlan`, no coordinator re-run. |
| [`patterns/consensus`](patterns/consensus.ts) | Proposer→judge refutation loop via `runConsensus()`: default judge prompt and per-judge `judgePrompt` function. |
| [`patterns/cross-provider-reasoning`](patterns/cross-provider-reasoning.ts) | Preserve a reasoning model's thought stream across providers via `preserveReasoningAsText`. |

## cookbook — use-case recipes

End-to-end examples framed around a concrete problem (meeting summarization, translation QA, competitive monitoring, etc.) rather than a single orchestration primitive. Lighter bar than `production/`: no tests or pinned model versions required. Good entry point if you want to see how the patterns compose on a real task.

| Example | Problem solved |
|---------|----------------|
| [`cookbook/meeting-summarizer`](cookbook/meeting-summarizer.ts) | Fan-out post-processing of a transcript into summary, structured action items, and sentiment. |
| [`cookbook/contract-review-dag`](cookbook/contract-review-dag.ts) | 4-task DAG (extract → compliance-check + summary → notify) with step-level retry. Run normally or with `FORCE_FAIL=task2` to exercise retry. |
| [`cookbook/incident-postmortem-dag`](cookbook/incident-postmortem-dag.ts) | 5-task DAG with three parallel root tasks (log patterns + deploy correlation + blast radius) feeding root-cause hypothesis and final postmortem synthesis. |
| [`cookbook/competitive-monitoring`](cookbook/competitive-monitoring.ts) | Parallel source monitoring (Twitter/Reddit/News), contradiction detection, and aggregated intelligence reporting. |
| [`cookbook/paper-replication-triage`](cookbook/paper-replication-triage.ts) | Multi-source paper replication triage with artifact discovery, seeded conflicts, and a structured go/no-go plan. |
| [`cookbook/rare-disease-information-triage`](cookbook/rare-disease-information-triage.ts) | Source-isolated rare disease information triage with mock fixtures, seeded misinformation/conflict detection, and safety-boundary arbitration. |
| [`cookbook/personalized-interview-simulator`](cookbook/personalized-interview-simulator.ts) | Interactive interviewer loop with observer flags, shared memory, and structured debrief. |
| [`cookbook/narrative-puzzle-hint-arbitration`](cookbook/narrative-puzzle-hint-arbitration.ts) | Multi-source hint arbitration with an external safety veto that sits outside the generation loop. |
| [`cookbook/translation-backtranslation`](cookbook/translation-backtranslation.ts) | Translate → back-translate with a different provider → flag semantic drift (cross-model). |

## integrations — external systems

Hooking the framework up to outside-the-box tooling.

| Example | Integrates with |
|---------|-----------------|
| [`integrations/trace-observability`](integrations/trace-observability.ts) | `onTrace` spans for LLM calls, tools, and tasks. |
| [`integrations/mcp-github`](integrations/mcp-github.ts) | An MCP server's tools exposed to an agent via `connectMCPTools()`. |
| [`integrations/mcp-bilig-workpaper`](integrations/mcp-bilig-workpaper.ts) | Bilig WorkPaper MCP tools for formula readback, recalculation, and persisted workbook JSON. |
## apps — full applications

Complete, clone-and-run applications with their own `package.json` and dependencies. These embed OMA in a real backend, so they use `npm install` plus their own start script rather than `npx tsx`.

| Example | Stack | Run |
|---------|-------|-----|
| [`integrations/express-customer-support/`](integrations/express-customer-support/) | Express REST API: `runTasks()` behind `POST /tickets`, per-agent Zod schemas, swappable provider env vars, HTTP error mapping (400/502/504) | `npm install && npm start` |
| [`integrations/with-vercel-ai-sdk/`](integrations/with-vercel-ai-sdk/) | Next.js: OMA `runTeam()` plus AI SDK `useChat` streaming | `npm install && npm run dev` |

## production — real-world use cases

End-to-end examples wired to real workflows. Higher bar than the categories above. See [`production/README.md`](production/README.md) for the acceptance criteria and how to contribute.

---

## Adding a new example

| You're adding… | Goes in… | Filename |
|----------------|----------|----------|
| A new model provider | `providers/` | `<provider-name>.ts` (lowercase, hyphenated) |
| A reusable orchestration pattern | `patterns/` | `<pattern-name>.ts` |
| A use-case-driven example (problem-first, uses one or more patterns) | `cookbook/` | `<use-case>.ts` |
| Integration with an outside system (MCP server, observability backend, framework, app) | `integrations/` | `<system>.ts` or `<system>/` for multi-file |
| A real-world end-to-end use case, production-grade | `production/` | `<use-case>/` directory with its own README |

Conventions:

- **No numeric prefixes.** Folders signal category; reading order is set by this README.
- **File header docstring** with one-line title, `Run:` block, and prerequisites.
- **Imports** should resolve as `from '../../src/index.js'` for scripts (one level deeper than the old flat layout); full applications with their own `package.json` import the published `@open-multi-agent/core` package name instead.
- **Match the provider template** when adding a provider: three-agent team (architect / developer / reviewer) building a small REST API. Keeps comparisons honest.
- **Add a row** to the table in this file for the corresponding category.
