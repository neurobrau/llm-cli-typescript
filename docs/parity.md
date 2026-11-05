# Parity with the Python and Go editions

## Current scope and limitations

`0.3.0` (the completed TUI milestone; the completed `0.1.0` and `0.2.0` behavior is unchanged) implements `-h`/`--help`, `--version`, a one-shot prompt for OpenAI and Ollama (`--provider openai|ollama`), the chat with persistent history and read-only saved settings in two front ends — the fullscreen DOS-style chat on supported terminals and the line-oriented chat (`--plain`, pipes, other terminals) — `--no-history`, `--transcript-on-exit` (fullscreen only) and `--stream` for both (Tasks 007, 008). The fullscreen chat also has the F2–F6 menus, provider/model switching with independent conversations and the saved-preference writes (Task 009). **Not implemented:** pricing and cost estimates (spec section 15), model-discovery commands. Pricing parity and release readiness are not claimed. Exit codes 1-8, 130 and 141 are produced for the one-shot path.

## References

- Python (primary behavior reference): `0a6d045c022b850371a1c51a1df30f11d9d4c60e`
- Go: `b064decc66cad7d9656488bdf7749650b52cf309`

Both are read-only. The Go version constant (`0.4.0-dev`) and the Python version are independent of this edition's `0.3.0` (version plan in `docs/architecture.md`).

## Settings resolution (Task 002, internal)

The resolver follows Python `docs/tui-spec.md` section 13 and the Go `chat.ResolveSettings` order (CLI, saved, built-in). Tests use table-driven cases derived from those rules; no cross-language harness or live parity run exists yet (deferred).

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

- No fullscreen TUI: every interactive run is the plain chat, also on a terminal (`--plain` is accepted and redundant). Cost estimates are not implemented: `/usage` is token-only and says so (Python/Go print an estimated cost).
- `--usage` also prints usage after incomplete replies (Go/Python only after completed ones).
- `--plain`/`--no-history` with a prompt are rejected (exit 2); Python/Go silently ignore them.
- Restore: conversations of unknown providers are skipped (Go) and never rewritten; a valid active selection without a conversation never falls back to an unrelated one; unknown-provider and invalid `active.json` are warnings.
- Settings are read-only in the chat (Go writes them only from the TUI). A saved limit above `Number.MAX_SAFE_INTEGER` is ignored with a notice (file untouched); the references read it as a plain integer.
- Missing home: history and settings are disabled independently; Python/Go warn the same way but resolve XDG bases independently only per call.
- The OpenAI key is checked for presence only (no validation, no Models request) before the banner; Python/Go do the same presence check.
- Cancellation: Ctrl+C aborts the request (`AbortController`) and waits at most a bounded time; Go waits for the goroutine without a bound. A response that lost the race against an interrupt is discarded. After a response is committed, Ctrl+C waits for the save and then exits 130.
- Input is read through a bounded, paused-when-full reader; the references read synchronously (Python `input()`) or via a goroutine. EOF while a request is in flight does not cancel it. A read error exits 1 (Go treats it as EOF).
- Saving and printing order: the exchange is committed and saved first, then printed (as Go).
- `/cleanup` with a partial failure keeps the in-memory session (Go) and prints the number already deleted.
- Verified against Python: `npm run test:parity` loads TS-session-written files with the Python readers and checks the Python writer reproduces the bytes, and continues a Python-written conversation through a TS session. The Go serializers are not executed (deferred to the consolidated gate).

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
- `COST (EST.)` shows `unavailable` (no pricing).
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
