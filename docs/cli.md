# Command-line interface (`oma`)

The package ships a small binary **`oma`** that exposes the same primitives as the TypeScript API: `runTeam`, `runTasks`, plus a static provider reference. It is meant for **shell scripts and CI** (JSON on stdout, stable exit codes).

It does **not** provide an interactive REPL, working-directory injection into tools, human approval gates, or session persistence. Those stay in application code.

## Installation and invocation

After installing the package, the binary is on `PATH` when using `npx` or a local `node_modules/.bin`:

```bash
npm install @jackchen_me/open-multi-agent
npx oma help
```

From a clone of the repository you need a build first:

```bash
npm run build
node dist/cli/oma.js help
```

Set the usual provider API keys in the environment (see [README](../README.md#quick-start)); the CLI does not read secrets from flags. MiniMax additionally reads `MINIMAX_BASE_URL` to select the global (`https://api.minimax.io/v1`) or China (`https://api.minimaxi.com/v1`) endpoint.

---

## Commands

### `oma run`

Runs **`OpenMultiAgent.runTeam(team, goal)`**: coordinator decomposition, task queue, optional synthesis.

| Argument | Required | Description |
|----------|----------|-------------|
| `--goal` | Yes | Natural-language goal passed to the team run. |
| `--team` | Yes | Path to JSON (see [Team file](#team-file)). |
| `--orchestrator` | No | Path to JSON merged into `new OpenMultiAgent(...)` after any orchestrator fragment from the team file. |
| `--coordinator` | No | Path to JSON passed as `runTeam(..., { coordinator })` (`CoordinatorConfig`). |

Global flags: [`--pretty`](#output-flags), [`--include-messages`](#output-flags).

### `oma task`

Runs **`OpenMultiAgent.runTasks(team, tasks)`** with a fixed task list (no coordinator decomposition).

| Argument | Required | Description |
|----------|----------|-------------|
| `--file` | Yes | Path to [tasks file](#tasks-file). |
| `--team` | No | Path to JSON `TeamConfig`. When set, overrides the `team` object inside `--file`. |

Global flags: [`--pretty`](#output-flags), [`--include-messages`](#output-flags).

### `oma provider`

Read-only helper for wiring JSON configs and env vars.

- **`oma provider`** or **`oma provider list`** — Prints JSON: built-in provider ids, API key environment variable names, whether `baseURL` is supported, and short notes (e.g. OpenAI-compatible servers, Copilot in CI).
- **`oma provider template <provider>`** — Prints a JSON object with example `orchestrator` and `agent` fields plus placeholder `env` entries. `<provider>` is one of: `anthropic`, `openai`, `gemini`, `grok`, `minimax`, `deepseek`, `copilot`.

Supports `--pretty`.

### `oma`, `oma help`, `oma -h`, `oma --help`

Prints usage text to stdout and exits **0**.

---

## Configuration files

Shapes match the library types `TeamConfig`, `OrchestratorConfig`, `CoordinatorConfig`, and the task objects accepted by `runTasks()`.

### Team file

Used with **`oma run --team`** (and optionally **`oma task --team`**).

**Option A — plain `TeamConfig`**

```json
{
  "name": "api-team",
  "agents": [
    {
      "name": "architect",
      "model": "claude-sonnet-4-6",
      "provider": "anthropic",
      "systemPrompt": "You design APIs.",
      "tools": ["file_read", "file_write"],
      "maxTurns": 6
    }
  ],
  "sharedMemory": true
}
```

**Option B — team plus default orchestrator settings**

```json
{
  "team": {
    "name": "api-team",
    "agents": [{ "name": "worker", "model": "claude-sonnet-4-6", "systemPrompt": "…" }]
  },
  "orchestrator": {
    "defaultModel": "claude-sonnet-4-6",
    "defaultProvider": "anthropic",
    "maxConcurrency": 3
  }
}
```

Validation rules enforced by the CLI:

- Root (or `team`) must be an object.
- `team.name` is a non-empty string.
- `team.agents` is a non-empty array; each agent must have non-empty `name` and `model`.

Any other fields are passed through to the library as in TypeScript.

### Tasks file

Used with **`oma task --file`**.

```json
{
  "orchestrator": {
    "defaultModel": "claude-sonnet-4-6"
  },
  "team": {
    "name": "pipeline",
    "agents": [
      { "name": "designer", "model": "claude-sonnet-4-6", "systemPrompt": "…" },
      { "name": "builder", "model": "claude-sonnet-4-6", "systemPrompt": "…" }
    ],
    "sharedMemory": true
  },
  "tasks": [
    {
      "title": "Design",
      "description": "Produce a short spec for the feature.",
      "assignee": "designer"
    },
    {
      "title": "Implement",
      "description": "Implement from the design.",
      "assignee": "builder",
      "dependsOn": ["Design"]
    }
  ]
}
```

- **`dependsOn`** — Task titles (not internal ids), same convention as the coordinator output in the library.
- Optional per-task fields: `memoryScope` (`"dependencies"` \| `"all"`), `maxRetries`, `retryDelayMs`, `retryBackoff`.
- **`tasks`** must be a non-empty array; each item needs string `title` and `description`.

If **`--team path.json`** is passed, the file’s top-level `team` property is ignored and the external file is used instead (useful when the same team definition is shared across several pipeline files).

### Orchestrator and coordinator JSON

These files are arbitrary JSON objects merged into **`OrchestratorConfig`** and **`CoordinatorConfig`**. Function-valued options (`onProgress`, `onApproval`, etc.) cannot appear in JSON and are not supported by the CLI.

---

## Output

### Stdout

Every invocation prints **one JSON document** to stdout, followed by a newline.

**Successful `run` / `task`**

```json
{
  "command": "run",
  "success": true,
  "totalTokenUsage": { "input_tokens": 0, "output_tokens": 0 },
  "agentResults": {
    "architect": {
      "success": true,
      "output": "…",
      "tokenUsage": { "input_tokens": 0, "output_tokens": 0 },
      "toolCalls": [],
      "structured": null,
      "loopDetected": false,
      "budgetExceeded": false
    }
  }
}
```

`agentResults` keys are agent names. When an agent ran multiple tasks, the library merges results; the CLI mirrors the merged `AgentRunResult` fields.

**Errors (usage, validation, I/O, runtime)**

```json
{
  "error": {
    "kind": "usage",
    "message": "--goal and --team are required"
  }
}
```

`kind` is one of: `usage`, `validation`, `io`, `runtime`, or `internal` (uncaught errors in the outer handler).

### Output flags

| Flag | Effect |
|------|--------|
| `--pretty` | Pretty-print JSON with indentation. |
| `--include-messages` | Include each agent’s full `messages` array in `agentResults`. **Very large** for long runs; default is omit. |

There is no separate progress stream; for rich telemetry use the TypeScript API with `onProgress` / `onTrace`.

---

## Exit codes

| Code | Meaning |
|------|---------|
| **0** | Success: `run`/`task` finished with `success === true`, or help / `provider` completed normally. |
| **1** | Run finished but **`success === false`** (agent or task failure as reported by the library). |
| **2** | Usage, validation, readable JSON errors, or file access issues (e.g. missing file). |
| **3** | Unexpected error, including typical LLM/API failures surfaced as thrown errors. |

In scripts:

```bash
npx oma run --goal "Summarize README" --team team.json > result.json
code=$?
case $code in
  0) echo "OK" ;;
  1) echo "Run reported failure — inspect result.json" ;;
  2) echo "Bad inputs or files" ;;
  3) echo "Crash or API error" ;;
esac
```

---

## Argument parsing

- Long options only: `--goal`, `--team`, `--file`, etc.
- Values may be attached with `=`: `--team=./team.json`.
- Boolean-style flags (`--pretty`, `--include-messages`) take no value; if the next token does not start with `--`, it is treated as the value of the previous option (standard `getopt`-style pairing).

---

## Limitations (by design)

- No TTY session, history, or `stdin` goal input.
- No built-in **`cwd`** or metadata passed into `ToolUseContext` (tools use process cwd unless the library adds other hooks later).
- No **`onApproval`** from JSON; non-interactive batch only.
- Coordinator **`runTeam`** path still requires network and API keys like any other run.

