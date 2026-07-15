# Multi-agent DAG demo

This teaching starter turns one onboarding goal into a coordinator-generated task DAG.

```bash
npm install
cp .env.example .env # cloud runtime only
npm run dev
```

For an Ollama scaffold, start Ollama first. The starter selects `OMA_MODEL` when set, otherwise the first installed model. No source files are read and agents receive no tools.
