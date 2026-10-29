# Storage formats and pure codecs (`src/storage/`)

Status: internal and **not wired into the CLI**. The pure codecs (`src/storage/*.ts`) and the filesystem layer (`src/storage/fs/`, Task 005B, described in the last section) are separate. The codecs are only pure encode/decode functions for the shared JSON files (conversations, `active.json`, `settings.json`, usage records). No code in the pure part touches the filesystem, environment, clock, network or terminal, and neither startup, one-shot prompts nor help use it. Sessions and chat arrive in later tasks; the codec's whole-file failure (`StorageCodecError`) is the signal that a future file layer must use to refuse overwriting an unreadable file.

References: Python `0a6d045c022b850371a1c51a1df30f11d9d4c60e` (`storage.py`, `settings.py`, `usage.py`, their tests, `docs/tui-spec.md` §§11, 13, 15) is the byte-format authority for valid files; Go `b064decc66cad7d9656488bdf7749650b52cf309` (`docs/storage.md`, `internal/storage/*`, six fixtures) documents the accepted edge-case differences, which this edition follows where Python's behavior is accidental.

## API

```ts
import { decodeConversation, encodeConversation,
         decodeActiveSelection, encodeActiveSelection,
         decodeSettings, encodeSettings, emptySettings,
         StorageCodecError } from "./storage/index.js";
```

| Function | Input | Result |
| --- | --- | --- |
| `decodeConversation(text \| bytes)` | file content | `StoredConversation`, or throws |
| `encodeConversation(c)` | `StoredConversation` | canonical text (2-space indent, trailing `\n`) |
| `decodeActiveSelection` / `encodeActiveSelection` | `active.json` | `{provider: "openai"\|"ollama", model}` / one line, `, ` and `: ` separators, trailing `\n` |
| `decodeSettings(text \| bytes)` | `settings.json` | `{settings, notices}` or throws |
| `encodeSettings(s)` | `StoredSettings` | canonical text |

Bytes are decoded as strict UTF-8 (`fatal`, BOM kept so it fails as JSON, like the references); invalid UTF-8 is a `StorageCodecError` of kind `encoding`. `StorageCodecError.kind` is `encoding`, `syntax`, `document` (top level or schema version unusable), `field` (a required field is invalid), `value` (an encoder was given an unstorable value) or `runtime`. Messages name fields and categories only, never file bodies, message content or parser excerpts. Decoded values are frozen.

Types are storage DTOs (`types.ts`): `Message` and `TokenUsage` come from the domain; usage counts are `bigint`. Stored provider/model values are plain strings, so unknown values (e.g. `futureai`) survive round trips; runtime filtering is a later layer's job. `ActiveSelection` is deliberately narrower: only a supported provider and a non-empty model are usable at startup, so anything else is a typed error (Go only warns; the spec says the file is ignored).

## Numbers are never rounded

`JSON.parse` is called with a reviver; for each number the reviver receives `context.source`, the original lexeme, and the codec keeps the lexeme (`JsonNumber`) instead of the numeric argument. Recognized integer fields are converted from the lexeme with `BigInt`, so any size is exact. Runtime proof (Node 24.18.0, test `native JSON.parse source access`): `JSON.parse("9007199254740993", (k, v, c) => [v, c.source])` gives `[9007199254740992, "9007199254740993"]`; counts of 2^53+1, 2^63-1, 2^63 and 2^70+5 round-trip exactly. If a runtime lacks `context.source` the reader throws a `runtime` error instead of falling back to a rounded value. TypeScript 5.9's lib does not type the third reviver argument, so `src/storage/json-source.d.ts` adds an overload declaration only (no runtime patching; `BigInt.prototype` and `JSON` are untouched). No dependency was added and no JSON parser or regex repair of JSON text exists.

The tree the reader builds consists of `null`, booleans, strings, arrays, `JsonNumber` and `JsonObject` (a `Map` of fields), all created by the reader; JSON text cannot produce a look-alike, and typed access uses `instanceof`. Unknown fields may hold numbers far outside `number` range (even `1e999`); they are never converted.

Lexeme rules (as Python, plus strictness): counts and token limits accept only integer lexemes `0`, `42`, … (and `-0`, which both references read as 0); `1.0`, `1e2`, negatives and booleans are rejected. `schema_version` accepts any lexeme equal to 1 (`1`, `1.0`, `1e0`, as Python and Go) but not `true`, strings or other numbers. `max_output_tokens` must be a positive integer or `null`.

Writers print bigints as bare base-10 tokens (never strings, never exponents). Python accepts any non-negative integer; Go's reader accepts only the signed 64-bit range (`GO_MAX_COUNT` = 9223372036854775807) and skips larger records/entries, so such files are Python/TypeScript-only.

## Conversation (schema 1)

Keys in order: `schema_version`, `id`, `created_at`, `updated_at`, optional `provider`, optional `model`, `messages`, optional `requests`. `id` is a canonical lowercase UUID of any version (path-like or uppercase IDs are rejected; generating IDs is deferred). `provider`/`model`: absent or `null` means unknown and is omitted on writing (a legacy missing provider is never written as `openai`); otherwise a non-empty string (empty, non-string or ill-formed text is a field error, as in Python). Each message needs role `user`/`assistant` and a string `content`; one bad message invalidates the conversation. `requests` absent or not an array means none; malformed records are skipped individually; empty `requests` are omitted. Unknown fields are ignored and not retained.

Usage record keys: `at`, `provider`, `model`, `status`, optional `service_tier`, then `input_tokens`, `output_tokens`, `total_tokens`, `cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens`. `status` absent means `completed`; present it must be `completed`/`incomplete`. `service_tier` absent or `null` is omitted, any string (including `""`) is kept. Counts absent or `null` are unreported; one bad recognized count discards that record. Nothing is inferred while decoding: a stored `0` stays `0n`, an absent total stays absent, and a record is never created from messages.

## Settings (schema 1)

Keys: `schema_version`, `answer_style`, `providers`; per model `reasoning` before `max_output_tokens`. `answer_style` absent means `normal`; an unknown value gives a notice and `normal`. `providers` absent means empty; a present non-object (including `null`) invalidates the document. A provider entry without a `models` object, and any model entry with an invalid recognized preference, is skipped whole with a notice (never half-kept). `reasoning` is a non-empty string (`default` allowed) or absent/`null`; `max_output_tokens` is absent (not set), `null` (explicit model default) or a positive integer. Reasoning values are not checked against model capabilities. Empty valid entries decode but are omitted when writing, together with providers left empty.

`StoredModelPreferences` is separate from the resolver's `ModelPreferences`: `maxOutputTokens` is `bigint | null` so huge stored limits survive; a future bridge must check number representability before using one for a request, and request limits are not broadened. Providers/models live in `Map`s, so `__proto__`, `constructor`, numeric-looking and Unicode keys are plain data. Notices are ordered by provider/model code point (Python uses file order, Go sorts), quote names as JSON strings and never contain file bodies.

## Canonical formatting

Python's writer is the authority: `json.dumps(..., ensure_ascii=False, indent=2) + "\n"` for conversations and settings, and the one-line form for `active.json`. Empty containers print `[]`/`{}`. Strings use `JSON.stringify` escaping, which equals Python's for well-formed text (escaped `"`, `\`, `\b\f\n\r\t`, other controls as lowercase `\u00xx`; U+007F, U+2028 and U+2029 are written raw, as Python does; Go escapes U+2028/2029, a different spelling of the same value). Providers and models are sorted by Unicode code point (so U+FFEE sorts before an astral character, unlike JavaScript's default sort), and writer output is built from explicit ordered entries, so numeric-looking names are never reordered by JavaScript object enumeration.

Writers validate in-memory values (IDs, dates, roles, statuses, `bigint` counts ≥ 0, positive limits) and throw `value` errors; they never emit malformed data. Unknown fields are dropped: the byte-parity guarantee covers canonical supported files, not arbitrary input preservation.

Unicode: lone surrogates (possible in JSON as `\ud800`, impossible in UTF-8) in recognized fields are rejected on decode (conversation: field error; usage record: skipped; settings entry: skipped) and on write; in unknown fields they are ignored. Duplicate keys: the last value wins, matching Python and native parsing. NaN, Infinity, trailing commas, leading zeros and other non-JSON syntax are rejected (Python's decoder accepts `NaN`/`Infinity`).

## Timestamps

Strict RFC 3339 only: `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`; a missing zone, lower-case `t`/`z`, space separator, basic format, seconds `60`, impossible dates (checked against the calendar, not `Date.parse`) and offsets over 23:59 are rejected. Values are normalized to UTC and written with exactly three fractional digits and `Z`. Finer fractions are **truncated** toward the earlier millisecond (as Python's `isoformat(timespec="milliseconds")`); sub-millisecond precision is lost on canonical writing. Instants are `Date`s computed from parsed components. Supported range after normalization is years 0001-9999 (Python's `datetime` range); year 0000 and results outside the range are rejected. Python also accepts non-RFC 3339 forms; this edition follows Go and does not. No leap-second support. Codecs never read the clock.

## Fixtures and parity

- `tests/fixtures/storage/python/`: the six synthetic files copied unmodified from Go's testdata (provenance in `PROVENANCE.md`); tests decode them and re-encode **byte for byte**.
- `tests/fixtures/storage/ts/`: TS-created canonical files with the typed inputs in `tests/helpers/storage-cases.ts` (control characters and U+2028/2029, astral text, empty content, zero/absent/incomplete usage, empty tier, large counts at 2^53+1, 2^63-1 and beyond 64 bits, saved default/null/absent, special and numeric-like keys, BMP-vs-astral key order, year 0001 and 9999 timestamps, an unknown provider). Tests assert bytes, not only parsed values.
- Optional parity check, `npm run test:parity` (builds first, then runs `scripts/storage-parity.mjs`): drives the real, read-only Python reference (`storage`, `settings`, `usage`) through `scripts/python_storage_parity.py` with `python3 -B -I`, in temporary directories, with synthetic data only, 30 s subprocess timeouts. Python → TS → Python: files written by Python's writers, plus the Go-source fixtures, decode and re-encode identically in TS. TS → Python → TS: every TS fixture loads in Python, and Python's writer reproduces the same bytes. Configure with `NEUROBRAU_PYTHON_SRC` (default `../llm-cli-python/src`) and `NEUROBRAU_PYTHON` (default `python3`). If either is unavailable it exits **3 (BLOCKED)**, which is not a pass. It is not part of `npm run check`, which needs neither Python nor Go.
- Not done yet: executing the Go serializers and the full bidirectional Go/session harness (planned for the consolidated parity gate). Only Go-source synthetic fixtures are covered now.

## Known compatibility boundaries

| Case | Python | Go | TypeScript |
| --- | --- | --- | --- |
| Counts beyond signed 64-bit | accepted | rejected | accepted (`bigint`) |
| `NaN`/`Infinity` | parsed | invalid | invalid |
| `schema_version: true` | accepted | rejected | rejected (`1.0` accepted) |
| Non-RFC 3339 timestamps | accepted | rejected | rejected |
| Years outside 0001-9999 | error/crash | year 0 accepted | rejected |
| Lone surrogates in recognized text | kept (cannot be saved) | replaced | rejected |
| Count `-0` | read as 0 | read as 0 | read as 0 |
| Unknown active provider | read | warning | typed error |
| Settings notice order | file order | sorted | sorted by code point |
| U+2028/2029 | raw | escaped | raw |

## Filesystem layer (Task 005B, `src/storage/fs/`)

Status: internal API, **not connected to the CLI**: no command reads or writes history or settings, one-shot prompts, `--help` and `--version` behave exactly as before, and nothing here runs at import or construction. The pure entry point (`src/storage/index.ts`) never imports it; use `src/storage/fs/index.ts` for Node I/O. Every I/O method is asynchronous; stores return warnings for recoverable load problems and throw typed `StorageIoError`s (or return typed outcomes) for explicit operations that cannot complete. They never print, add exit codes, or expose stacks, document bodies or arbitrary exception messages.

```ts
const paths = resolveStoragePaths({ env: process.env, home: homedir() }); // the caller injects; the function reads nothing itself
const history = new HistoryStore(paths.conversations);                   // active.json lives in its parent
const { conversation, warnings } = await history.loadLatest((c) => matchesSelection(c, { provider: "ollama" }));
await history.save(snapshot, { signal });                                // atomic, 0600; the caller supplies updatedAt
const settings = new SettingsStore(paths.settings);
const loaded = await settings.load();                                    // required before any save
const outcome = await settings.save(loaded.settings);                    // { saved: true } | { saved: false, reason, warning }
```

**Paths.** `resolveStoragePaths({ env, home })` takes a record or getter and an explicit home. Absolute XDG values (normalized) win; empty or relative ones are ignored, independently for state and config; the fallbacks are `<home>/.local/state` and `<home>/.config`. `~` in XDG values is not expanded. A needed but missing or relative home, or any NUL, is a typed `StoragePathError` with a generic message; the cwd is never used. `newConversationId()` is `crypto.randomUUID()`.

**Atomic writes (one writer for conversations, `active.json`, settings).** The value is validated and encoded to bytes before the first `await` (later mutation by the caller cannot change the write). Then: required directories are prepared, an `.<stem>.<random>.tmp` is created exclusively beside the destination (mode `0600`, re-applied with `chmod` against the umask), every byte is written (partial writes handled), fsynced, closed, and renamed over the destination; the parent directory is then fsynced. **The rename is the commit point.** Cancellation is checked before starting, after every asynchronous step, and last immediately before the rename; every abort reason becomes the project's `AbortError`. A failure or cancellation before the rename closes the handle, removes only this operation's temporary file, and leaves the destination alone; a cleanup problem is reported in `cleanupFailures` on the `StorageIoError` (or on the `AbortError`, read it with `cleanupFailuresOf`). If the signal aborts while the rename is in flight, the save is reported as successful. Kernel I/O that was already submitted cannot be interrupted, so cancellation takes effect at the next boundary. The directory fsync after the rename is best effort, as in both references: when it fails the save still succeeded and the receipt says `directorySynced: false`, so a power loss in that window may still lose the rename. An existing non-regular destination (symlink, directory, ...) is refused, never replaced. Independent simultaneous writes use different temporary names and leave one complete document. There is no cross-process lock: independent instances are last-successful-rename-wins, and a conversation save followed by an active-selection save are two separate commits, not a transaction.

**Ownership and permissions (POSIX).** The conversations directory is owned together with its parent when that parent is named `neurobrau`; otherwise it is owned alone. Settings own their containing directory only (the references only do so when it is named `neurobrau`; this edition treats the explicitly injected directory as the application directory). Owned directories are created `0700` and set to `0700` despite the umask; directories above them are created with default permissions when missing and never changed. An owned location that is a symlink or not a directory is refused before any chmod or write, and a symlink target is never chmod-ed. An active-only save creates just the state application directory. Existing owned directories are tightened by `loadLatest` and by `tightenExistingDirectories()`; this creates nothing and a failure is a warning (`Could not tighten permissions on <path>: <reason>.`), reads still proceed. Explicit saves fail if preparation fails. Umask behavior is checked in isolated child processes (0, 022, 077). Directory/file races between the check and the chmod are not defended against (this is not a hostile-filesystem sandbox). A umask that removes the owner's write bit (such as 0277) makes the ancestors this code creates unusable, as with the references.

**HistoryStore.** `pathFor(id)` accepts only canonical lowercase UUIDs. Only regular files directly inside the directory with the case-sensitive suffix `.json` are considered: subdirectories, symlinks, FIFOs, other special entries, other suffixes and the writer's `.tmp` files are ignored for listing, restoring, counting and deleting. This is a deliberate restriction: the references list every `*.json` name (Go skips directories only). Candidates are sorted by Unicode code point. `loadLatest(accepts?)` loads every candidate, picks the greatest `updatedAt`, then the greatest `mtimeNs` read as a `bigint` (no number conversion), then the first in path order. A file whose name differs from its internal id is accepted (as in the references). Invalid, non-UTF-8, unreadable or un-stat-able files give ordered warnings and stay byte-identical. A missing directory gives no result, no warning, and is not created; an enumeration failure gives no result and one warning. A throwing `accepts` propagates. `matchesSelection` (pure) treats unspecified requests as wildcards, an absent stored provider as `openai`, an absent stored model as matching any model of that provider, and unknown stored providers as exact strings. `countConversations()` / `deleteAll()` include corrupt and non-UUID-named regular `.json` files and nothing else; `deleteAll` reports `{ deleted, error }` on a partial failure and skips files that disappear. It has no confirmation UI: the future command must confirm first. `active.json` is read with `loadActive()` (missing: none, no warning; invalid, unsupported provider, non-UTF-8, non-regular or unreadable: none plus `Ignoring invalid <path>.` / `Ignoring unreadable <path>: <reason>.`, file kept) and written with `saveActive()`; saving a conversation never touches it. Writes (`save`, `saveActive`, `deleteAll`) of one instance run one at a time in invocation order; a queued write whose signal aborts rejects at once without running.

**SettingsStore.** A state machine: *unloaded* (`save` is refused, `not-loaded`; an intentional strengthening of the references' API), *writable* (a load found no file or a usable document; recoverable notices do not matter), *disabled* (a load hit a whole-file codec failure, a non-regular entry or a read failure). *Disabled* is final for the instance: later loads return defaults and the same warning without touching the disk, and `save` returns `disabled` with `Settings not saved: <path> could not be read at startup.`; a new instance is needed after the owner fixes or removes the file. `load` and `save` of one instance run in invocation order, so an invalid load followed by an immediately queued save cannot overwrite the file. Loading never creates the file. Stored limits stay `bigint | null | absent`; no conversion into the number-based resolver exists yet. An I/O failure on save is a typed outcome (`io-error`) and leaves the instance writable; cancellation rejects with `AbortError`; invalid values throw `StorageCodecError`. Load warnings: `Could not read settings at <path>: <reason>. Using defaults; changes will not be saved.` and `Ignoring invalid settings file <path>: <message>. Using defaults; changes will not be saved until the file is fixed or removed.`

**Diagnostics.** Messages use fixed reasons by error code (`Permission denied`, `No space left on device`, ...) or `I/O error`; the underlying error is kept only in `cause`/`code`. Paths in messages show control characters as `\xNN` / `\uNNNN` escapes (a path that literally contains such text is indistinguishable, an accepted ambiguity). Differences from the references: Python/Go print raw paths and OS-specific wording; temporary-file permission failures and non-regular entries get their own reasons.

**Testing seam.** `StorageFs` (in `node-fs.ts`) is the only injection point: `lstat` (bigint mtimes), `readdir`, `readFile` (opened `O_NOFOLLOW|O_NONBLOCK` and checked with `fstat`, so a FIFO swapped in after listing cannot block), `mkdir`, `chmod`, `createExclusive`, `rename`, `unlink`, `syncDirectory`. Tests wrap the real implementation to inject failures and deferred gates; production never sets it.
