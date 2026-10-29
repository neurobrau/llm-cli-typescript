# NeuroBräu TypeScript

TypeScript edition of the NeuroBräu LLM CLI. The current version is `0.2.0-dev` (work toward the interactive chat milestone); the completed CLI Foundation milestone was `0.1.0`. It can send **one non-streaming one-shot prompt** to **OpenAI** (Responses API, official `openai` SDK 7.45.0) or to a **local Ollama server** (native HTTP API, no extra dependency) and print the answer. There is no chat, streaming, history, saved settings, pricing, or TUI yet. Conversation, `active.json`, settings and usage-record JSON formats now have pure codecs with Python-compatible canonical output (`docs/storage.md`), and an internal filesystem layer (`src/storage/fs/`: injected XDG paths, atomic owner-only writes, history, active selection and settings stores) exists, but it is not connected to the CLI: no command reads or writes history or settings, and the CLI never touches those files. No Git tag or release exists for any version.

## Prerequisites

- Node.js 24 (`engines.node` is `>=24 <25`; `.node-version` pins the major).
- npm (bundled with Node). The single lockfile is `package-lock.json`.

## Install and build

```sh
npm ci
npm run build
```

`npm run build` cleans `dist/` and `.test-dist/` and compiles `src/` with `tsc` to ordinary ESM JavaScript. `src/cli.ts` becomes `dist/cli.js`. Nothing is installed globally and no `PATH` or shell profile changes are needed.

## Usage

```sh
node dist/cli.js                    # help (same as --help)
node dist/cli.js --help             # or -h
node dist/cli.js --version          # NeuroBräu TypeScript CLI 0.2.0-dev
export OPENAI_API_KEY=...           # read only when a prompt is sent
node dist/cli.js "What is a neural network?"
node dist/cli.js --provider ollama "What is a neural network?"   # first local model, no key
```

```text
neurobrau [--provider openai|ollama] [--model MODEL_ID]
          [--reasoning-effort EFFORT] [--max-output-tokens N]
          [--answer-style brief|normal|detailed] [--usage] "prompt"
```

- Defaults: provider `openai`, model `gpt-6-luna` (the project default; any model ID may be given with `--model` and is not checked against the live Models API), answer style `normal`. With `--provider ollama` the default model is the first selectable local model in Ollama's `/api/tags` order.
- `EFFORT` is `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `model-default` (send no effort; the model uses its own default). Without the flag, `none` is sent where the dated compatibility table confirms it, otherwise nothing.
- Exactly one nonblank prompt is required; options may come before or after it, and `--` ends option parsing. The prompt is sent exactly as given.
- One-shot uses flags and built-in defaults only: saved settings and history are neither read nor written.
- Output: the answer on stdout with a final newline (exit 0). `--usage` prints `Token usage: input=N, output=N, total=N` on stderr, listing only counts the API reported (or `not reported`). An incomplete answer prints the partial text, a warning on stderr, and exits 8. Failures print `neurobrau: error: …` on stderr: 1 API/other, 2 invalid settings or arguments, 3 missing key, 4 authentication, 5 rate limit, 6 timeout, 7 connection. Ctrl+C during a request prints `neurobrau: interrupted` and exits 130. A stdout closed by the reader exits quietly with 141.
- Ollama: `OLLAMA_HOST` (`host`, `host:port`, `[v6]:port` or an http(s) URL with an optional path prefix; default `http://127.0.0.1:11434`; `0.0.0.0` and `::` mean loopback) is read only when Ollama is selected. Userinfo, queries, fragments and other schemes are rejected (exit 2). No key is needed and `OPENAI_API_KEY` is never read. Requests ignore proxy environment variables. Only locally installed chat models are used: `:cloud`/`-cloud` models are refused, a missing model reports `ollama pull <model>` (never run for you; nothing is downloaded). Reasoning is off (`think:false`) by default on models that support switching it; `--reasoning-effort` maps to the model's off/on or named levels, and `model-default` is available only on named-level models. `--max-output-tokens` is checked against the model's reported context length (a conservative project ceiling, not a documented output limit). Reasoning text is never printed. An empty answer is valid. Timeouts: 300 s for chat (model loading), 3 s for tags/show.
- Requests to OpenAI use `store: false`. This is not a zero-data-retention guarantee.
- Timeouts: 60 s per generation request (including reading the response body). The SDK's automatic retries are disabled; the only retry is the narrow implicit-reasoning fallback described in `docs/architecture.md`.

Invalid invocations exit 2 before any key lookup or network use:

| Input | Result |
| --- | --- |
| unknown option | `unknown option` |
| `--stream`, `--plain`, `--no-history`, `--transcript-on-exit` | `unsupported option … not implemented yet` |
| an unknown provider (anything but `openai`/`ollama`) | `invalid provider … expected openai or ollama` |
| an invalid `OLLAMA_HOST` (only with `--provider ollama`) | `Invalid OLLAMA_HOST: …` |
| empty or blank prompt, or more than one positional | prompt error |
| generation options without a prompt | `a prompt is required when generation options are given` |
| `--help` / `--version` together, or with any other argument | `conflicting options` / `invalid invocation` |
| `--version=foo`, a missing or repeated option value | `invalid argument` |
| invalid effort, style, provider, or token count (not a positive safe integer) | named diagnostic |
| an effort or limit the model is known not to support | settings error from the resolver |

Repeated identical `--help`, `--version` and `--usage` switches are idempotent. A value for `--model` and similar options that starts with `-` must use the `--option=value` form.

### Manual smoke test (owner-run, makes real, billable requests)

Not run by the agent or the test suite:

```sh
export OPENAI_API_KEY=...   # your real key
node dist/cli.js "Reply with the single word: ok"
node dist/cli.js --usage --max-output-tokens 16 "Count from 1 to 100"      # likely incomplete, exit 8
node dist/cli.js --reasoning-effort model-default --usage "Say hello"
node dist/cli.js --model no-such-model "hi"                                # API error, exit 1
OPENAI_API_KEY= node dist/cli.js "hi"                                      # missing key, exit 3
```

### Manual Ollama smoke test (owner-run, local inference)

Not run by the agent or the test suite (they use mock servers only). Requires a running Ollama and an installed model:

```sh
ollama pull qwen3.5:4b                      # you run this, once
node dist/cli.js --provider ollama "Reply with the single word: ok"      # first local model
node dist/cli.js --provider ollama --model qwen3.5:4b --usage "Reply with the single word: ok"
node dist/cli.js --provider ollama --model qwen3.5:4b --reasoning-effort high --usage "What is 17 * 23?"
node dist/cli.js --provider ollama --model qwen3.5:4b --reasoning-effort none --max-output-tokens 16 "Count from 1 to 100"   # likely incomplete, exit 8
node dist/cli.js --provider ollama --model no-such-model:1b "hi"       # not installed, exit 1, prints the pull hint
node dist/cli.js --provider ollama --model glm-4.7:cloud "hi"          # cloud model refused, exit 1
OLLAMA_HOST=127.0.0.1:1 node dist/cli.js --provider ollama "hi"        # connection refused, exit 7
```

The installed SDK also reads `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_CUSTOM_HEADERS` from the environment; the adapter overrides the first three and drops non-SDK request headers, so none of them affects requests.

## Checks

| Command | Purpose |
| --- | --- |
| `npm run build` | clean, then compile `src/` to `dist/` |
| `npm run typecheck` | strict type check of `src/` and `tests/` (no emit) |
| `npm run lint` | ESLint (flat config, type-aware `typescript-eslint`) |
| `npm test` | build, compile tests to `.test-dist/`, run them with `node:test` |
| `npm run check` | typecheck, lint, then `npm test` (build included) |
| `npm run test:parity` | optional: storage codecs against the read-only Python reference (needs Python; exits 3 = blocked when unavailable; not part of `check`) |

Tests include unit tests, runner tests with injected writers, and integration tests that spawn `dist/cli.js` with `process.execPath`, a sanitized environment, and temporary `HOME`/`XDG_*` directories. They contact only loopback mock servers (never OpenAI, never a real Ollama) and read no user data or credentials.

## Planned milestones

Connecting history and settings to the CLI, interactive chat, streaming, pricing, and a terminal UI come in later tasks (OpenAI and Ollama one-shot are done). Version plan: `0.1.0` completed CLI Foundation; `0.2.0-dev` while working on chat/history/streaming, `0.2.0` when that milestone is complete; `0.3.0-dev`/`0.3.0` for the TUI; `0.4.0-dev`/`0.4.0` for full parity. See `docs/architecture.md` and `docs/parity.md`.

## Working documents

- `AGENTS.md`: project rules for coding agents.
- `.agent-tasks/`: task specifications, prompts, and reports. Ignored by Git.
- `docs/`: durable architecture and parity decisions.
