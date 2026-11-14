# Parity with the Python and Go editions

## Current scope and limitations

`0.4.0` (the completed full-parity milestone: exact estimated costs and the consolidated gate on top of the completed `0.3.0` TUI milestone; the completed `0.1.0` and `0.2.0` behavior is unchanged) implements `-h`/`--help`, `--version`, a one-shot prompt for OpenAI and Ollama (`--provider openai|ollama`), the chat with persistent history and read-only saved settings in two front ends — the fullscreen DOS-style chat on supported terminals and the line-oriented chat (`--plain`, pipes, other terminals) — `--no-history`, `--transcript-on-exit` (fullscreen only) and `--stream` for both (Tasks 007, 008). The fullscreen chat also has the F2–F6 menus, provider/model switching with independent conversations and the saved-preference writes (Task 009). **Not implemented:** pricing and cost estimates (spec section 15), model-discovery commands. Pricing parity and release readiness are not claimed. Exit codes 1-8, 130 and 141 are produced for the one-shot path.

## References

- Python (primary behavior reference): `0a6d045c022b850371a1c51a1df30f11d9d4c60e`
- Go: `b064decc66cad7d9656488bdf7749650b52cf309`

Both are read-only. The Go version constant (`0.4.0-dev`) and the Python version are independent of this edition's `0.4.0` (version plan in `docs/architecture.md`).

## Consolidated cross-language gate (Task 011)

`npm run test:cross-parity` (builds first; optional, never part of `npm run check`) executes the real pinned reference code and compares it with the real TypeScript code on synthetic data only. Environment: `NEUROBRAU_PYTHON` (default `python3`), `NEUROBRAU_PYTHON_REPO` (default `../llm-cli-python`), `NEUROBRAU_GO` (default `go`), `NEUROBRAU_GO_REPO` (default `../llm-cli-go`), `NEUROBRAU_GO_MODCACHE` (default `go env GOMODCACHE`, read only). The two pinned commits are exported with `git archive` into a private temporary tree: Python `0a6d045c022b850371a1c51a1df30f11d9d4c60e` (`src/` only) and Go `b064decc66cad7d9656488bdf7749650b52cf309` (whole module). A missing or different commit is BLOCKED; nothing is downloaded or installed. The Go adapter (`scripts/xparity/xparity.go`) is copied into the temporary copy as `cmd/xparity`, so it can import the reference's `internal/{storage,chat,llm,pricing}`; it is built offline (`GOPROXY=off`, `GOFLAGS=-mod=readonly`, `GOTOOLCHAIN=local`, `CGO_ENABLED=0`, caches in the temporary tree). Python runs as `python -B -I` with a synthetic HOME/XDG. Subprocesses use argument arrays, a deadline and a bounded capture, and receive no provider credentials. The reference worktrees (HEAD and `git status --porcelain`) are compared before and after the run, and are never written. Exit 0 = pass, 1 = failure, 3 = BLOCKED (missing interpreter, Go toolchain, repository, commit or Go module cache).

`npm run test:release` runs `check`, the storage parity, the pricing parity and then this gate in order, stopping at the first failing step and returning its exit status (3 stays 3). Steps 2-4 reuse the `dist/` that step 1 built.

| Contract | Real code executed | Cases | Result |
| --- | --- | --- | --- |
| Storage, common domain (conversations incl. usage records, `active.json`, `settings.json`) | Python `HistoryStore`/`SettingsStore` reader+writer; Go `DecodeConversation/EncodeConversation`, `DecodeSettings/EncodeSettings`, `LoadActive/SaveActive`; TypeScript codecs | 16 canonical files (empty/multi-turn/legacy shapes, completed/incomplete, absent vs zero, absent vs `""` tier, counts at 2^53-1, 2^53+1 and 2^63-1 in separate records, control and astral text, year 0001/9999, saved reasoning `default` vs absent, max absent/null/integer, independent providers, `__proto__`, integer-like and code-point-ordered keys) | exact bytes in TS->Python, TS->Go, TS->Python->Go->TS and TS->Go->Python->TS (32 file passes); plus files from the references' own writers/generators (Python writer, Go writer, Go generator, Python generator: 14 files) read by TypeScript and the readers that apply |
| Normalization | the same | 6 raw files (offset timestamps truncated to UTC milliseconds, unknown fields dropped, absent status, null provider/tier, malformed records skipped, unsorted settings, spaced `active.json`) | all three produce the TypeScript canonical bytes, with content assertions |
| Rejection | the same | 17 files (malformed JSON, empty, wrong top level, schema 2/`"1"`, bad id, bad messages/role/content, missing/naive timestamp, empty provider, bad settings, bad active) | nobody produces a result |
| Settings resolution | Python `preferences.resolve_model_settings`; Go `chat.ResolveSettings/ResolveSwitchedSettings` (fake provider); TypeScript `resolveSettings` | 781 named cases: 5 support shapes x 9 CLI x 7 saved reasoning values x strict/lenient; limit x CLI max x saved max (absent/null/1/600/limit/limit+1); 4 lookup failures; 3 combined | identical effective reasoning, explicit bit, max tokens, error classification and ordered notices except the rules below |
| Pricing | Python `pricing.estimate/total_cost/format_*`; Go `pricing.Request/Total/Short/Describe/FormatMoney` (exact `big.Rat`); TypeScript `src/pricing` | 78 cases / 117 records / 25 money fixtures (Task 010 corpus) | identical to Python for all; identical to Go for the 74 cases within signed 64 bits; amounts compared as exact rationals; short text, `/usage` cost line, status and ordered notes compared |
| Session interoperability | the real TypeScript `run()` (plain, streaming, fullscreen with menus) with the real filesystem stores and fake providers; Python and Go readers/writers at every checkpoint | 6 scenarios / 6 checkpoints | see below |

Negative controls (each must be detected or the gate fails): storage corrupted bytes, dropped file, dropped/duplicated/extra coverage and a changed value; settings altered Go value, altered TypeScript notice, dropped Python result and duplicated Go result; pricing altered Python amount, altered Go note, dropped case, dropped **last** money fixture, duplicated money fixture, altered money text and an emptied case set. Every oracle result list is checked for exactly-once coverage of the expected case ids and money fixtures in both directions. The default suite (`tests/cross-parity-script.test.ts`) additionally exercises missing interpreter/Go/repository/commit/module cache (exit 3), malformed/empty/crashing/hanging oracles and a modified reference worktree (exit 1), the comparison rules, bounded subprocesses and the release-gate order with stand-ins, with no real reference execution.

Session scenarios: (1) a Python-written conversation (counts at 2^53+1) restored and continued by TypeScript, read by Go and Python with unchanged prior messages and exact accumulated usage; (2) the same with a Go-written OpenAI conversation (empty tier, incomplete record at 2^62); (3) a streamed TypeScript session whose reasoning text and interrupted partial answer never reach the file; (4) incomplete usage counted without committing the partial answer, and an incomplete-only new conversation staying unsaved (accepted policy); (5) saved model-default reasoning and null max tokens omitted from requests, settings bytes unchanged, independent selections with their own histories and an `active.json` naming the last selection; (6) the fullscreen menus (F6/F4/F5/F2) saving preferences and keeping per-model conversations, read back by both references.

### Intentional differences versus failures

Every entry below is asserted per implementation (storage) or per case with a checked condition (settings); an unlisted difference fails the gate.

| Area | Difference | Why |
| --- | --- | --- |
| Storage | Counts or saved limits above signed 64 bits: Python and TypeScript keep them exactly; Go skips the usage record (or ignores the settings entry with a warning) and never rounds | Go reads `int`; TypeScript follows Python's arbitrary integers (`docs/storage.md`) |
| Storage | Unknown conversation provider: Python and TypeScript keep it, Go reads it but refuses to write it | Go's writer validates providers |
| Storage | U+2028/U+2029 in text: Go writes `\u2028`/`\u2029`; Python and TypeScript write the raw characters. Same data; Go's output normalizes back to the canonical bytes in TypeScript. **This is a real byte difference in Go's writer** (Go's encoder always escapes them): canonical bytes are therefore claimed for the common domain *excluding* these two code points. TypeScript keeps the Python-compatible raw form; no TypeScript change was made to imitate Go | encoding/json behavior in the Go reference; reported, not changed |
| Storage | NaN, `schema_version: true`, space-separated timestamps: TypeScript rejects all; Go rejects all; Python accepts them (NaN: skips the record) | `docs/storage.md` strict RFC 3339 / JSON policy |
| Storage | Unknown provider in `active.json`: TypeScript and Go reject; Python accepts any string | typed error policy |
| Settings | Python drops the explicit bit when an explicit choice sends nothing (saved/CLI model default, `none`/`off` on a model without reasoning); Go and TypeScript keep it | existing accepted difference (Task 002) |
| Settings | TypeScript's lenient CLI-reasoning notice ends `; ignoring the command-line value.`, the references `; using the default.`; unconfirmed support is described as `reasoning support is not confirmed` (references: `does not support reasoning`) | existing accepted wording (Task 002); only these exact suffixes are rewritten before comparing |
| Settings | A failed capability lookup adds a notice in Python and Go; the pure TypeScript resolver adds none (its caller does) | pure resolver (Task 002) |
| Settings | A non-positive command-line max: Go treats it as not given (its result must equal the case without it); Python and TypeScript reject it | Go `> 0` guard; not copied |
| Pricing | Cases with counts above signed 64 bits are classified out of Go's domain (computed independently, not trusted from Go) | Go `int` |
| Pricing | The `/usage` report adds the cost line as a second line for an empty conversation and escapes control characters in notices (asserted for a hostile model name) | Task 010 decisions |

No unresolved compatibility finding remains from this gate other than the Go U+2028/U+2029 writer difference above (a Go reference behavior, outside TypeScript's contract).

## Settings resolution (Task 002, internal)

The resolver follows Python `docs/tui-spec.md` section 13 and the Go `chat.ResolveSettings` order (CLI, saved, built-in). Tests use table-driven cases derived from those rules. The Task 011 gate (`npm run test:cross-parity`) now executes the real Python and Go resolvers against the same matrix; its result and the accepted differences are in "Consolidated cross-language gate (Task 011)" below.

Deliberate differences and notes:

- Go-style provenance for explicit model default: `explicit: true` survives even though the parameter is omitted (Python loses that bit in this branch).
- Counts are `bigint`; Python/Go use plain integers.
- Lenient CLI *reasoning* failures say `…; ignoring the command-line value.` (Go/Python: `…; using the default.`), because the saved value is tried before the built-in default.
- Describing unconfirmed support says `<model> reasoning support is not confirmed` (Go prints `does not support reasoning` for empty values even when support is unknown).
- Saved `default` is refused with a notice when model-default omission is not selectable (e.g. Ollama off/on-only), matching the reference.
- A failed capability lookup is the caller's job (supply unknown capabilities and its own notice); the pure resolver never fabricates one.
- Max-output-token notices use the reference wording unchanged (`… Using the default.`), and the saved `default` reasoning is labelled `Default` as in both references.

## OpenAI one-shot differences (Task 003)

References: Python `openai_provider.py`, `preferences.py`, `formatting.py`, CLI one-shot path; Go `internal/openai/*`. The model table is a dated compatibility table copied from the Python reference, not a claim about current account availability.

- Timeouts and retries: generation timeout is 60 s with SDK retries disabled (Python uses the SDK default of 10 minutes and 2 retries; Go 600 s and 2 retries). Models timeout stays 5 s without retries. The only retry is the narrow built-in-reasoning fallback.
- Fallback matching is stricter: `error.param` must be `reasoning` or start with `reasoning.` (Python/Go: any `reasoning…` prefix, e.g. `reasoning_effort`).
- A `completed` response with empty text and no refusal is an API error (Go CLI policy; Python prints an empty line). Missing or unknown status is an error (Go accepts a missing status as completed).
- Errors: detail text from the server is capped at 300 characters, stripped of control sequences and newlines, and the key plus key-like strings are redacted (the references redact only key-like strings and the exact key in Go).
- Counts: non-negative safe integers become `bigint`; others are not reported (Python/Go accept any non-negative integer).
- Resolver notices for explicit-effort rejection reuse the reference wording; wording differences from Task 002 stand.
- Cancellation always normalizes to `AbortError`/exit 130 (Go reports a failed event wrapping `context.Canceled`).
- The SDK differs from the Python/Go ones: `OPENAI_CUSTOM_HEADERS` cannot be disabled by option and is filtered by a header allowlist; the models list is a single page.
- Live parity against the Python/Go implementations is not part of this task; all behavior is covered by tests that use the real SDK against a loopback server with a synthetic key.

## Ollama one-shot differences (Task 004)

References: Python `providers/ollama_provider.py`, `tests/test_ollama_provider.py`, `docs/tui-spec.md` §§12-16; Go `internal/ollama/{http,ollama,parse}.go`. Official docs consulted: docs.ollama.com `api/chat`, `api/tags`, `capabilities/thinking` (they do not document `capabilities` or `context_length` in tags; the references' fields are supported alongside).

- Transport: Node `http`/`https` with a fresh agent per request; always direct, proxy variables never apply (Python bypasses proxies only for loopback; Go relies on `ProxyFromEnvironment`). One deadline covers the whole exchange including body reads (Python's timeout is per socket operation).
- `OLLAMA_HOST` is validated: userinfo, query/fragment, non-http(s) schemes and bad ports/hosts/paths are a settings error (exit 2). The references accept or silently reinterpret them. Explicit URL ports are kept as written; only a missing port becomes 11434.
- Cloud-like IDs are refused before any request, even when not installed (references look up tags first). A confirmed-capabilities model without `completion` is refused for explicit selection (Python/Go only hide it from lists).
- Model default for named-level models omits `think` (Go; Python sends `false`). Off/on models keep no selectable model default. `[false]` metadata means no thinking. Unknown support sends nothing by default; an explicit value passes through (`none`/`off`→`false`, `on`→`true`, else the exact string).
- Show capabilities are consulted only when tags omit them or report `thinking`; tags capabilities without `thinking` need no show request (Go always calls show). A refresh invalidates show data of changed models.
- `done` must be `true` (Python accepts a missing `done` in non-streaming replies); an `error` field is a failure even beside a message; an unterminated leading think block is never an answer (Python's regex leaves it in the text; Go matches this policy). Empty completed answers are allowed (the OpenAI adapter rejects them).
- Counts: exact `bigint` for non-negative safe integers, others absent; the total is the exact sum only when both counts exist (Go/Python: same rule, plain integers).
- Timing counters (durations, load) are ignored in one-shot; `done_reason:"length"` gives the references' reason text.
- Diagnostics are control-stripped, single-line and capped at 300 characters (Python 200, Go 200 runes).
- Connection errors name only the scheme, host and port, never the path prefix.
- Concurrent use of one provider instance is unsupported (as in Go).

## Storage codec differences (Task 005A)

Full table and rationale in `docs/storage.md`. Summary: counts and saved token limits are `bigint` (Python-compatible beyond 64 bits; Go rejects those); timestamps are strict RFC 3339 like Go (Python accepts more) within years 0001-9999; `schema_version: true`, `NaN`/`Infinity` and lone surrogates are rejected; unknown `active.json` providers are a typed error; settings notices are ordered by code point. Canonical bytes match Python for supported files (verified by `npm run test:parity` on Python 3.14.8, and by the six Python-generated Go fixtures). Direct execution of the Go serializers is deferred to the consolidated parity gate.

## Filesystem storage differences (Task 005B)

Details in `docs/storage.md`. Intentional differences from the references: only regular files directly inside the conversations directory are considered (symlinks, FIFOs and subdirectories are ignored, where the references list every `*.json` name); symlinks or non-directories at application-owned directory locations are refused (references follow them); settings own their containing directory whatever its name; saving settings before a load is refused, and a failed whole-file load disables saving permanently for the instance, including against later loads; writes of one instance are serialized in invocation order; `mtime` ties use bigint nanoseconds; messages use fixed reasons and escaped paths. Behavior kept from the references: canonical bytes, `0700`/`0600` modes, the temp-file naming, rename as commit with best-effort directory fsync, unknown stored provider strings, a file name differing from its internal id, no rewriting on load, last writer wins across instances. Go serializers and the CLI-level restore flow remain for the consolidated parity gate.

## Plain chat differences (Task 006)

References: Python `session.py`, `chat.py`, `cli.py`, `usage.py`, `docs/tui-spec.md` §§1, 8, 9, 11, 13, 15, 16; Go `internal/session`, `internal/chat`, `internal/cli/interactive.go`. Kept: banner and labels, notices, command set and aliases, restore rules and active selection, save-after-completed-exchange, reset/cleanup semantics, incomplete-usage save policy, warnings on stderr, exit codes.

- *Historical (Task 006; superseded by Task 008):* at the time there was no fullscreen TUI and every interactive run was the plain chat. Today the fullscreen chat is automatic on a supported terminal and `--plain` selects the line-oriented chat.
- `--usage` also prints usage after incomplete replies (Go/Python only after completed ones).
- `--plain`/`--no-history` with a prompt are rejected (exit 2); Python/Go silently ignore them.
- Restore: conversations of unknown providers are skipped (Go) and never rewritten; a valid active selection without a conversation never falls back to an unrelated one; unknown-provider and invalid `active.json` are warnings.
- Settings are read-only in the plain chat (Go writes them only from the TUI); the fullscreen menus save confirmed F4/F5/F6 choices (Task 009). A saved limit above `Number.MAX_SAFE_INTEGER` is ignored with a notice (file untouched); the references read it as a plain integer.
- Missing home: history and settings are disabled independently; Python/Go warn the same way but resolve XDG bases independently only per call.
- The OpenAI key is checked for presence only (no validation, no Models request) before the banner; Python/Go do the same presence check.
- Cancellation: Ctrl+C aborts the request (`AbortController`) and waits at most a bounded time; Go waits for the goroutine without a bound. A response that lost the race against an interrupt is discarded. After a response is committed, Ctrl+C waits for the save and then exits 130.
- Input is read through a bounded, paused-when-full reader; the references read synchronously (Python `input()`) or via a goroutine. EOF while a request is in flight does not cancel it. A read error exits 1 (Go treats it as EOF).
- Saving and printing order: the exchange is committed and saved first, then printed (as Go).
- `/cleanup` with a partial failure keeps the in-memory session (Go) and prints the number already deleted.
- Verified against Python: `npm run test:parity` loads TS-session-written files with the Python readers and checks the Python writer reproduces the bytes, and continues a Python-written conversation through a TS session. The Go serializers are executed by the Task 011 gate (see below). *Historical note from Task 006: it was deferred then.*

## Streaming differences (Task 007)

References: Python `docs/tui-spec.md` §12/§14/§15/§16 and the Python/Go streaming code; Go `internal/llm/stream.go`, `internal/openai/stream.go`, `internal/ollama/stream.go`, `internal/cli/stream.go`, `internal/chat/stream.go`, `internal/chat/usage.go` (`FormatDuration`).

- **Cancellation** is an `AbortError` from the iterator (Go/Python deliver a `StreamFailed` wrapping the cancellation); the application layer decides from its own signal.
- **No SDK retries**, including for the initial request (Go keeps SDK retries for the first request); the only retry is the narrow reasoning fallback, as in `generate`.
- **Frame limit**: 16 MiB like Go, but enforced for complete lines and unfinished tails alike (Go checks only the unfinished tail after splitting a chunk). Frames before an oversized one are still processed.
- **Strictness**: wrong types of `message`, `content`, `thinking` and `done` are API failures instead of being ignored; invalid UTF-8 is a failure (Go: `utf8.Valid` also fails). `error` records with a non-string value are a generic Ollama error.
- **Unclosed `<think>`**: never an answer; a claimed-complete stream with an unclosed block is an API failure (the stricter accepted TS policy; Go flushes nothing and completes with empty text), `done_reason:"length"` stays incomplete.
- **Idle deadline** granularity: OpenAI per SDK event, Ollama per received chunk (Go resets per read for Ollama and per event for OpenAI). Ollama default is the existing 300 s; OpenAI 60 s (Go: 600 s) because it reuses the accepted generation timeout.
- **Fallback text**: when no delta arrived, a valid `response.completed` body's text is emitted once as a text event (Python/Go copy it into the terminal result only); a completed body without any text keeps the non-streaming failure.
- **Reasoning events**: OpenAI maps `response.reasoning_text.delta` and `response.reasoning_summary_text.delta` (Go/Python ignore both); they are never printed or saved. No extra reasoning summaries are requested.
- **One-shot**: stdout is flushed per delta by awaiting each write; the final newline precedes stderr output. The `Duration:` line follows Go's `FormatDuration` (total required; load and generation only when positive) and is printed only for completed answers with `--usage`. `--usage` after an incomplete answer prints usage when reported (as Go).
- **Chat**: the save happens before the closing newline of an accepted answer (Go prints the newline, then commits). Incomplete answers record reported usage (§15) instead of leaving the file unchanged (older §14 wording); a first incomplete-only conversation stays unsaved until a completed turn (Task 006 policy).
- **Bounded cancellation**: after Ctrl+C the chat waits at most the cleanup bound for the stream to settle and exits 130 if it does not; Python's worker threads and Go's goroutine drain have no equivalent bound.

## Fullscreen chat differences (Task 008)

References: Python `docs/tui-spec.md` §1–10, 11, 14, 16 and `ui/tui.py`, `ui/status.py`; Go `internal/tui` (`wrap.go`, `layout.go`, `panel.go`, `app.go`, tests). Only the cases shared with the Go `wrap_test.go` and the Python `test_tui*.py` fixtures read for this task were reused as test data; the rest of the expectations are derived from the spec text.

- **Terminal support** is limited to the tested ANSI/VT families (xterm, screen, tmux, rxvt and variants) on Linux; other `TERM` values use the plain chat. The references use curses/terminfo (Python) and tcell (Go).
- `COST (EST.)` and the `/usage` cost line follow Python `pricing.py` (executed parity: `npm run test:pricing-parity`, see `docs/pricing.md`). The Go pricing functions are executed by the Task 011 gate (see below).
- **Concurrency**: Node async I/O instead of Python's worker thread and queue; the same observable contract (a bounded, pull-based handoff, 256 events per yield, one request at a time, retired identity on cancel, 0.1 s redraw). Unlike Python's documented limitation, cancellation closes the connection immediately and a new request waits for that close; a provider that does not close within the bound ends the program with exit 130.
- **`DONE` timing**: the status appears after the exchange was saved (Python: also after the save, but synchronously); during the save Enter is refused with `Please wait; the conversation is being updated`.
- **Title**: the actual package version and the TypeScript edition name; the `scrolled up N (PgDn)` suffix keeps priority over a long title.
- **Input**: draft capped at the plain chat's 8 Mi limit (excess dropped with a warning); decoding is built in (no terminfo), covering xterm/rxvt/tmux/`SS3` forms; bracketed paste is not enabled, so a pasted newline submits like Enter.
- **Rendering safety**: control characters in model/user/history text are replaced when rendered (Python/Go pass text to curses/tcell, which handle it themselves). `--transcript-on-exit` is a deliberate difference: the spec prints content unchanged, but when stdout is a terminal this edition neutralizes ESC and other unsafe controls in the printed copy (newlines and tabs kept; stored messages untouched), because the text is model output written to the user's real terminal. Non-TTY output stays exact.
- **EOF / SIGHUP / SIGTERM**: end of terminal input exits 0; SIGHUP 129 and SIGTERM 143 (the spec lists none of these).
- **Tab expansion** is column-aware (stops of four), like Python's `expandtabs(4)` and Go.

## Menus, switching and preferences differences (Task 009)

References: Python `docs/tui-spec.md` §4b/4c/11/13, `ui/menu.py`, `ui/tui.py` (menus, `switch`), `preferences.py`, `session.py` (`switch`, `Parked`, `cleanup`); Go `internal/tui/{menu,controls,operation}.go` with `menu_test.go` (`TestMenuLine`, `TestStyleMenuLayout`) and `prefs_test.go` (`TestChoicesReplaceCommandLineValues`, `TestUnsupportedSavedValuesOnSwitch`, `TestCorruptSettingsAreNeverOverwritten`, `TestSettingsSaveFailure`). The 39-wide style menu at column 9, row 7, the `menuLine` cases and the notice texts were reused as fixtures.

- **Numeric range**: custom tokens are digits (ASCII only) checked as `bigint`; a value above 9007199254740991 with no smaller known limit is rejected with a TS-specific message (the references use arbitrary Python integers / Go `int`). Saved huge values are kept untouched but cannot be used at runtime, as in the plain chat.
- **Empty custom input** gets its own message (`Enter a positive whole number.`) instead of the reference's `'' is not …`.
- **Reasoning current marker** follows explicit provenance (an explicit model default is marked, an unset parameter is not); Python marks the item equal to the effective effort string.
- **Cancellable checks**: Ctrl+C cancels a running check (`Cancelled.`), later results are ignored, a check that ignores cancellation beyond the bound ends the program with 130; the references run these checks synchronously on the UI thread.
- **Parked conversations** are kept as whole `ChatSession`s (one per exact selection, JSON-array keys) instead of a tuple-keyed `Parked` record; an empty conversation without a file is not remembered, one with a file is (Python parks only conversations with messages or usage, so after `/reset` → switch → switch back it loads the newest matching file instead; the task requires the post-reset conversation to return).
- **Switching resolution** is lenient with the resolver's notices; the references apply saved choices through `preferences.apply`.
- **Settings write** goes through the same store instance as the load; the references construct their store once as well. A failed write keeps the runtime choice and shows `WARNING | Settings not saved` (the reference only shows the warning entry).
- **Esc** is recognised 25 ms after it arrives and works without breaking split sequences; Go and Python use their terminal libraries' escape delay.

## Proposed future decisions (not implemented, not yet accepted by the owner)

- Python's language-neutral specification is the primary contract; each deviation is recorded individually.
- Adopt Go's responsive background model discovery and safe terminal restoration, without copying goroutines or Python threads literally.
- Plan Go-style handling of incomplete non-streaming answers: do not commit the messages, but account for reported usage.
- One-shot saved settings is a proposed exception to Python: use flags and built-in defaults without reading settings, as Go does.
