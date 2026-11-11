# Fullscreen chat (Tasks 008 and 009)

The DOS-style fullscreen chat (the completed `0.3.0` TUI milestone; `0.4.0-dev` adds the estimated cost). Reference: Python `docs/tui-spec.md` sections 1–10, 11 (restore/save/reset/cleanup), 14 (fullscreen streaming) and 16, at commit `0a6d045c022b850371a1c51a1df30f11d9d4c60e`; Go `internal/tui` at `b064decc66cad7d9656488bdf7749650b52cf309` as a reliability example. Task 009 adds the F2–F6 menus, provider/model switching with independent conversations, and saved preferences (sections 4b, 4c, 11 switching, 13 writes; Python `ui/menu.py`, `tui.py`, `preferences.py`, `session.py`, Go `internal/tui/{menu,controls,operation}.go` and their tests). Pricing (section 15) is **not** implemented.

## When it starts

The fullscreen chat is used for a chat invocation (no prompt) only when all of these hold; the decision lives in `src/tui/eligibility.ts` and nowhere else:

1. stdin **and** stdout are TTYs;
2. `TERM` is present, non-empty, not `dumb`, and in the supported family: `xterm`, `screen`, `tmux`, `rxvt` or a `-variant` of these (`xterm-256color`, `screen-256color`, `tmux-256color`, `rxvt-unicode-256color`, …). Any other value falls back to the plain chat — an intentional temporary difference from the reference's terminfo-backed portability. Linux is the only target; Windows is not an acceptance target;
3. the input stream can be put into raw mode;
4. `--plain` was not given.

Everything else (pipes, redirects, unknown `TERM`, `--plain`) runs the existing line-oriented chat, which writes no escape sequences. Help, version, argument errors and one-shot prompts never inspect or touch the terminal. `--plain` is carried through argument parsing to this decision. `NO_COLOR` or a `-mono` `TERM` selects the monochrome style (bold for border/user/AI/error, reverse for the waiting indicator, normal otherwise).

**Startup order.** Provider/key checks, model, capabilities, saved settings and history restore all happen *before* the terminal is changed. A missing key exits 3 without touching the terminal; other startup errors use the existing exit mappings. Startup warnings become error entries (`Warning: …`) after the restored messages, followed by the `Restored conversation from … (N messages)` notice. If the terminal then cannot be initialized, the partial setup is undone and the program exits 1 with `neurobrau: error: could not initialize the terminal` — no startup is repeated and no request is made.

## Layout

80×25 baseline; for `R` rows and `C` columns: title border row 0; conversation rows 1…`R-7`; status separator `R-6`; runtime status `R-5`; input separator `R-4`; input `R-3`; bottom border `R-2`; help line `R-1` (never written in its last cell). The settings panel needs `C ≥ 64` (separator at `P = C-22`, 18 content columns); the conversation text width is `C-25` with the panel and `C-4` without. Minimum 40×12; below it a three-line clipped message is shown, the draft and all state are kept, exit/cancel/input keep working and the layout returns on resize. All text is placed through one clipped, addressed writer; every cell is a single displayable character.

The title is `NeuroBräu TypeScript CLI <package version>`. While scrolled up it reads `… - scrolled up N (PgDn)`; a long title gives way to that suffix.

Panel (`src/tui/panel.ts`): model, provider, reasoning, max tokens and answer style, then **conversation totals** summed exactly with `bigint` over the stored usage records (`?` for a count no request reported, zero stays zero), `cached`/`reasoning` only when positive (they are parts of input/output and never added again), `context` = input of the latest completed request, and `COST (EST.)` the short estimated cost of the current selection's records (`-` without records, `$0 (local)`, `$0.002165`, `~$…` qualified, `>=$…` partial, `unavailable`; `docs/pricing.md`), computed once per state refresh (restore, accepted request, switch, reset, cleanup), never per frame. Abbreviation (`12.3k`, `4.56M`, `2G`) only when the exact text does not fit, with three significant digits, by integer arithmetic.

## Text, controls and wrapping

Entries are wrapped like the references (Python `textwrap.wrap`): explicit breaks kept, tabs to stops of four, leading indentation kept on continuations up to half the width, greedy words, long words split, widths counted in code points (CJK/emoji width is the references' documented limitation). Wrapping is cached per explicit line, so a growing answer re-wraps only its last line.

Terminal controls: ESC and every other C0/C1 control (TAB/LF/CR are consumed by wrapping), DEL, lone surrogates and U+2028/2029 are replaced by U+FFFD **only when rendering**; stored, sent and committed text is never changed. The cell writer is a second, independent gate: no frame cell can hold a control, so a model cannot leave the alternate screen, move the cursor, change the title or set colors. `--transcript-on-exit` is the one place where text is printed to the real terminal. When stdout is a terminal (the injected `stdoutIsTTY`; always true for the fullscreen chat, which requires it) the same replacement is applied to the printed copy: ESC and other C0/C1 controls, DEL, lone surrogates, U+2028/2029 and a lone CR become U+FFFD, while LF, CRLF and tabs are kept. Stored messages are never altered. For non-TTY output the transcript is exact (the function supports it; the fullscreen chat itself cannot run with a redirected stdout, so that case is covered by unit tests of the formatter).

## Keys

| Key | Action |
| --- | --- |
| printable text | insert at the cursor (a paste arrives as text; the draft is capped at 8 Mi UTF-16 units, the plain chat's line limit, with a warning) |
| Enter | submit |
| Backspace / Delete, Left / Right, Home or Ctrl+A, End or Ctrl+E, Ctrl+U | edit |
| Up / Down, PgUp / PgDn | scroll by 1 line / by height − 1 |
| F1 | `/help` (the draft is kept) |
| F2 / F3 / F4 / F5 / F6 | model / provider / reasoning / max output tokens / answer style menus (below); during a request `WARNING \| Settings cannot change while a response is generated`, during a check `Wait for the current check or press Ctrl+C` |
| Esc | closes a menu or the custom-token prompt; ignored elsewhere |
| Ctrl+D | exit 0 on an empty draft, idle only |
| Ctrl+C | cancels a running request; otherwise exit 130 |

xterm, rxvt, tmux and `SS3` forms of the arrows, Home/End, PgUp/PgDn, Delete and F1–F6 are decoded across arbitrary chunk boundaries (including split UTF-8). A lone Esc is dropped after about 25 ms; unsupported sequences are swallowed whole (the sequence buffer is bounded), so no raw bytes reach the draft and an escape sequence can never be submitted as a message.

Commands: `/help`, `/usage` (token report plus the estimated cost line, identical to the plain chat), `/reset`, `/cleanup` (the next submitted line is the answer and is never a message or command; only `yes` deletes), `/exit` and backslash aliases, case-insensitively. During a request `/help`, `/usage` and `/exit` work; other submissions are refused with the draft kept.

## Requests, status and cancellation

The controller (`src/tui/controller.ts`) owns visible entries and request identity; the session (`ChatSession`) owns committed messages. A failed, cancelled or partial answer stays visible but is never in a later request or in storage. At most one provider operation exists: a request starts only from the idle phase, i.e. after the previous operation settled; a provider that ignores cancellation beyond the bounded cleanup (default 2 s) ends the program with exit 130 instead of overlapping a second one.

Cancelling retires the request first (so a late delta can neither display nor commit), then aborts it; the stream is closed exactly once (Task 007 `consumeStream`). Completion is accepted only after the stream closed successfully, and acceptance plus `applyCompleted` are one synchronous step; persistence is awaited afterwards in a `saving` phase that exit waits for. A terminal event whose close never settles is a failure (`the response stream could not be closed`, exit 1, nothing committed). Output uses a pull-based pipeline: the next provider event is requested only after the previous delta was applied, with a yield after every 256 events; one frame is drawn at a time and frames are coalesced, so a stalled terminal stalls the consumer rather than growing a queue. Reasoning only switches the status to `Thinking`.

Status (`READY`, `CONNECTING`, `GENERATING`, `DONE`, `CANCELLED`, `ERROR`, `WARNING`) follows spec section 5; elapsed time is observed by this client and redrawn every 100 ms, provider-reported durations are used only when reported (`DONE` appears once the exchange is also saved). Transient states end with the next non-resize key.

## Menus (Task 009)

Each menu is a bordered overlay on the conversation (title, `<n>/<total> Enter=OK Esc=cancel` footer, at least 30 and at most C-2 columns wide, centered over the conversation area or the whole width, at most height-2 rows with the highlight scrolled into view, the selected row in reverse video, `* ` on the *effective current* item independently of the highlight, optional right-aligned note only when it fits). Up/Down/PgUp/PgDn/Home/End move (clamped), Enter selects, Esc and Ctrl+D cancel, Ctrl+C in an idle open menu exits 130; everything else - text, editing keys, F-keys - goes nowhere. A resize re-clamps the geometry and keeps the highlight, draft and selection; below 40x12 the state is kept and the too-small text is shown. A lone Esc becomes a key 25 ms after it arrived, so arrow and F-key sequences (also split across chunks) are never taken for Esc.

- **F3 provider**: lists OpenAI and Ollama without any request, key lookup or construction. Choosing the current provider does nothing. Choosing the other one shows `CONNECTING | Checking <Label>`, applies the existing key/host check, builds the provider lazily (and keeps it with its caches), asks `checkAvailability`, takes that provider's own default model, then `Checking model settings`. A missing key, an invalid `OLLAMA_HOST`, an unavailable server or any provider error is `<Label> is not available: <reason>`, in the error role, with selection, conversation, settings, draft and files unchanged - never exit 3.
- **F2 model**: `CONNECTING | Loading <Label> models`, then the provider's selectable models in its own order (a defensive filter drops remote and non-completion entries and duplicates; no case/`:latest`/alias normalisation; notes are the reported details). A current explicit OpenAI model missing from the list stays active and is not invented. Errors are `Error: <message>`, an empty list `No selectable <Label> models were found.`. Choosing a different model shows `Checking model settings`.
- **F4 reasoning**: `Checking reasoning support`; unknown support offers only `Model default (support unknown)` plus the reference explanation; confirmed none says `<model> does not support reasoning.`; otherwise `Model default` (only where omitting the parameter is allowed; note `no effort sent[: <modelDefault>]`) and the provider's values in order with labels None/Minimal/Low/Medium/High/XHigh/Max/Off/On. The current item follows the explicit choice and its provenance: an explicit model default is marked, mere absence of a parameter is not.
- **F5 max output tokens**: `Checking model limits`; Default (`model default`), the presets 256-4096 not above a known limit, `Custom...` (`up to <limit>` / `any positive number`; `Custom (<n>)` when the current value is not a preset). Custom sets the draft and cursor aside, shows `TOKENS > ` with `READY | Type a token limit and press Enter | Esc cancels`; digits only (trimmed), validated as `bigint` before any conversion: non-digits/empty, 0, above the model limit and (this edition) above 9007199254740991 stay in the prompt with a message and change nothing; slash commands typed there are just invalid input; F-keys do nothing; Esc restores the exact draft and cursor.
- **F6 answer style**: Brief / Normal / Detailed with the reference notes; global.

A confirmed choice applies to the next message, appends the reference confirmation (`Reasoning for <model>: …`, `Max output tokens for <model>: …`, `Answer style: …`) and is saved. It never clears the conversation. Choosing exactly what is already saved (with no command-line override of that field) appends nothing and writes nothing.

### Selections, conversations and usage

Every exact provider/model has its own committed messages, id, timestamps, usage records and file; nothing is sent across selections. Switching prefers a conversation remembered earlier in this run (also after a failed save: memory wins over the older file), then the newest matching file (legacy files: no provider = OpenAI, no model = any model of that provider), then a new empty conversation that is saved at once (with `active.json`) so a restart restores the selection. Returning to a remembered or restored conversation does not rewrite its file; only `active.json` is updated when it differs. An empty conversation with a file (for example after `/reset`) is remembered, so A → `/reset` → B → A returns A's empty post-reset conversation; an empty conversation without a file is simply dropped. `/reset` replaces only the active selection's conversation; a confirmed `/cleanup` also forgets every remembered selection (a partial deletion failure keeps them). `--no-history` keeps the same registry in memory with no reads or writes of conversation files or `active.json` (settings are still loaded and saved). After a switch the panel shows only the target's committed messages and the reference notice (`Now using <Label> / <model>. Restored its conversation (<n> messages).` or `… Started a new conversation[; the previous one stays saved.| ; the previous messages are not sent to the new model.|.]`). `--transcript-on-exit` prints only the current selection.

The synchronous acceptance boundary is `Workspace.accept`: everything before it (provider construction, availability, default model, capabilities, settings resolution, the conversation lookup) is cancellable and changes nothing; after it the new selection is in force, its storage writes are awaited (exit waits for them; no generation, switch, reset or cleanup overlaps them) and a failure is only a `Warning:`.

### Saved preferences

Precedence is command line > valid saved > built-in. Startup resolution stays strict (exit 2 before the terminal is touched); switching is lenient (the resolver's notice, then the saved value, then the built-in). The command-line values are kept apart from resolved values: a confirmed F4/F5/F6 choice clears only its own field's override for the rest of the run, and nothing from the command line is ever saved. `Model default` is stored as `"default"` and `Default` tokens as an explicit `null`; both stay explicit (parameter omitted, adapter's implicit-reasoning fallback not eligible). Saving goes through the very `SettingsStore` that loaded the file: other valid entries (other providers/models, unknown provider names, `__proto__`, limits beyond 2^53) are carried over unchanged, a store disabled at startup (corrupt, unreadable, symlink) stays unwritable even if the file is repaired later, and with no usable configuration location the change stays in memory with `Warning: Settings not saved: the configuration location is not known.`. A failed write keeps the choice for this run (`WARNING | Settings not saved`); a later successful change writes the whole current document. Missing settings files or directories are normal until a choice is confirmed.

## Known limitations

- **Ctrl+Z / suspend:** in raw mode Ctrl+Z arrives as a key and is ignored; SIGTSTP/SIGCONT are not handled, so an externally suspended process leaves the alternate screen as it is and does not redraw on continue.
- **Paste:** bracketed paste is not enabled. A paste arrives as ordinary input: its text is inserted (capped at 8 Mi UTF-16 units, the excess dropped with a warning) but each newline in it acts as Enter and submits what came before.
- CJK/emoji display width is one column per code point.

## Exit and restoration

Exit paths: `/exit` and Ctrl+D (0), idle Ctrl+C or external SIGINT (130), SIGTERM (143), SIGHUP (129), end of terminal input (0), unexpected error (1, fixed text `an internal error occurred`), output failure (EPIPE 141 quietly, otherwise 1 `cannot write output`). The terminal is restored — leave the alternate screen, show the cursor, reset styles, restore autowrap, restore raw mode and pause stdin *only if this run changed them* — exactly once, before any diagnostic or transcript is written. The adapter is `src/tui/ansi-terminal.ts`; importing it changes nothing, and signal listeners exist only between startup and exit (one handler for all three signals). SIGKILL and power loss cannot be handled by any program.

`--transcript-on-exit` prints the committed messages (restored ones included, never errors, notices, reasoning or partial exchanges) as `YOU > …` / `AI > …`, separated by one blank line with a final newline, nothing for an empty conversation; in the plain chat it is accepted and has no effect.

## Tests

Deterministic fake-terminal/controller tests (`tests/tui-*.test.ts`), the production adapter over in-memory streams, and a real Linux pseudo-terminal test through a test-only Python standard-library driver (`tests/helpers/pty_driver.py`; skipped and reported as skipped when `python3` or its `pty` module is unavailable). The PTY test cannot prove the restore on its own for line-discipline flags, because Node also resets the terminal at process exit; it checks the emitted sequences and the raw-mode state while running.
