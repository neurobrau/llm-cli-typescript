# Parity with the Python and Go editions

## Current scope and limitations

`0.1.0` implements `-h`/`--help`, `--version` and a non-streaming one-shot prompt for OpenAI and Ollama (`--provider openai|ollama`). Not implemented: chat, history and settings storage, streaming (`--stream` is rejected), pricing, model-discovery commands, terminal UI, `--plain`, `--no-history`, `--transcript-on-exit`. Exit codes 1-8, 130 and 141 are produced for the one-shot path.

## References

- Python (primary behavior reference): `0a6d045c022b850371a1c51a1df30f11d9d4c60e`
- Go: `b064decc66cad7d9656488bdf7749650b52cf309`

Both are read-only. The Go version constant (`0.4.0-dev`) and the Python version are independent of this edition's `0.1.0` (version plan in `docs/architecture.md`).

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

## Proposed future decisions (not implemented, not yet accepted by the owner)

- Python's language-neutral specification is the primary contract; each deviation is recorded individually.
- Adopt Go's responsive background model discovery and safe terminal restoration, without copying goroutines or Python threads literally.
- Plan Go-style handling of incomplete non-streaming answers: do not commit the messages, but account for reported usage.
- One-shot saved settings is a proposed exception to Python: use flags and built-in defaults without reading settings, as Go does.
