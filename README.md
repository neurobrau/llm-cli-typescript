# NeuroBräu TypeScript

TypeScript edition of the NeuroBräu LLM CLI. The current version, `0.1.0-dev`, is a **bootstrap skeleton**: it builds, prints help and version information, and validates arguments. It is not an LLM client yet — there are no providers, chat, prompt mode, persistence, streaming, pricing, or TUI, and it makes no network requests. The version does not claim completion of milestone 0.1.

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
node dist/cli.js            # help (same as --help)
node dist/cli.js --help     # or -h
node dist/cli.js --version  # NeuroBräu TypeScript CLI 0.1.0-dev
```

The executable also works by absolute path from any directory. Only `-h`/`--help` and `--version` exist. Everything else is rejected with exit code 2 and a diagnostic on stderr:

| Input | Result |
| --- | --- |
| unknown option | `unknown option`, exit 2 |
| future options (`--provider`, `--model`, `--stream`, …) | `unsupported option … not implemented yet`, exit 2 |
| prompt text, including `""` | `prompt mode is not implemented yet`, exit 2 |
| more than one positional | `unsupported positional arguments`, exit 2 |
| `--help` with `--version` | `conflicting options`, exit 2 |
| help/version with any other argument | `invalid invocation`, exit 2 |
| `--version=foo` | `invalid argument`, exit 2 |

Repeated identical switches (`--help -h`) are idempotent. `--` ends option parsing, so `-- --version` is prompt text and is rejected. Stdout closed by the reader (`EPIPE`) exits quietly with 141; other output failures exit 1.

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

Providers (OpenAI, Ollama), one-shot prompts, interactive chat, history and settings storage, streaming, pricing, and a terminal UI come in later tasks; see `docs/architecture.md` and `docs/parity.md`.

## Working documents

- `AGENTS.md`: project rules for coding agents.
- `.agent-tasks/`: task specifications, prompts, and reports. Ignored by Git.
- `docs/`: durable architecture and parity decisions.
