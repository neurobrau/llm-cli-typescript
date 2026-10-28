# NeuroBräu TypeScript

TypeScript edition of the NeuroBräu LLM CLI. The current version, `0.1.0-dev`, can send **one non-streaming one-shot prompt to OpenAI** (Responses API, official `openai` SDK 7.45.0) and print the answer. There is no chat, streaming, Ollama, history, saved settings, pricing, or TUI yet. The version does not claim completion of milestone 0.1, which needs Ollama as well.

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
node dist/cli.js --version          # NeuroBräu TypeScript CLI 0.1.0-dev
export OPENAI_API_KEY=...           # read only when a prompt is sent
node dist/cli.js "What is a neural network?"
```

```text
neurobrau [--provider openai] [--model MODEL_ID]
          [--reasoning-effort EFFORT] [--max-output-tokens N]
          [--answer-style brief|normal|detailed] [--usage] "prompt"
```

- Defaults: provider `openai`, model `gpt-6-luna` (the project default; any model ID may be given with `--model` and is not checked against the live Models API), answer style `normal`.
- `EFFORT` is `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `model-default` (send no effort; the model uses its own default). Without the flag, `none` is sent where the dated compatibility table confirms it, otherwise nothing.
- Exactly one nonblank prompt is required; options may come before or after it, and `--` ends option parsing. The prompt is sent exactly as given.
- One-shot uses flags and built-in defaults only: saved settings and history are neither read nor written.
- Output: the answer on stdout with a final newline (exit 0). `--usage` prints `Token usage: input=N, output=N, total=N` on stderr, listing only counts the API reported (or `not reported`). An incomplete answer prints the partial text, a warning on stderr, and exits 8. Failures print `neurobrau: error: …` on stderr: 1 API/other, 2 invalid settings or arguments, 3 missing key, 4 authentication, 5 rate limit, 6 timeout, 7 connection. Ctrl+C during a request prints `neurobrau: interrupted` and exits 130. A stdout closed by the reader exits quietly with 141.
- Requests use `store: false`. This is not a zero-data-retention guarantee.
- Timeouts: 60 s per generation request (including reading the response body). The SDK's automatic retries are disabled; the only retry is the narrow implicit-reasoning fallback described in `docs/architecture.md`.

Invalid invocations exit 2 before any key lookup or network use:

| Input | Result |
| --- | --- |
| unknown option | `unknown option` |
| `--stream`, `--plain`, `--no-history`, `--transcript-on-exit` | `unsupported option … not implemented yet` |
| `--provider ollama` | `unsupported provider "ollama"` |
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

The installed SDK also reads `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_CUSTOM_HEADERS` from the environment; the adapter overrides the first three and drops non-SDK request headers, so none of them affects requests.

## Checks

| Command | Purpose |
| --- | --- |
| `npm run build` | clean, then compile `src/` to `dist/` |
| `npm run typecheck` | strict type check of `src/` and `tests/` (no emit) |
| `npm run lint` | ESLint (flat config, type-aware `typescript-eslint`) |
| `npm test` | build, compile tests to `.test-dist/`, run them with `node:test` |
| `npm run check` | typecheck, lint, then `npm test` (build included) |

Tests include unit tests, runner tests with injected writers, and integration tests that spawn `dist/cli.js` with `process.execPath`, a sanitized environment, and temporary `HOME`/`XDG_*` directories. They make no network requests and read no user data or credentials.

## Planned milestones

Ollama, interactive chat, history and settings storage, streaming, pricing, and a terminal UI come in later tasks (OpenAI one-shot is done); see `docs/architecture.md` and `docs/parity.md`.

## Working documents

- `AGENTS.md`: project rules for coding agents.
- `.agent-tasks/`: task specifications, prompts, and reports. Ignored by Git.
- `docs/`: durable architecture and parity decisions.
