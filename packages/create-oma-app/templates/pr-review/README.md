# PR Review Agent

A read-only multi-agent review of a local Git diff or GitHub pull request. The generated app never posts comments or changes the reviewed repository.

```bash
npm install
cp .env.example .env # cloud runtime only
npm run demo
npm run dev -- --repo /path/to/repo
npm run dev -- --repo /path/to/repo --base origin/main
npm run dev -- --pr https://github.com/owner/repo/pull/123
```

`GITHUB_TOKEN` is optional for public PRs and required for private PRs. GitHub mode only fetches metadata and diff through the REST API. Reports are written to `reports/` as Markdown, JSON, and an HTML DAG dashboard.

Cloud mode sends the collected diff to your configured model provider. Choose the Ollama runtime if code must stay on the local machine.
