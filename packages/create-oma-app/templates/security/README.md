# Security Analysis Agent

A read-only security review of a local repository. Agents never receive shell or write tools, and reports are written only inside this generated project.

```bash
npm install
cp .env.example .env # cloud runtime only
npm run demo
npm run dev -- --repo /path/to/repo
npm run dev -- --repo /path/to/repo --online-audit
```

The default scan is static and offline apart from the selected model provider. `--online-audit` explicitly opts into `npm audit --json --ignore-scripts`; it never installs dependencies or runs project scripts. Suspected secret values are redacted before evidence reaches any model.

Cloud mode sends redacted evidence to your configured model provider. Choose Ollama when repository evidence must stay local. Reports are written to `reports/` as Markdown, JSON, and an HTML DAG dashboard.
