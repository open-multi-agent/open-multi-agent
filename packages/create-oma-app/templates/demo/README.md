# Multi-agent DAG demo

This teaching starter turns one onboarding goal into a coordinator-generated task DAG.

## No-key demo

```bash
npm install
npm run demo
```

The demo uses deterministic scripted model responses, makes no model request, and labels its terminal output and dashboard as simulated. OMA still runs the coordinator path, task DAG, scheduler, aggregation, and dashboard locally for real.

## Real model run

For a Cloud scaffold, copy `.env.example` to `.env`, add the provider key, then run `npm run dev`.

For an Ollama scaffold, start Ollama first and run `npm run dev`. The starter selects `OMA_MODEL` when set, otherwise the first installed model. No source files are read and agents receive no tools.
