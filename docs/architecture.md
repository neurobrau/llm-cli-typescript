# Architecture

Status: bootstrap (`0.1.0-dev`). Only the CLI skeleton exists.

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

`node:util` `parseArgs` runs in non-strict token mode; the parser then classifies tokens itself. This gives the required distinct diagnostics (unknown vs. deliberately unsupported future options, values on boolean flags, conflicts) that strict mode would collapse into one error. Options of the Python/Go editions (`--provider`, `--stream`, …) are listed explicitly and rejected rather than ignored.

## ESM, compiler, and tests

- Native ESM (`"type": "module"`), TypeScript `module`/`moduleResolution` `NodeNext`, explicit `.js` relative specifiers, target `ES2023`, source maps, no bundler.
- `tsconfig.json` compiles `src/` only (`rootDir: src`, so `dist/cli.js`). `tsconfig.test.json` compiles `src/` and `tests/` into `.test-dist/`. Both are strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, …) and `typecheck` covers both.
- Tests use `node:test` and `node:assert/strict`. `scripts/run-tests.mjs` passes an explicit file list to `node --test` and fails when none exist, because an empty glob otherwise succeeds. Integration tests run the emitted `dist/cli.js`.
- Because the test tree is emitted one level deeper (`.test-dist/src/`), `version.ts` walks up to the nearest `package.json` instead of using a fixed relative path.
- ESLint uses a flat config with `typescript-eslint` strict type-checked and stylistic rules. `no-floating-promises` applies to tests as well. `describe()`/`it()` registrations return runner-tracked promises, so they are marked with the `void` operator; promises inside test bodies stay checked.

## Domain contracts and settings resolution (Task 002)

Internal only; no CLI flag uses them yet.

- `src/domain/generation.ts`: `Message`, `TokenUsage`, `GenerationRequest` (immutable snapshot via `snapshotRequest`), `GenerationOutcome` (`completed` | `incomplete`), `StreamEvent` (text, reasoning, completed, incomplete, failed).
- `src/domain/errors.ts`: `ProviderError` with kinds api(1), missing_api_key(3), authentication(4), rate_limit(5), timeout(6), connection(7); `SettingsError` (exit 2 at the future CLI boundary); `AbortError` helpers (cancellation, 130, is never a `ProviderError`). Messages given to `ProviderError` must already be safe: adapters must normalize and redact upstream text.
- `src/domain/provider.ts`: `Provider` interface. Every async method takes an `AbortSignal`; `generate` returns a `GenerationOutcome`, `stream` returns an `AsyncIterable<StreamEvent>`.
- `src/domain/settings.ts` and `src/application/resolve-settings.ts`: `resolveSettings(input)` is pure (no I/O, environment, cache or mutation). Capabilities and saved preferences are supplied by the caller.

**Counts are `bigint`.** Absent means not reported, `0n` reported zero; nothing is inferred. Counts above 2^53 stay exact. No JSON codec exists yet.

**Stream lifecycle.** Full consumption yields deltas and exactly one terminal event, then ends. Early `return()` releases resources without a terminal event. Cancellation throws `AbortError` (also for an already-aborted signal) and never invents usage. No production stream validator exists yet.

**Provenance and model default.** Each resolved setting records `source` (`cli`, `saved`, `builtin`) and `explicit`. Reasoning `effort` absent means the parameter is omitted; with `explicit: true` that is the user's "model default" choice (Go-style provenance), not a lost bit. A built-in default (`explicit: false`, e.g. `none`) may later be retried without the parameter if rejected; a user choice must not be dropped. Saved max tokens `null` is an explicit model default (omitted but `explicit: true`); absent is a built-in omission. Precedence: CLI, saved, built-in; a successful CLI value produces no notice about the overridden saved value. Strict mode throws `SettingsError` for unusable CLI values; lenient mode adds a notice and falls back to the saved value, then the built-in one.

**Test-only fake.** `tests/helpers/fake-provider.ts` implements `Provider` with scripted outcomes and events, deferred-promise gates and abort-listener accounting. It is not a production module.

## Future separation

Planned, created only when real code needs them: `src/domain/` (messages, usage, settings), `src/providers/` (OpenAI/Ollama adapters), `src/application/` (engine, sessions, request lifecycle with `AbortController`), `src/storage/` (codecs, paths, atomic writes), `src/ui/`, `src/pricing/`. Domain code will not import provider SDKs, the filesystem, or a TUI. See `docs/architecture-roadmap.md` for the full analysis.

## TUI

Undecided. The choice (Ink, Blessed, a custom ANSI renderer, …) waits for a focused spike on Node 24 and Ptyxis covering keyboard handling (F-keys, paging), resize, and terminal restoration on signals. No TUI dependency is installed.

## References

Read-only sibling projects, analyzed at these snapshots:

- Python: `0a6d045c022b850371a1c51a1df30f11d9d4c60e`
- Go: `b064decc66cad7d9656488bdf7749650b52cf309`
