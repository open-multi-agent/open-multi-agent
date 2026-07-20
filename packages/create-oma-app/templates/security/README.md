# Security Analysis Agent

A read-only security review of a local repository. Agents never receive shell or write tools, and reports are written only inside this generated project.

## No-key demo

```bash
npm install
npm run demo
```

The demo scans a bundled fixture with deterministic scripted model responses. It makes no model request and labels Markdown, JSON, and HTML output as simulated; OMA scheduling and report generation run locally for real.

## Real model run

For a Cloud scaffold, copy `.env.example` to `.env` and add the provider key first. For Ollama, start the local service and an installed model. Then run:

```bash
npm run dev -- --repo /path/to/repo
npm run dev -- --repo /path/to/repo --online-audit
```

The default scan is static and offline apart from the selected model provider. `--online-audit` explicitly opts into `npm audit --json --ignore-scripts`; it never installs dependencies or runs project scripts. Suspected secret values are redacted before evidence reaches any model.

Cloud mode sends redacted evidence to your configured model provider. Choose Ollama when repository evidence must stay local. Reports are written to `reports/` as Markdown, JSON, and an HTML DAG dashboard.
