# Multi-agent demo

Built on [`@open-multi-agent/core`](https://www.npmjs.com/package/@open-multi-agent/core), scaffolded with `npm create oma-app`.

## Run

```bash
npm install
cp .env.example .env   # add your API key
npm run dev
```

You'll see a **coordinator** break one goal into a task DAG, several agents run in parallel and in dependency order, and a **dashboard** of the run open in your browser (`dashboard.html`).

Works with OpenAI out of the box, or any OpenAI-compatible provider — set `OPENAI_BASE_URL` + `OMA_MODEL` in `.env` (DeepSeek, Groq, Ollama, …). See `.env.example`.

## What's next

Everything lives in [`src/index.ts`](src/index.ts):

- **Change the goal** — swap the goal string for your own multi-step task.
- **Add an agent** — add an `AgentConfig` to the team roster; the coordinator routes work to it.
- **Give agents tools** — add e.g. `tools: ['file_read', 'file_write', 'bash']` to an agent so it can read/write files, run commands, or call MCP servers.

More patterns (tool use, MCP, structured output, providers) are in the [examples](https://github.com/open-multi-agent/open-multi-agent/tree/main/packages/core/examples).

> Tip: for full editor type-checking, `npm i -D @types/node`. Not needed to run.
