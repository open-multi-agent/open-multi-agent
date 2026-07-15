# create-oma-app

Scaffold a production-oriented multi-agent starter on [`@open-multi-agent/core`](https://www.npmjs.com/package/@open-multi-agent/core).

```bash
npm create oma-app@latest
```

Interactive use asks for a project name, starter, and runtime. Non-interactive calls without flags retain the original `demo + cloud` behavior.

## Starters

- **PR Review Agent** — reviews a local Git diff or a GitHub PR using parallel correctness, security, and quality reviewers.
- **Security Analysis Agent** — read-only repository analysis with secret redaction and opt-in `npm audit`.
- **Multi-agent DAG Demo** — the original pure-reasoning onboarding-plan example.

All starters support cloud/OpenAI-compatible endpoints and local Ollama. Production agents receive no shell or write tools; their host process collects bounded evidence and writes Markdown, JSON, and HTML reports under `reports/`.

## Run it

```bash
npm create oma-app@latest my-reviewer -- --template pr-review --provider cloud
cd my-reviewer
npm install
cp .env.example .env   # add your key
npm run demo
npm run dev -- --repo ../your-repo --base origin/main
```

Other combinations:

```bash
npm create oma-app@latest my-auditor -- --template security --provider ollama
npm create oma-app@latest my-demo -- --template demo --provider cloud
```

Ollama projects select `OMA_MODEL` when set, otherwise the first installed model. The scaffolder never installs dependencies, downloads models, or calls a model for you.

## License

MIT
