# PR Review Agent

A read-only multi-agent review of a local Git diff or GitHub pull request. The generated app never posts comments or changes the reviewed repository.

## No-key demo

```bash
npm install
npm run demo
```

The demo reviews a bundled fixture with deterministic scripted model responses. It makes no model request and labels Markdown, JSON, and HTML output as simulated; OMA scheduling and report generation run locally for real.

## Real model run

For a Cloud scaffold, copy `.env.example` to `.env` and add the provider key first. For Ollama, start the local service and an installed model. Then run:

```bash
npm run dev -- --repo /path/to/repo
npm run dev -- --repo /path/to/repo --base origin/main
npm run dev -- --pr https://github.com/owner/repo/pull/123
```

`GITHUB_TOKEN` is optional for public PRs and required for private PRs. GitHub mode only fetches metadata and diff through the REST API. Reports are written to `reports/` as Markdown, JSON, and an HTML DAG dashboard.

Cloud mode sends the collected diff to your configured model provider. Choose the Ollama runtime if code must stay on the local machine.
