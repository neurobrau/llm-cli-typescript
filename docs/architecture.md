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

## Future separation

Planned, created only when real code needs them: `src/domain/` (messages, usage, settings), `src/providers/` (OpenAI/Ollama adapters), `src/application/` (engine, sessions, request lifecycle with `AbortController`), `src/storage/` (codecs, paths, atomic writes), `src/ui/`, `src/pricing/`. Domain code will not import provider SDKs, the filesystem, or a TUI. See `docs/architecture-roadmap.md` for the full analysis.

## TUI

Undecided. The choice (Ink, Blessed, a custom ANSI renderer, …) waits for a focused spike on Node 24 and Ptyxis covering keyboard handling (F-keys, paging), resize, and terminal restoration on signals. No TUI dependency is installed.

## References

Read-only sibling projects, analyzed at these snapshots:

- Python: `0a6d045c022b850371a1c51a1df30f11d9d4c60e`
- Go: `b064decc66cad7d9656488bdf7749650b52cf309`
