# Release audit (Task 011)

Version `0.4.0-dev`. This is an audit of what is implemented and verified, not a release: no tag, commit or publication has been made, and finalizing `0.4.0` needs a separate owner instruction.

## Implemented scope

- One-shot prompts for OpenAI (Responses API, official SDK) and a local Ollama server; `--stream` for both.
- Interactive chat with persistent history and saved settings: the fullscreen DOS-style chat on supported ANSI terminals (menus F2 model, F3 provider, F4 reasoning, F5 max tokens, F6 answer style; per-selection conversations; saved preferences) and the line-oriented chat (`--plain` or an unsupported terminal).
- Estimated API cost from a dated reference catalog (2026-10-22), exact integer arithmetic, `/usage` and the `COST (EST.)` panel (`docs/pricing.md`). **The catalog estimates API cost; it is not a billed statement, not a live price list, and local Ollama's `$0` is API cost only.**
- Storage formats compatible with the Python and Go editions within the common domain (`docs/storage.md`, `docs/parity.md`).

## Automated evidence

- Default suite (`npm run check`: typecheck, ESLint strict, build, compiled `node:test` tests including PTY and child-process tests). Self-contained: no Python, Go, network or sibling repository.
- `npm run test:parity`: real Python storage serializers/validators, 32 files, both directions.
- `npm run test:pricing-parity`: real Python pricing functions, with a negative control.
- `npm run test:cross-parity`: real Python **and** Go references (storage, settings resolution, pricing) plus TypeScript sessions continued over Python- and Go-written files; scoped matrix, negative controls and accepted differences in `docs/parity.md`.
- `npm run test:release`: the four above in order, fail-fast, BLOCKED (3) preserved.
- Exact results per Node version are recorded in `.agent-tasks/reports/TS_TASK_011_REPORT.md` (local, not committed).

## Owner-reported live evidence (not repeated by the agent)

- Task 008/009 smoke runs on a real terminal (streaming cancellation and next request, menus, preference persistence, restart restore with the model recalling earlier context).
- Task 010 acceptance: local Ollama cost, incomplete accounting, empty `/usage` after reset, and a real OpenAI completed exchange with 11 input and 5 output tokens displayed as `$0.000004`.
- No live provider request is made by any automated check in this repository.

## Known limits

- No cross-process locking: two chats on one state directory can overwrite each other's conversation files (writes are atomic per file).
- Files are read whole into memory; no size cap beyond the existing per-file handling.
- Terminal support is the tested ANSI/VT families on Linux; Unicode display width is by code point (wide and combining characters can misalign), bracketed paste is not enabled (a pasted newline submits), `Ctrl+Z` suspension is not specially handled. Windows is untested.
- The pricing catalog is a dated snapshot: OpenAI has since listed a 12h cache-write rate, tier rates for `gpt-5.1` and other changes (`docs/pricing.md`); they are not modeled.
- Counts above signed 64 bits are exact in TypeScript and Python but unreadable for Go (documented in `docs/parity.md`); Go's JSON writer escapes U+2028/U+2029.
- The Go reference's module dependencies must already be in the local module cache for the cross-language gate; otherwise it is BLOCKED.

## Remaining blockers for a `0.4.0` release

None found by the gate. Release steps (version change, commit, tag, publication) are owner decisions outside this task.
