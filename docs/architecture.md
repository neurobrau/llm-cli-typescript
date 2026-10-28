# Architecture

Status: `0.1.0` (CLI Foundation milestone: non-streaming OpenAI and Ollama one-shot). No tag or release has been created or published.

## CLI composition

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | Executable entry. The only top-level process wiring: wraps `process.stdout`/`stderr` into async writers, calls `run`, assigns `process.exitCode`. |
| `src/main.ts` | `run(argv, io)` returns an exit code. Writers are injected; it never calls `process.exit()`. Maps `EPIPE` to 141 and other output failures to 1. |
| `src/args.ts` | Pure parsing of argv into `help`, `version`, or `error`. No I/O, no throwing for user input. |
| `src/help.ts` | Deterministic help, version, and usage-hint text. |
| `src/version.ts` | Reads `package.json` (the sole version authority), found relative to the module location, never `process.cwd()`. |

Importing any non-entry module prints nothing and registers no listeners; the version file is read only when `run` needs it. The writer in `cli.ts` awaits each write (backpressure) and installs an `error` listener that only records the failure, because an unhandled stream `error` event would otherwise crash the process before the exit code can be set. SIGINT keeps its default OS behavior.

## Argument parsing

`node:util` `parseArgs` runs in non-strict token mode; the parser then classifies tokens itself. This gives the required distinct diagnostics (unknown vs. deliberately unsupported future options, values on boolean flags, conflicts) that strict mode would collapse into one error. Options of the Python/Go editions that are not implemented yet (`--stream`, `--plain`, …) are listed explicitly and rejected rather than ignored.

## ESM, compiler, and tests

- Native ESM (`"type": "module"`), TypeScript `module`/`moduleResolution` `NodeNext`, explicit `.js` relative specifiers, target `ES2023`, source maps, no bundler.
- `tsconfig.json` compiles `src/` only (`rootDir: src`, so `dist/cli.js`). `tsconfig.test.json` compiles `src/` and `tests/` into `.test-dist/`. Both are strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, …) and `typecheck` covers both.
- Tests use `node:test` and `node:assert/strict`. `scripts/run-tests.mjs` passes an explicit file list to `node --test` and fails when none exist, because an empty glob otherwise succeeds. Integration tests run the emitted `dist/cli.js`.
- Because the test tree is emitted one level deeper (`.test-dist/src/`), `version.ts` walks up to the nearest `package.json` instead of using a fixed relative path.
- ESLint uses a flat config with `typescript-eslint` strict type-checked and stylistic rules. `no-floating-promises` applies to tests as well. `describe()`/`it()` registrations return runner-tracked promises, so they are marked with the `void` operator; promises inside test bodies stay checked.

## Domain contracts and settings resolution (Task 002)

Used by the one-shot path below.

- `src/domain/generation.ts`: `Message`, `TokenUsage`, `GenerationRequest` (immutable snapshot via `snapshotRequest`), `GenerationOutcome` (`completed` | `incomplete`), `StreamEvent` (text, reasoning, completed, incomplete, failed).
- `src/domain/errors.ts`: `ProviderError` with kinds api(1), missing_api_key(3), authentication(4), rate_limit(5), timeout(6), connection(7); `SettingsError` (exit 2 at the future CLI boundary); `AbortError` helpers (cancellation, 130, is never a `ProviderError`). Messages given to `ProviderError` must already be safe: adapters must normalize and redact upstream text.
- `src/domain/provider.ts`: `Provider` interface. Every async method takes an `AbortSignal`; `generate` returns a `GenerationOutcome`, `stream` returns an `AsyncIterable<StreamEvent>`.
- `src/domain/settings.ts` and `src/application/resolve-settings.ts`: `resolveSettings(input)` is pure (no I/O, environment, cache or mutation). Capabilities and saved preferences are supplied by the caller.

**Counts are `bigint`.** Absent means not reported, `0n` reported zero; counts are never estimated. The only derived value is an adapter's exact sum of two reported counts (Ollama's total); OpenAI's absent total stays absent. Counts above 2^53 stay exact. No JSON codec exists yet.

**Stream lifecycle.** Full consumption yields deltas and exactly one terminal event, then ends. Early `return()` releases resources without a terminal event. Cancellation throws `AbortError` (also for an already-aborted signal) and never invents usage. No production stream validator exists yet.

**Provenance and model default.** Each resolved setting records `source` (`cli`, `saved`, `builtin`) and `explicit`. Reasoning `effort` absent means the parameter is omitted; with `explicit: true` that is the user's "model default" choice (Go-style provenance), not a lost bit. A built-in default (`explicit: false`, e.g. `none`) may later be retried without the parameter if rejected; a user choice must not be dropped. Saved max tokens `null` is an explicit model default (omitted but `explicit: true`); absent is a built-in omission. Precedence: CLI, saved, built-in; a successful CLI value produces no notice about the overridden saved value. Strict mode throws `SettingsError` for unusable CLI values; lenient mode adds a notice and falls back to the saved value, then the built-in one.

**Test-only fake.** `tests/helpers/fake-provider.ts` implements `Provider` with scripted outcomes and events, deferred-promise gates and abort-listener accounting. It is not a production module.

## OpenAI one-shot (Task 003)

`src/providers/openai/`:

| File | Responsibility |
| --- | --- |
| `sdk.ts` | The only importer of the `openai` SDK (7.45.0, the sole production dependency). Exposes SDK-free `createResponse`/`listModels` returning decoded bodies, and `describeSdkError` (SDK error to plain `SdkFailure`). |
| `convert.ts` | `buildParams` (request to API body) and `convertResponse` (raw `unknown` body to `GenerationOutcome`, validated field by field, no casts of wire data). |
| `errors.ts` | `SdkFailure` to `ProviderError`, fixed/sanitized messages, `rejectsReasoning`. |
| `capabilities.ts` | Dated project compatibility table (copied from the Python reference; Go is identical), snapshot suffix lookup, non-text model markers, default model. |
| `provider.ts` | `OpenAIProvider`: all six `Provider` methods. |

`src/main.ts` runs the one-shot flow (`defaultModel`, `getCapabilities`, strict `resolveSettings` with empty saved preferences, `generate`) and maps outcomes to output and exit codes. `src/process-io.ts` holds the writer and SIGINT wiring; `src/cli.ts` is the production composition and the only place that reads `OPENAI_API_KEY` (lazily, through a `getApiKey` callback the provider invokes when an operation runs).

**SDK configuration.** Client created lazily on the first operation; explicit `maxRetries: 0`; base URL, organization, project, admin key, webhook secret and log level set explicitly so ambient `OPENAI_*` variables are not inherited. The SDK still reads `OPENAI_CUSTOM_HEADERS` from the environment and has no option to disable it (checked in 7.45.0), so the adapter's `fetch` wrapper rebuilds request headers from an allowlist (SDK-set headers only). `baseURL` and `fetch` are programmatic test seams, not flags or environment variables.

**Request.** `POST /responses` with `model`, `input` (ordered user/assistant text), `store: false`, and, only when chosen, `instructions`, `reasoning: {effort}` and `max_output_tokens`. No tools, background, conversation IDs, `previous_response_id`, cache retention or temperature. `store: false` is not a zero-retention promise.

**Response policy.** Answer text is the ordered `output_text` parts of message items (never reasoning, tool or refusal content), preserved exactly. `completed` with text: completed. `incomplete`: incomplete outcome (partial text, usage, tier; reasons translated as in the references). Refusal without text, completed with empty text, `failed`, `cancelled`, `queued`, `in_progress`, missing/unknown status, and malformed payloads: API error. Usage counts are accepted only as non-negative safe integers and become `bigint`; fractional, negative, non-numeric and beyond-2^53 values are treated as not reported, because the SDK has already decoded JSON into rounded numbers and `BigInt(number)` cannot restore them. No totals are synthesized.

**Errors.** 401/403 authentication (4), 429 rate limit (5), 408 or SDK timeout (6), connection failure (7), everything else API (1). Local abort wins over every classification and always becomes `AbortError`, whatever `signal.reason` was. The adapter's own deadline timer also covers reading the response body; a deadline expiry is a timeout, not a cancellation.

**Implicit reasoning fallback.** The only semantic retry: a concrete built-in (non-explicit) effort rejected with HTTP 400 whose structured `error.param` is `reasoning` or a `reasoning.` subfield is retried once with the field omitted (cancellation checked first; everything else identical). The model is then remembered in that provider instance: later implicit calls omit reasoning and `getCapabilities` reports known/no values, but a later explicit choice is still sent and its rejection reported. Generic 400s, messages mentioning "reasoning", 401/429/5xx, timeouts and connection failures are never retried.

**Cancellation.** The caller's signal is combined with a deadline in a per-call controller; its listener and timer are removed in `finally`. The signal is rechecked after every await before conversion, cache writes or fallback. `SIGINT` is registered only while a prompt runs (`InterruptSource`), aborts the request, waits at most 2 s for it to settle, prints `neurobrau: interrupted`, and exits 130.

**Discovery.** `listModels` (5 s timeout, no retries) reads the Models endpoint's single unpaginated list, keeps valid non-empty IDs without the non-text markers, deduplicates, sorts and caches only successes per provider instance. `checkAvailability` reuses it. Neither is used by one-shot. There is no CLI surface for discovery.

**Streaming** is not implemented: `stream()` lazily yields one normalized failed event ("OpenAI streaming is not implemented yet.") without key access or network. Multi-turn reasoning-item replay needs a separate design; the domain and history models are unchanged.

## Ollama one-shot (Task 004)

`src/providers/redact.ts` (`safeText`, shared by both adapters) and `src/providers/ollama/`:

| File | Responsibility |
| --- | --- |
| `host.ts` | Pure `OLLAMA_HOST` normalization (`resolveBaseUrl`). Throws `SettingsError` (exit 2) with fixed messages that never echo the value. |
| `transport.ts` | One JSON exchange over `node:http`/`node:https` with a fresh non-proxy agent, one deadline covering connect, headers and body, no redirects, no retries, a 32 MiB body cap, and single-shot cleanup of request, socket, agent, timer and abort listener. |
| `parse.ts` | Validation of `/api/tags`, `/api/show` and `/api/chat` replies from `unknown`; leading think-block splitting; exact usage counts. |
| `thinking.ts` | `reasoningSupport` (metadata to `ReasoningSupport`) and `thinkField` (resolved effort to the wire `think` value). |
| `provider.ts` | `OllamaProvider`: all six `Provider` methods; instance-local caches. |

**Composition.** `createProvider(id)` builds only the selected provider. `src/cli.ts` reads `OLLAMA_HOST` only when `--provider ollama` runs a prompt, and `OPENAI_API_KEY` only when OpenAI performs an operation; neither inspects the other. A `SettingsError` from the factory (bad `OLLAMA_HOST`) exits 2. `run()` without a factory refuses Ollama so no composition can reach a real server by accident.

**Transport and proxies.** The native endpoints `GET /api/tags`, `POST /api/show` and `POST /api/chat` only; never pull/create/delete/copy/push and never an OpenAI-compatible route. Every request uses its own `http.Agent`/`https.Agent`, so `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NODE_USE_ENV_PROXY` and `NO_PROXY` never apply and no global dispatcher is touched (a test shows Node's global agent would use them). This applies to non-loopback `OLLAMA_HOST` values too: Ollama traffic is always direct, and no cloud endpoint, credential or proxy-auth feature exists. Timeouts: 300 s chat, 3 s tags/show; local abort always becomes `AbortError`, a deadline is kind `timeout` (6), refused/reset/truncated-body is `connection` (7), everything else (HTTP status, invalid JSON, `error` replies, wrong shapes) is `api` (1). Diagnostics are `safeText` (controls stripped, one line, 300 characters); headers, bodies, prompts and URL paths are never printed.

**Discovery.** `/api/tags` order is preserved and the default is the first *selectable* model. A model is remote with `remote_host`/`remote_model` or a `cloud`/`-cloud` tag; cloud-like IDs are refused before any request, remote entries before show/chat. Capabilities that are reported but lack `completion` make a model non-selectable, and an explicit request for one is refused. Unreported capabilities stay eligible and are checked through `/api/show` before chat. An explicit model must be installed: a miss refreshes tags once, then reports `ollama pull <model>` (never executed; no `:latest`, case or alias changes). Successful discoveries and `/api/show` replies are cached per provider instance (a refresh drops show data of models whose entry changed); failed or cancelled work is never cached. Concurrent use of one instance is not supported yet.

**Reasoning.** Tags capabilities win when reported; otherwise show capabilities. `thinking.values` booleans become `off`/`on`, strings named levels (deduplicated, order kept); `thinking.default` is display metadata (`modelDefault`). The `thinking` capability without values uses the legacy off/on pair; `[false]` means no thinking support; confirmed capabilities without `thinking` mean none; nothing reported means unknown (nothing is sent unless the user chose a value, which then passes through: `none`/`off`→`false`, `on`→`true`, anything else as that exact string). Off/on models default to off (`think:false` is really sent) and have no selectable model default; named-level models may use the explicit model default, which omits `think` (Go behavior, not Python's `false`). Wire mapping: off/none→false, on→true, level→string, model default→omitted.

**Output ceiling.** `details.context_length` from tags is the project's validation ceiling for `num_predict`, not a separately reported maximum output size; with no such field the ceiling is unknown. Nothing is inferred from other fields.

**Request and reply.** Body: `model`, `messages` (an `instructions` string becomes a leading `system` message for this request only), `stream:false`, optional `think`, optional `options.num_predict`. No `keep_alive`, `num_ctx` or other fields. A reply needs `message.content` as a string and `done:true`; `done_reason:"length"` is `incomplete` (even with no text), everything else completed; an empty completed answer is allowed (Ollama may spend a budget on thinking; OpenAI treats it as an error). `message.thinking` and a complete leading `<think>…</think>` block are kept as reasoning, not answer; later tags stay in the answer. An unterminated leading think block is never returned as an answer: it is an API error, or incomplete with empty text if `length`. Usage: `prompt_eval_count`/`eval_count` as exact `bigint` input/output when non-negative safe integers; the total is their exact sum only when both are reported (derived, not an estimate).

**Streaming** is still not implemented: `stream()` lazily yields one failed event, with no discovery or network.

## Versioning

`package.json` is the only version authority at runtime; `package-lock.json` must agree (tested). The version changes when a milestone is entered or completed, not silently left alone. Completing a milestone is separate from tagging or publishing it.

| Stage | Version |
| --- | --- |
| Completed CLI Foundation (OpenAI + Ollama non-streaming) | 0.1.0 |
| Work on chat/history/streaming | 0.2.0-dev |
| Completed interactive chat milestone | 0.2.0 |
| TUI development / completed TUI | 0.3.0-dev / 0.3.0 |
| Full parity development / completed milestone | 0.4.0-dev / 0.4.0 |

Patch releases of a completed milestone (0.1.x) require owner approval.

## Future separation

Planned, created only when real code needs them: `src/domain/` (messages, usage, settings), `src/providers/` (OpenAI/Ollama adapters), `src/application/` (engine, sessions, request lifecycle with `AbortController`), `src/storage/` (codecs, paths, atomic writes), `src/ui/`, `src/pricing/`. Domain code will not import provider SDKs, the filesystem, or a TUI. See `docs/architecture-roadmap.md` for the full analysis.

## TUI

Undecided. The choice (Ink, Blessed, a custom ANSI renderer, …) waits for a focused spike on Node 24 and Ptyxis covering keyboard handling (F-keys, paging), resize, and terminal restoration on signals. No TUI dependency is installed.

## References

Read-only sibling projects, analyzed at these snapshots:

- Python: `0a6d045c022b850371a1c51a1df30f11d9d4c60e`
- Go: `b064decc66cad7d9656488bdf7749650b52cf309`
