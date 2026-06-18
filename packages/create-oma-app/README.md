# create-oma-app

Scaffold a runnable multi-agent demo on [`@open-multi-agent/core`](https://www.npmjs.com/package/@open-multi-agent/core) — one command from zero to a live agent DAG.

```bash
npm create oma-app@latest
```

Answer one prompt (the project name) and you get a small project that, on its first run, shows a **coordinator breaking a single goal into a multi-agent DAG** — agents running in parallel and in dependency order — then opens a dashboard of the run in your browser.

## What you get

```
my-demo/
├── src/index.ts     # the demo: one goal → multi-agent DAG → dashboard
├── .env.example     # OpenAI, or any OpenAI-compatible provider
├── package.json     # one runtime dependency: @open-multi-agent/core
├── tsconfig.json
└── README.md
```

- **One runtime dependency** — `@open-multi-agent/core`; `tsx` is the only dev dependency.
- **Provider-neutral** — OpenAI out of the box, or any OpenAI-compatible endpoint (DeepSeek, Groq, Ollama, …) via `OPENAI_BASE_URL` + `OMA_MODEL`.
- **No tools, no filesystem writes** — the default demo is pure reasoning, so the first run is fast and robust across providers.

## Run it

```bash
npm create oma-app@latest my-demo
cd my-demo
npm install
cp .env.example .env   # add your key
npm run dev
```

## Next steps

Open `src/index.ts` and change the goal, add an agent, or give an agent tools. See the [examples](https://github.com/open-multi-agent/open-multi-agent/tree/main/packages/core/examples) for tool use, MCP, structured output, and providers.

## License

MIT
