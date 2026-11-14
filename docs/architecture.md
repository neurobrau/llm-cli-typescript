# Architecture

Status: `0.4.0` (the completed full-parity milestone: exact estimated API costs, Task 010, and the consolidated Python/Go/TypeScript compatibility gate and release audit, Task 011 — `docs/parity.md`, `docs/release-audit.md`; the pure `src/pricing/` module, `/usage` and the `COST (EST.)` panel, `docs/pricing.md`; no Git tag or release has been created). The previous completed milestone was `0.3.0` (the TUI milestone is complete after the owner smoke tests: the fullscreen chat, Task 008, and its menus with provider/model switching and saved preferences, Task 009; the `0.2.0` milestone — plain chat, history, streaming — was completed after the owner smoke tests). The completed CLI Foundation (`0.1.0`: non-streaming OpenAI and Ollama one-shot) is behavior-preserved; the plain chat with persistent history and read-only saved settings is connected (Task 006) and `--stream` is implemented for both providers and both front ends (Task 007). No tag or release has been created or published.

## CLI composition

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | Executable entry. The only top-level process wiring: wraps `process.stdout`/`stderr` into async writers, calls `run`, assigns `process.exitCode`. |
| `src/main.ts` | `run(argv, io, deps)` returns an exit code. Writers and every dependency are injected; it never calls `process.exit()`. Dispatches help/version/error, the one-shot prompt, and the chat. Maps `EPIPE` to 141 and other output failures to 1. |
| `src/io.ts` | Shared writer/interrupt contracts, exit-code constants and the output-failure wrapper. |
| `src/args.ts` | Pure parsing of argv into `help`, `version`, `prompt` (one-shot), `chat` or `error`. No I/O, no throwing for user input. The chat invocation keeps `provider` only when `--provider` was given. |
| `src/help.ts` | Deterministic help, version, and usage-hint text. |
| `src/version.ts` | Reads `package.json` (the sole version authority), found relative to the module location, never `process.cwd()`. |

Importing any non-entry module prints nothing and registers no listeners; the version file is read only when `run` needs it. The writer in `cli.ts` awaits each write (backpressure) and installs an `error` listener that only records the failure, because an unhandled stream `error` event would otherwise crash the process before the exit code can be set. SIGINT is handled only between `register` and the returned unregister call (one-shot run or chat run); the callback can fire repeatedly. Importing any module installs no listener.

## Argument parsing

`node:util` `parseArgs` runs in non-strict token mode; the parser then classifies tokens itself. This gives the required distinct diagnostics (unknown vs. deliberately unsupported future options, values on boolean flags, conflicts) that strict mode would collapse into one error. Options of the Python/Go editions that are not implemented yet (`--transcript-on-exit`) are listed explicitly and rejected rather than ignored.

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

**Stream lifecycle.** Full consumption yields deltas and exactly one terminal event, then ends. Early `return()` releases resources without a terminal event. Cancellation throws `AbortError` (also for an already-aborted signal) and never invents usage. The shared lifecycle lives in `src/providers/event-stream.ts` (below).

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

**Streaming** is implemented in Task 007 (see "Streaming" below). Multi-turn reasoning-item replay needs a separate design; the domain and history models are unchanged.

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

**Streaming** is implemented in Task 007 (see "Streaming" below).

## Storage codecs (Task 005A)

`src/storage/` holds pure codecs for conversations, `active.json`, `settings.json` and usage records: lossless integers (`bigint` from `JSON.parse` source lexemes), strict RFC 3339 timestamps, validation with typed `StorageCodecError`s, and Python-compatible canonical output. It imports nothing from Node (no fs, env, clock, network) and no provider uses it; the chat reaches it only through `src/application/`. Details, boundaries and the parity check: `docs/storage.md`.

## Filesystem storage (Task 005B)

`src/storage/fs/` is a separate, explicit entry point (`src/storage/fs/index.ts`) over `node:fs/promises`, `node:path` and `node:crypto`: injected XDG path resolution, one atomic writer (rename is the commit point), `HistoryStore` (conversations plus `active.json`), `SettingsStore` (an explicit load-before-save state machine) and UUID creation. Nothing runs at import or construction, the pure codecs never import it, and one-shot behavior never uses it. Per-instance write operations are serialized in invocation order; independent instances are last-writer-wins. See `docs/storage.md`.

## Plain chat, sessions and persistence (Task 006)

Layers (dependencies point downward; nothing below knows the layers above):

| Module | Responsibility |
| --- | --- |
| `src/chat/run-chat.ts` | One chat run: creates the input, registers the interrupt callback, calls startup, runs the loop, maps startup failures to the one-shot exit codes (3-7, 2, 1) and unexpected failures to a fixed message. |
| `src/chat/plain-chat.ts` | The loop and rendering (banner, `AI >`, warnings, commands, cleanup dialog, cancellation, bounded cleanup). Composes `provider.generate` with the session; the only place that prints. |
| `src/chat/commands.ts` | Pure command parsing and fixed texts. |
| `src/application/chat-startup.ts` | Path resolution, restore selection, provider creation, model default, settings load, saved-limit conversion and strict resolution. Returns warnings in order; writes nothing. |
| `src/application/session.ts` | `ChatSession`: committed messages, usage records, identity and persistence. Prints nothing, calls no provider, owns no clock/ID source. |
| `src/application/usage-report.ts` | Token-only report with bigint sums. |
| `src/line-input.ts` | `LineReader`: bounded, incremental UTF-8 line splitting over a stream it does not own. |

**Injection.** `run` takes `createProvider`, `createInput`, `storageEnvironment` (env + home), `clock`, `newId`, `createHistoryStore`, `createSettingsStore`, `checkProviderReady`, `interrupt` and `cleanupTimeoutMs`. Without them the defaults are inert: no input (immediate EOF), an environment without a home (history and settings disabled with warnings), and no real provider. Only `src/cli.ts` reads `process.env`, `homedir()`, `process.stdin` and wires SIGINT. The `SettingsPort` given to startup has no `save`; the chat cannot write settings.

**Session rules.** `messagesFor(text)` = committed messages plus the pending user message (never committed early). `applyCompleted` / `applyIncomplete` are synchronous in-memory commits; `persist`, `reset`, `cleanup` and `countSaved` are serialized in call order and awaited. Storage failures are returned as warnings and never undo memory; other exceptions propagate (bugs are not hidden). Snapshots copy messages, records, nested usage and Dates.

**Request lifecycle.** One request at a time. After the provider call returns, the loop checks `signal.aborted` and applies the commit in the same synchronous step, so a response that lost the race against an interrupt is discarded. Persistence then runs to completion before the answer is printed and before the chat can exit; an interrupt during it only requests the exit (130). After an interrupt the chat waits at most `cleanupTimeoutMs` for the provider to settle; a provider that ignores the abort ends the chat (130), and its late result can reach nothing because the commit happens in the loop. Lines that arrive meanwhile stay in the (paused, bounded) input and are processed in order; EOF never cancels an accepted request.

**Not implemented in the plain chat:** switching providers/models in a session (fullscreen only). Estimated costs appear in `/usage` (`src/pricing/`: bigint-only, pure, no I/O; computed from the stored usage records when the report or panel state is refreshed and never persisted).

## Streaming (Task 007)

`--stream` works for a one-shot prompt and for the plain chat, with OpenAI Responses and native Ollama. Nothing buffers a non-streaming result and splits it afterwards.

**Stream ownership (`src/providers/event-stream.ts`).** A provider supplies an `EventSource` (`pull()` does the I/O, `close()` aborts and releases) and `eventStream()` turns it into the `AsyncIterable<StreamEvent>` of the domain contract. The iterator is hand-written, not an async generator, because a generator's `return()` queues behind a pending `next()`; here `return()` closes the source first (which aborts the blocked network read) and then awaits the interrupted pull, which may reject with an AbortError. Properties: the request is snapshotted when `stream()` is called while key lookup, model discovery and all network I/O wait for the first `next()`; one `pull()` at a time (single consumer; a second concurrent `next()` is queued, not run in parallel); after the first terminal event the source is closed (HTTP response/SDK stream destroyed, timers cleared, listeners removed) and the iterator ends, so bytes after a terminal are never parsed; an abort of the caller's signal always surfaces as an AbortError (never a failed event, never `signal.reason`), taking precedence over a terminal event that arrives with it; a source that ends without a terminal event gets a synthesized API failure.

**Idle deadlines and backpressure.** The configured generation timeout (OpenAI 60 s, Ollama 300 s) is an *idle* deadline: an `IdleTimer` runs only while opening (connect + headers) and while waiting for the next SDK event or transport chunk, and is paused whenever the consumer or an output writer holds the turn. Granularity: one SDK event for OpenAI (the SDK exposes no byte-level progress); any received body chunk for Ollama, including a partial line. Timeout kind 6, connection 7 and caller-abort precedence are preserved. The SDK's own request `timeout` is passed only for the connect-and-headers phase (the installed SDK clears it when headers arrive, verified in `client.js` `fetchWithTimeout`), so it never becomes a second whole-stream deadline. Consumers await each stdout write and pull on demand; the Ollama transport reads the socket only while a pull waits (the response is paused otherwise), so there is no background queue. The only queue is the events produced by one transport chunk / SDK event (at most a few, bounded by the frame limit).

**OpenAI (`src/providers/openai/stream.ts`).** `sdk.ts` (the only SDK import) exposes `streamResponse(params, control)` returning `{ next(), close() }` over raw decoded events; `close()` aborts first. Same request mapping as `generate` plus `stream: true` (`store:false`, `maxRetries:0` at client and request level, header allowlist unchanged). Event mapping (checked against the installed `ResponseStreamEvent` types): `response.output_text.delta` → text (non-string delta is an API failure, never coerced; empty deltas dropped); `response.reasoning_text.delta` and `response.reasoning_summary_text.delta` → reasoning only; `response.completed` → completed (usage through the shared `convertUsage`, tier, `id`/`model` metadata); when no delta arrived the answer text of a valid completed body is emitted once as a text event, and a body with no text fails exactly like the non-streaming path (refusal named); `response.incomplete` → incomplete with the readable reason, assembled text and usage/tier; `response.failed` and `error` events (and SSE `error` frames, which the SDK throws as an `APIError` without status) → sanitized failure; every other event (lifecycle, output-item, content-part, `*.done`, refusal deltas) is ignored, so no text is taken twice; EOF without a terminal event → "OpenAI stream ended before the response was complete." The SDK swallows aborts silently (its iterator just ends), so the source decides from its own flags whether a stop was a caller cancel (AbortError), our own close, the idle deadline (timeout) or a premature end (API failure). All failure text goes through `safeText` with the key redacted. The one retry is the existing narrow reasoning fallback, evaluated at the only place an HTTP 400 can occur (opening the request, so before any text or reasoning could be published): structured `param` equal to `reasoning`/`reasoning.…`, non-explicit effort, no caller abort; the model is remembered in the same per-model cache as `generate`, and explicit choices fail with the usual message. Nothing is retried after the stream started.

**Ollama (`src/providers/ollama/stream.ts`, `transport.ts`).** `nodeStreamTransport` is a second transport beside the non-streaming one: fresh non-proxy agent per request, no redirects/retries, headers → pull-based body reads, `close()` destroys request, socket and agent. The source reuses `prepare()` (host/cloud/model/capability checks before `/api/chat`) and the shared payload builder (`stream:true`, same messages, instructions, `think`, `options.num_predict`). NDJSON framing works on bytes (`NdjsonFramer`): LF-delimited, blank lines skipped, a trailing CR ignored, a final unterminated record accepted; a frame is decoded as strict UTF-8 only when complete, so characters split across chunks are safe. The 16 MiB limit (injectable for tests) applies to complete lines and unfinished tails alike, regardless of chunking; frames before an oversized line are still processed. Records: `error` (non-null) → failure; `message` must be an object, `content` and `thinking` strings, `done` boolean when present (no coercion); counts and `*_duration` timing come only from the final `done:true` record (`total/load/prompt_eval/eval` seconds, finite non-negative only); `done_reason:"length"` → incomplete; EOF or disconnect before `done` → connection failure (kind 7), including a clean EOF. `message.thinking` → reasoning events. A leading `<think>…</think>` block in `content` is filtered incrementally (`ThinkFilter`): whitespace before the tag and after the closing tag is dropped (as when not streaming), only an undecided prefix (`<th`) or a possible start of `</think>` is held back, later tags stay answer text, a trailing partial prefix is ordinary text, an unclosed block is never answer (incomplete with `length`, otherwise an API failure like the non-streaming policy). Ordering within a record: explicit thinking, then inline reasoning, then answer; both kinds are reasoning events and are not deduplicated; the completed result's `reasoning` is the explicit field when present, otherwise the inline block (as when not streaming). The assembled answer is kept in memory (the session API needs it); there is no total-size limit and nothing is truncated.

**Consumers (`src/application/stream-consumer.ts`).** `consumeStream` owns a child `AbortController`, pulls one event at a time, awaits the `onText` writer before pulling again, stops at the first terminal event and then `return()`s the iterator. On caller abort it aborts, closes the iterator and waits at most `cleanupTimeoutMs`: `cancelled` if the stream settled, `stuck` if not (then nothing late is ever processed). A writer failure aborts and closes the stream and is returned as `output-error` carrying the original error, so the exit code (141 for EPIPE) does not depend on cleanup. A stream that ends without a terminal event or throws a `ProviderError` is normalized to a failed outcome; other errors keep the existing fixed internal-error handling.

**One-shot.** Text is written as it arrives; after the terminal event one newline (also for an empty completed answer; after a partial answer for failures/incomplete), then stderr diagnostics (`--usage` plus the optional `Duration:` line from reported timing). Cancellation ends a partial line before `neurobrau: interrupted`. No history, active or settings store is created.

**Plain chat.** `AI > ` is printed with the first non-empty text delta (once), then deltas; an empty completion prints the prefix and a line. The accepted-or-cancelled decision and `applyCompleted` happen synchronously after `consumeStream` returns (an interrupt that landed while a finished stream was being closed still wins); only then the save is awaited and *before* the final newline, so a failing final write cannot undo or skip an accepted exchange, while an output failure before the terminal commits nothing. Incomplete answers add no messages but their reported usage goes through `applyIncomplete`/`persist` exactly as when not streaming (a brand-new conversation stays unsaved until a completed turn; this follows the usage accounting of the spec's section 15 over the older section 14 wording that every incomplete leaves the file unchanged). Failed and cancelled answers commit and write nothing; a visible partial answer is followed by `The partial response was not saved.`. A repeated Ctrl+C while cancelling is absorbed; if cleanup exceeds the bound the chat exits 130 rather than risk two overlapping requests. Lines typed during streaming wait in the line input and run afterwards.

## Versioning

`package.json` is the only version authority at runtime; `package-lock.json` must agree (tested). The version changes when a milestone is entered or completed, not silently left alone. Completing a milestone is separate from tagging or publishing it.

| Stage | Version |
| --- | --- |
| Completed CLI Foundation (OpenAI + Ollama non-streaming) | 0.1.0 (done) |
| Work on chat/history/streaming | 0.2.0-dev (done) |
| Completed interactive chat milestone | 0.2.0 (done) |
| TUI development / completed TUI | 0.3.0-dev (done) / 0.3.0 (done) |
| Cost estimates / full parity development / completed milestone | 0.4.0-dev (done) / 0.4.0 (current) |

Patch releases of a completed milestone (0.1.x) require owner approval.

## Future separation

Planned, created only when real code needs them: `src/domain/` (messages, usage, settings), `src/providers/` (OpenAI/Ollama adapters), `src/application/` (engine, sessions, request lifecycle with `AbortController`), `src/storage/` (codecs, paths, atomic writes), `src/ui/`, `src/pricing/`. Domain code will not import provider SDKs, the filesystem, or a TUI. See `docs/architecture-roadmap.md` for the full analysis.

## Fullscreen chat (Task 008)

Details, keys and limits are in `docs/tui.md`. Layers (`src/tui/`):

| Module | Responsibility |
| --- | --- |
| `text.ts`, `layout.ts`, `panel.ts`, `status.ts`, `editor.ts`, `keys.ts`, `frame.ts`, `render.ts` | Pure logic: display neutralization and wrapping, geometry, the settings/token panel (exact bigint sums), status texts, the input editor, the key decoder, the cell grid and the render function. No I/O, no process, provider or terminal imports. |
| `model.ts` | Visible state: entries (with wrap cache), scroll, draft, status, flash. No provider or storage objects. |
| `controller.ts` | Owns request identity and every state change; talks only to the injected `Terminal`, `Timers`, `Provider` and `ChatSession`. Request ownership, the synchronous accept/commit step, bounded cleanup, exit sequencing and coalesced, backpressured drawing live here. |
| `terminal.ts` | The ports: `Terminal`, `Timers`, `SignalSource`, `TerminalEnvironment`, `TuiHost`. |
| `ansi-terminal.ts` | The production adapter (alternate screen, raw mode, cursor, styles, listeners); constructed explicitly, changes nothing on import, restores exactly what it changed, once. |
| `eligibility.ts` | The single place that decides fullscreen versus plain. |
| `run-tui.ts` | Composition: existing startup first, then terminal and controller, exit-code mapping, diagnostics, transcript. |

### Menus, switching and preferences (Task 009)

| Module | Responsibility |
| --- | --- |
| `application/provider-hub.ts` | The providers of a run. Only the startup provider exists at first; another is built (after the existing key/readiness check) the first time it is selected, then reused with its discovery caches. No network, no other provider's credentials or host. |
| `application/workspace.ts` | The current selection and the independent `ChatSession` of every exact provider/model (key: `JSON.stringify([provider, model])`). `prepareSwitch` is asynchronous, cancellable and read-only; `accept` is the synchronous acceptance boundary, after which the storage writes (empty new conversation + `active.json`, or `active.json` only for a remembered/restored one) are awaited and never rolled back. |
| `application/preferences.ts` | Loaded preferences plus the command-line overrides still in force; resolves with the existing lenient resolver and `savedPreferences`; a confirmed choice clears only its own field's override, updates a copy of the document and saves through the very `SettingsStore` that loaded it (a store disabled at startup stays disabled). |
| `tui/menu.ts`, `tui/menu-builders.ts`, `tui/token-input.ts` | Pure: menu state/geometry/lines, the five menus' items, bigint-based custom-token validation. |
| `tui/controller.ts` | Modal key routing, the `checking` phase (a cancellable asynchronous check retired before it is aborted, like a request), applying a prepared switch and confirmed choices. |

`ChatSession` gained `retainable`, `persistActive()` and a shared `ActiveTracker`; `startChat` additionally returns the history access, the settings store instance and the loaded document. The plain chat and one-shot paths never use a saving settings port.

`src/main.ts` receives an optional `tui` host; without it (every default composition and all pre-existing tests) the chat is always the plain chat and no terminal fact is read. `src/cli.ts` supplies the real TTY facts, signal wiring and `AnsiTerminal`. `consumeStream` gained one optional observer that is told *that* reasoning arrived (never its text); its close-once, bounded-cleanup and backpressure behavior is unchanged. `PlainChat` is untouched; the fullscreen chat does not parse printed output of another front end.

## References

Read-only sibling projects, analyzed at these snapshots:

- Python: `0a6d045c022b850371a1c51a1df30f11d9d4c60e`
- Go: `b064decc66cad7d9656488bdf7749650b52cf309`
