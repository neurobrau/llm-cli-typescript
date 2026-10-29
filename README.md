# NeuroBräu TypeScript

TypeScript edition of the NeuroBräu LLM CLI. The current version is `0.2.0-dev` (work toward the interactive chat milestone); the completed CLI Foundation milestone was `0.1.0`. It can send **one non-streaming one-shot prompt** to **OpenAI** (Responses API, official `openai` SDK 7.45.0) or to a **local Ollama server** (native HTTP API, no extra dependency) and print the answer, and, without a prompt, it runs a **non-streaming line-oriented chat** (`YOU >` / `AI >`) on the same providers that restores and saves conversations, applies saved settings and understands `/help`, `/reset`, `/cleanup`, `/usage` and `/exit`. There is no streaming, pricing or cost estimate, provider/model switching, or fullscreen TUI yet. Conversation, `active.json`, settings and usage-record JSON follow the Python reference formats (`docs/storage.md`). No Git tag or release exists for any version.

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
node dist/cli.js                    # plain chat (continues the last conversation)
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
neurobrau [same options] [--plain] [--no-history]          # chat: no prompt
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
| `--stream`, `--transcript-on-exit` | `unsupported option … not implemented yet` |
| `--plain` or `--no-history` together with a prompt | `option … cannot be used with a prompt` (exit 2, before any provider, key, file or network use) |
| an unknown provider (anything but `openai`/`ollama`) | `invalid provider … expected openai or ollama` |
| an invalid `OLLAMA_HOST` (only with `--provider ollama`) | `Invalid OLLAMA_HOST: …` |
| empty or blank prompt, or more than one positional | prompt error |
| `--help` / `--version` together, or with any other argument | `conflicting options` / `invalid invocation` |
| `--version=foo`, a missing or repeated option value | `invalid argument` |
| invalid effort, style, provider, or token count (not a positive safe integer) | named diagnostic |
| an effort or limit the model is known not to support | settings error from the resolver |

Repeated identical `--help`, `--version` and `--usage` switches are idempotent. A value for `--model` and similar options that starts with `-` must use the `--option=value` form.

### Manual chat smoke test (owner-run, local Ollama, isolated state)

Not run by the agent or the test suite. It uses a throw-away directory for HOME and the XDG trees, so your real conversations are neither listed nor deleted, and needs no OpenAI key. It assumes `qwen3.5:4b` is installed. Run the lines in order in one shell:

```sh
S=$(mktemp -d)                                  # remove it yourself when finished: rm -r "$S"
run() { env -u OPENAI_API_KEY HOME="$S/home" XDG_STATE_HOME="$S/state" XDG_CONFIG_HOME="$S/config" node dist/cli.js "$@"; }

# 1. two turns, then exit (the second answer should use the first for context)
printf 'My name is Ada. Reply with one word.\nWhat is my name? Reply with one word.\n/exit\n' | run --provider ollama --model qwen3.5:4b --usage

# 2. restart without flags: restores the conversation (shows the "Restored conversation" notice)
printf 'And what did I ask you first? Reply briefly.\n/usage\n/exit\n' | run
find "$S/state" -type f | sort                  # one conversation file and active.json; modes 600/700

# 3. /reset keeps the old file and saves a fresh empty one
printf '/reset\n/usage\n/exit\n' | run
find "$S/state" -name '*.json' | wc -l          # now 3 files (2 conversations + active.json)

# 4. an intentionally incomplete reply (tiny output limit): partial text, warning, chat continues
printf 'Count from 1 to 100.\n/usage\n/exit\n' | run --provider ollama --model qwen3.5:4b --max-output-tokens 8 --reasoning-effort none --usage

# 5. --no-history: touches nothing under the state tree
find "$S/state" -type f | sort > "$S/before.txt"
printf 'Say hi.\n/exit\n' | run --no-history --provider ollama --model qwen3.5:4b
find "$S/state" -type f | sort | diff - "$S/before.txt" && echo unchanged

# 6. cleanup with confirmation (only the isolated tree is listed and deleted)
printf '/cleanup\nno\n/cleanup\nyes\n/exit\n' | run --provider ollama --model qwen3.5:4b
find "$S/state" -type f | sort                  # only active.json remains
```

Optional, only if you want to try OpenAI yourself (real, billable requests; uses the same isolated tree):

```sh
export OPENAI_API_KEY=...   # your real key
printf 'Reply with the single word: ok\n/usage\n/exit\n' | run --provider openai --usage
```

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
| `npm run test:parity` | optional: storage codecs and TS chat sessions against the read-only Python reference (needs Python; exits 3 = blocked when unavailable; not part of `check`) |

Tests include unit tests, runner tests with injected writers, and integration tests that spawn `dist/cli.js` with `process.execPath`, a sanitized environment, and temporary `HOME`/`XDG_*` directories. They contact only loopback mock servers (never OpenAI, never a real Ollama) and read no user data or credentials.

## Planned milestones

Streaming, pricing and cost estimates, provider/model switching and a terminal UI come in later tasks (OpenAI and Ollama one-shot and the plain chat with history are done). Version plan: `0.1.0` completed CLI Foundation; `0.2.0-dev` while working on chat/history/streaming, `0.2.0` when that milestone is complete; `0.3.0-dev`/`0.3.0` for the TUI; `0.4.0-dev`/`0.4.0` for full parity. See `docs/architecture.md` and `docs/parity.md`.

## Working documents

- `AGENTS.md`: project rules for coding agents.
- `.agent-tasks/`: task specifications, prompts, and reports. Ignored by Git.
- `docs/`: durable architecture and parity decisions.
