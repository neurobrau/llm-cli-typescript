import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InputEditor } from "../src/tui/editor.js";
import { isSupportedTerm, selectChatMode } from "../src/tui/eligibility.js";
import { createFrame, put, frameLines } from "../src/tui/frame.js";
import { KeyDecoder } from "../src/tui/keys.js";
import type { Key } from "../src/tui/keys.js";
import { MIN_COLS, MIN_ROWS, computeLayout, horizontalRule, visibleWindow } from "../src/tui/layout.js";
import { compact, panelStats, settingsPanelRows } from "../src/tui/panel.js";
import { activeStatus, doneStatus, statusText } from "../src/tui/status.js";
import { expandTabs, fit, isUnsafe, neutralize, splitLines, wrapParagraphs } from "../src/tui/text.js";
import { transcriptText } from "../src/tui/texts.js";
import type { ResolvedSettings } from "../src/domain/settings.js";
import type { StoredUsageRecord } from "../src/storage/types.js";

// Fixtures below are the cases of the Go reference test TestWrapParagraphsMatchesPython
// (llm-cli-go internal/tui/wrap_test.go) and of Python tests/test_tui.py wrap tests.
void describe("wrapParagraphs", () => {
  const cases: readonly (readonly [string, number, string[]])[] = [
    ["A neural network is a model made of layers of connected units that learn weights from data.", 50, ["A neural network is a model made of layers of", "connected units that learn weights from data."]],
    ["", 10, [""]],
    ["one\n\ntwo\n", 10, ["one", "", "two"]],
    ["trailing\n\n", 10, ["trailing", ""]],
    ["abcdefghijklmnopqrstuvwxyz", 10, ["abcdefghij", "klmnopqrst", "uvwxyz"]],
    ["ab verylongword more", 10, ["ab verylon", "gword more"]],
    ["abcd efghijklmnop", 5, ["abcd", "efghi", "jklmn", "op"]],
    ["    indented code line that wraps around", 20, ["    indented code", "    line that wraps", "    around"]],
    ["\tx = 1\n\t\ty\nab\tc", 20, ["    x = 1", "        y", "ab  c"]],
    ["                    deep indent text here", 10, ["     deep", "     inden", "     t", "     text", "     here"]],
    ["Grüß Gott, Привет мир, this wraps", 12, ["Grüß Gott,", "Привет мир,", "this wraps"]],
    ["a  b   c", 3, ["a", "b", "c"]],
    ["well-known hyphenated-words stay", 12, ["well-known h", "yphenated-wo", "rds stay"]],
    ["   ", 10, [""]],
    ["x\r\ny\rz", 10, ["x", "y", "z"]],
    ["word word word word word ", 9, ["word word", "word word", "word"]],
    ["Intro\n\n    def very_long_function_name(argument):\nEnd", 20, ["Intro", "", "    def very_long_fu", "    nction_name(argu", "    ment):", "End"]],
    ["x".repeat(25), 10, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]],
  ];
  for (const [text, width, expected] of cases) {
    void it(`${JSON.stringify(text).slice(0, 50)} at ${String(width)}`, () => {
      assert.deepEqual(wrapParagraphs(text, width), expected);
    });
  }

  void it("never exceeds the width at any width, with Unicode and non-BMP characters", () => {
    const text = "Здравствуйте! Ein sehr langes Wort: Donaudampfschifffahrtsgesellschaftskapitän.\n\n\tcode()\n   x 😀😀😀😀😀😀😀😀 end";
    for (let width = 1; width <= 30; width += 1) {
      for (const line of wrapParagraphs(text, width)) {
        assert.ok(Array.from(line).length <= width, `width ${String(width)}: ${JSON.stringify(line)}`);
      }
    }
  });

  void it("never splits a non-BMP character", () => {
    const lines = wrapParagraphs("😀".repeat(7), 3);
    assert.deepEqual(lines, ["😀😀😀", "😀😀😀", "😀"]);
    for (const line of lines) assert.ok(!/[\uD800-\uDBFF]$/u.test(line) && !/^[\uDC00-\uDFFF]/u.test(line));
  });

  void it("expands tabs to stops of four and splits lines like the references", () => {
    assert.equal(expandTabs("a\tb\n\tc", 4), "a   b\n    c");
    assert.deepEqual(splitLines("a\r\nb\rc\n"), ["a", "b", "c"]);
    assert.deepEqual(splitLines(""), [""]);
  });

  void it("clips with a tilde and counts code points", () => {
    assert.equal(fit("gpt-6-luna-2026-10-01-preview", 17), "gpt-6-luna-2026-~");
    assert.equal(fit("😀😀😀", 3), "😀😀😀");
    assert.equal(fit("😀😀😀😀", 3), "😀😀~");
  });
});

const hasControl = (text: string, keepBreaks: boolean): boolean => Array.from(text).some((char) => isUnsafe(char, keepBreaks));

void describe("neutralize and frame writes", () => {
  void it("replaces ESC, C0, C1, DEL and lone surrogates but keeps text, TAB/LF/CR and pairs", () => {
    const bad = "a\u001b]0;title\u0007b\u009bc\u0000d\u007fe\uD800f";
    const safe = neutralize(bad);
    assert.ok(!hasControl(safe, true));
    assert.equal(neutralize("ok\tline\r\n😀"), "ok\tline\r\n😀");
    assert.ok(safe.startsWith("a�]0;title"));
  });

  void it("put is the last gate: no control character, and nothing outside the grid, ever lands in a cell", () => {
    const frame = createFrame(2, 6);
    put(frame, 0, 0, "\u001b[2Jhi\n\t\u009b", "text");
    put(frame, 1, 4, "abcdef", "text");
    put(frame, 5, 0, "x", "text"); // outside rows
    put(frame, 0, -2, "yz", "text"); // outside columns
    put(frame, 1, 0, "k", "text", 0); // limit before the start
    for (const line of frameLines(frame)) {
      assert.equal(Array.from(line).length, 6);
      assert.ok(!hasControl(line, false));
    }
    assert.equal(frameLines(frame)[0], "�[2Jhi");
    assert.equal(frameLines(frame)[1], "    ab");
  });
});

void describe("layout", () => {
  void it("matches the specified rows and columns at 80x25", () => {
    const layout = computeLayout({ rows: 25, cols: 80 });
    assert.ok(layout !== undefined);
    assert.equal(layout.conversationTop, 1);
    assert.equal(layout.conversationHeight, 18);
    assert.equal(layout.statusSeparatorRow, 19);
    assert.equal(layout.statusRow, 20);
    assert.equal(layout.inputSeparatorRow, 21);
    assert.equal(layout.inputRow, 22);
    assert.equal(layout.bottomRow, 23);
    assert.equal(layout.helpRow, 24);
    assert.equal(layout.panelX, 58);
    assert.equal(layout.conversationWidth, 55);
    assert.equal(layout.innerWidth, 76);
  });

  void it("shows the panel from 64 columns and widens the conversation below", () => {
    assert.equal(computeLayout({ rows: 25, cols: 63 })?.panelX, undefined);
    assert.equal(computeLayout({ rows: 25, cols: 63 })?.conversationWidth, 59);
    assert.equal(computeLayout({ rows: 25, cols: 64 })?.panelX, 42);
    assert.equal(computeLayout({ rows: 25, cols: 64 })?.conversationWidth, 39);
  });

  void it("has a 40x12 minimum", () => {
    assert.ok(computeLayout({ rows: MIN_ROWS, cols: MIN_COLS }) !== undefined);
    assert.equal(computeLayout({ rows: MIN_ROWS - 1, cols: 80 }), undefined);
    assert.equal(computeLayout({ rows: 25, cols: MIN_COLS - 1 }), undefined);
    assert.equal(computeLayout({ rows: 12, cols: 40 })?.conversationHeight, 5);
  });

  void it("draws rules of exact width and windows scrolled lines", () => {
    assert.equal(horizontalRule(20, "Status"), "+-[ Status ]-------+");
    assert.equal(horizontalRule(10, ""), "+--------+");
    assert.equal(horizontalRule(8, "A very long title"), "+-[ A v+");
    assert.deepEqual(visibleWindow(30, 18, 0), [12, 30]);
    assert.deepEqual(visibleWindow(30, 18, 5), [7, 25]);
    assert.deepEqual(visibleWindow(5, 18, 0), [0, 5]);
  });
});

function usage(overrides: Partial<StoredUsageRecord["usage"]>, status: "completed" | "incomplete" = "completed"): StoredUsageRecord {
  return { at: new Date(0), provider: "ollama", model: "m", status, usage: overrides };
}

const SETTINGS: ResolvedSettings = {
  provider: "ollama",
  model: "qwen3.5:4b",
  reasoning: { effort: "off", explicit: false, source: "builtin" },
  maxOutputTokens: { explicit: false, source: "builtin" },
  answerStyle: { value: "normal", source: "builtin" },
};

void describe("settings panel", () => {
  void it("shows the baseline rows and exact conversation totals", () => {
    const stats = panelStats([usage({ inputTokens: 10n, outputTokens: 20n, totalTokens: 30n }), usage({ inputTokens: 7n, outputTokens: 10n, totalTokens: 17n })]);
    assert.deepEqual(
      settingsPanelRows(SETTINGS, stats).map((row) => row.text),
      ["F2 MODEL", " qwen3.5:4b", "F3 PROVIDER", " Ollama", "F4 REASONING", " off", "F5 MAX TOKENS", " default", "F6 ANSWER STYLE", " normal", "TOKENS", " in 17 out 30", " total 47", " context 7", "COST (EST.)", " unavailable"],
    );
  });

  void it("shows - without usage, ? for never-reported counts and zero for reported zero", () => {
    assert.deepEqual(settingsPanelRows(SETTINGS, panelStats([])).slice(10).map((row) => row.text), ["TOKENS", " -", "COST (EST.)", " unavailable"]);
    const rows = settingsPanelRows(SETTINGS, panelStats([usage({ inputTokens: 0n })])).map((row) => row.text);
    assert.deepEqual(rows.slice(11, 14), [" in 0 out ?", " total ?", " context 0"]);
  });

  void it("lists cached and reasoning parts only when positive, and never adds them to input or output", () => {
    const stats = panelStats([usage({ inputTokens: 1000n, outputTokens: 200n, totalTokens: 1200n, cachedInputTokens: 600n, reasoningTokens: 50n })]);
    const rows = settingsPanelRows(SETTINGS, stats).map((row) => row.text);
    assert.deepEqual(rows.slice(11, 16), [" in 1000 out 200", " total 1200", " cached 600", " reasoning 50", " context 1000"]);
    const zero = settingsPanelRows(SETTINGS, panelStats([usage({ inputTokens: 1n, cachedInputTokens: 0n, reasoningTokens: 0n })])).map((row) => row.text);
    assert.ok(!zero.some((row) => row.includes("cached") || row.includes("reasoning ")));
  });

  void it("abbreviates only when needed, with three significant digits and exact bigint arithmetic", () => {
    // Python test_large_numbers_are_abbreviated_only_when_needed
    const stats = panelStats([usage({ inputTokens: 123_456_789n, outputTokens: 9_876_543n, totalTokens: 133_333_332n, cachedInputTokens: 100_000_000n, reasoningTokens: 5_000_000n })]);
    const rows = settingsPanelRows(SETTINGS, stats).map((row) => row.text);
    assert.deepEqual(rows.slice(11, 15), [" in 123M out 9.88M", " total 133333332", " cached 100M", " reasoning 5M"]);
    assert.ok(rows.every((row) => Array.from(row).length <= 18));
    assert.deepEqual(
      [undefined, 9_999n, 10_000n, 12_345n, 1_234_567n, 2_000_000_000n, 999_999n, 999_500_000n].map(compact),
      ["?", "9999", "10k", "12.3k", "1.23M", "2G", "1M", "1G"],
    );
  });

  void it("never loses precision beyond 2^53", () => {
    const huge = 2n ** 70n; // 1180591620717411303424
    const stats = panelStats([usage({ inputTokens: huge }), usage({ inputTokens: 1n })]);
    assert.equal(stats.input, huge + 1n);
    assert.equal(compact(huge).includes("e"), false);
    const rows = settingsPanelRows(SETTINGS, stats).map((row) => row.text);
    assert.ok(rows.every((row) => Array.from(row).length <= 18));
    assert.equal(panelStats([usage({ inputTokens: 9_007_199_254_740_993n }), usage({ inputTokens: 0n })]).input, 9_007_199_254_740_993n);
  });

  void it("clips long values with ~ and shows the explicit settings", () => {
    const rows = settingsPanelRows(
      { ...SETTINGS, provider: "openai", model: "gpt-6-luna-2026-10-01-preview", reasoning: { explicit: true, source: "cli" }, maxOutputTokens: { value: 512, explicit: true, source: "cli" }, answerStyle: { value: "brief", source: "cli" } },
      panelStats([]),
    ).map((row) => row.text);
    assert.deepEqual(rows.slice(0, 10), ["F2 MODEL", " gpt-6-luna-2026-~", "F3 PROVIDER", " OpenAI", "F4 REASONING", " model default", "F5 MAX TOKENS", " 512", "F6 ANSWER STYLE", " brief"]);
  });

  void it("counts incomplete requests in totals but not in the latest context", () => {
    const stats = panelStats([usage({ inputTokens: 5n }), usage({ inputTokens: 9n }, "incomplete")]);
    assert.equal(stats.input, 14n);
    assert.equal(stats.context, 5n);
  });
});

void describe("status", () => {
  void it("formats the live and finished states", () => {
    assert.equal(statusText(activeStatus("CONNECTING", 0.44)), "CONNECTING | 0.4s elapsed | Ctrl+C Cancel");
    assert.equal(statusText(activeStatus("GENERATING", 1.3, "Thinking")), "GENERATING | Thinking | 1.3s elapsed | Ctrl+C Cancel");
  });

  void it("DONE uses provider durations when reported and the observed latency otherwise", () => {
    const ollama = doneStatus({ timing: { totalSeconds: 7.17, loadSeconds: 0.2, evalSeconds: 1.88 } }, 30n, 9, 1);
    assert.equal(statusText(ollama), "DONE | 7.17s total | load 0.20s | generation 1.88s | 15.96 tok/s");
    assert.equal(statusText(doneStatus(undefined, 30n, 2.5, 0.4)), "DONE | 2.50s observed | first text after 0.40s");
    assert.equal(statusText(doneStatus(undefined, 30n, 2.5, undefined)), "DONE | 2.50s observed");
    assert.equal(statusText(doneStatus({ timing: { totalSeconds: 3 } }, undefined, 9, 1)), "DONE | 3.00s total");
  });
});

void describe("input editor", () => {
  void it("inserts, moves and deletes by code point", () => {
    const editor = new InputEditor();
    editor.insert("Grüß 😀 Привет");
    editor.home();
    editor.right();
    editor.right();
    editor.insert("X");
    assert.equal(editor.text, "GrXüß 😀 Привет");
    editor.end();
    editor.backspace();
    assert.equal(editor.text, "GrXüß 😀 Приве");
    editor.home();
    for (let i = 0; i < 6; i += 1) editor.right();
    assert.equal(editor.cursor, 6); // after "GrXüß " - emoji not yet crossed
    editor.right();
    assert.equal(editor.cursor, 8); // the pair counts as one step
    editor.backspace();
    assert.equal(editor.text, "GrXüß  Приве");
    editor.delete();
    assert.equal(editor.text, "GrXüß Приве");
    editor.clear();
    assert.equal(editor.isEmpty, true);
    editor.backspace();
    editor.delete();
    editor.left();
    assert.equal(editor.cursor, 0);
  });

  void it("scrolls horizontally so the cursor stays visible", () => {
    const editor = new InputEditor();
    editor.insert("0123456789abcdefghij");
    assert.deepEqual(editor.viewport(10), { visible: "bcdefghij", column: 9 });
    editor.home();
    assert.deepEqual(editor.viewport(10), { visible: "0123456789", column: 0 });
    for (let i = 0; i < 9; i += 1) editor.right();
    assert.deepEqual(editor.viewport(10), { visible: "0123456789", column: 9 });
    editor.right();
    assert.deepEqual(editor.viewport(10), { visible: "123456789a", column: 9 });
    editor.insert("😀");
    const view = editor.viewport(10);
    assert.ok(Array.from(view.visible).length <= 10);
    assert.equal(Array.from(view.visible).at(view.column - 1), "😀");
  });

  void it("is bounded: oversized input is cut without splitting a pair", () => {
    const editor = new InputEditor(8);
    assert.equal(editor.insert("12345"), true);
    assert.equal(editor.insert("😀😀"), false);
    assert.equal(editor.text, "12345😀".slice(0, 7)); // 5 + one pair; the second pair does not fit
    assert.equal(editor.text.length, 7);
    assert.equal(editor.insert("ab"), false);
    assert.equal(editor.text.length, 8);
    editor.set("x".repeat(100));
    assert.equal(editor.text.length, 8);
  });
});

function decode(chunks: readonly (string | Uint8Array)[]): Key[] {
  const decoder = new KeyDecoder();
  return chunks.flatMap((chunk) => decoder.feed(chunk));
}
const names = (keys: readonly Key[]): string[] => keys.map((key) => (key.kind === "key" ? key.name : key.kind === "text" ? `text:${key.text}` : "ignored"));

void describe("key decoder", () => {
  void it("decodes the supported keys in the xterm, rxvt and tmux forms", () => {
    const table: readonly (readonly [string, string])[] = [
      ["\r", "enter"], ["\n", "enter"], ["\x7f", "backspace"], ["\b", "backspace"],
      ["\x1b[3~", "delete"], ["\x1b[D", "left"], ["\x1bOD", "left"], ["\x1b[C", "right"], ["\x1b[A", "up"], ["\x1b[B", "down"],
      ["\x1b[H", "home"], ["\x1b[1~", "home"], ["\x1b[7~", "home"], ["\x1bOH", "home"],
      ["\x1b[F", "end"], ["\x1b[4~", "end"], ["\x1b[8~", "end"], ["\x1bOF", "end"],
      ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"],
      ["\x1bOP", "f1"], ["\x1b[11~", "f1"], ["\x1b[1;2P", "f1"], ["\x1bOQ", "f2"], ["\x1b[12~", "f2"], ["\x1bOR", "f3"], ["\x1b[13~", "f3"],
      ["\x1bOS", "f4"], ["\x1b[14~", "f4"], ["\x1b[15~", "f5"], ["\x1b[17~", "f6"],
      ["\x01", "ctrl-a"], ["\x03", "ctrl-c"], ["\x04", "ctrl-d"], ["\x05", "ctrl-e"], ["\x15", "ctrl-u"],
    ];
    for (const [bytes, name] of table) assert.deepEqual(names(decode([bytes])), [name], JSON.stringify(bytes));
  });

  void it("gives the same result for every split of a byte stream, including inside UTF-8 and escapes", () => {
    const text = "a\x1b[1;5Cb\x1b[15~Привет😀\x1bOA\r";
    const bytes = Buffer.from(text, "utf8");
    const whole = names(decode([bytes]));
    for (let at = 1; at < bytes.length; at += 1) {
      // Printable runs are joined per chunk, so compare the concatenated text and the key order.
      const keys = decode([bytes.subarray(0, at), bytes.subarray(at)]);
      assert.equal(flatten(keys), flatten(decode([bytes])), `split at ${String(at)}`);
    }
    assert.ok(whole.includes("f5"));
    // One byte at a time.
    const single = Array.from(bytes, (byte) => Uint8Array.of(byte));
    assert.equal(flatten(decode(single)), flatten(decode([bytes])));
  });

  void it("consumes unsupported sequences without leaking bytes into the text", () => {
    const keys = decode(["x\x1b[1;5Cy\x1b[200~z\x1b[99;99;99Xq\x1bw\x1b[?1;2cR"]);
    assert.equal(keys.flatMap((key) => (key.kind === "text" ? [key.text] : [])).join(""), "xyzqR");
    assert.ok(!keys.some((key) => key.kind === "text" && hasControl(key.text, false)));
  });

  void it("ignores TAB, NUL, C1 and other controls", () => {
    assert.deepEqual(names(decode(["a\tb\u0000c\u009bd\u0007e"])), ["text:abcde"]);
  });

  void it("treats CR LF as one Enter", () => {
    assert.deepEqual(names(decode(["a\r\nb"])), ["text:a", "enter", "text:b"]);
    assert.deepEqual(names(decode(["a\r", "\nb"])), ["text:a", "enter", "text:b"]);
  });

  void it("a lone ESC is pending until dropped; a following sequence completes normally", () => {
    const decoder = new KeyDecoder();
    assert.deepEqual(decoder.feed("\x1b"), []);
    assert.equal(decoder.pendingEscape, true);
    decoder.dropEscape();
    assert.equal(decoder.pendingEscape, false);
    assert.deepEqual(names(decoder.feed("x")), ["text:x"]);
    decoder.feed("\x1b");
    assert.deepEqual(names(decoder.feed("[A")), ["up"]);
  });

  void it("bounds the sequence buffer", () => {
    const decoder = new KeyDecoder();
    decoder.feed("\x1b[");
    const keys = decoder.feed("1".repeat(5000));
    assert.ok(keys.every((key) => key.kind !== "text"));
    assert.deepEqual(names(decoder.feed("Z")), ["ignored"]); // the final byte ends the swallowed sequence
    assert.deepEqual(names(decoder.feed("k")), ["text:k"]);
  });
});

function flatten(keys: readonly Key[]): string {
  return keys.map((key) => (key.kind === "key" ? `<${key.name}>` : key.kind === "text" ? key.text : "<ignored>")).join("");
}

void describe("eligibility", () => {
  const env = (overrides: Partial<Parameters<typeof selectChatMode>[0]> = {}): Parameters<typeof selectChatMode>[0] => ({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    term: "xterm-256color",
    rawModeSupported: true,
    color: true,
    ...overrides,
  });

  void it("accepts the tested ANSI families and their variants", () => {
    for (const term of ["xterm", "xterm-256color", "xterm-color", "screen", "screen-256color", "tmux", "tmux-256color", "rxvt", "rxvt-unicode-256color"]) {
      assert.equal(selectChatMode(env({ term }), false), "fullscreen", term);
    }
  });

  void it("falls back to plain for everything else", () => {
    for (const term of [undefined, "", "dumb", "linux", "vt100", "ansi", "xtermfoo", "alacritty", "kitty", "screenx"]) {
      assert.equal(selectChatMode(env({ term }), false), "plain", String(term));
      assert.equal(isSupportedTerm(term), false);
    }
    assert.equal(selectChatMode(env({ stdinIsTTY: false }), false), "plain");
    assert.equal(selectChatMode(env({ stdoutIsTTY: false }), false), "plain");
    assert.equal(selectChatMode(env({ rawModeSupported: false }), false), "plain");
  });

  void it("--plain wins over a capable terminal", () => {
    assert.equal(selectChatMode(env(), true), "plain");
  });
});

void describe("transcript text", () => {
  const messages = [
    { role: "user", content: "first  message\nwith lines\ttab" },
    { role: "assistant", content: "first reply\u001b[31m\u001b]0;pwned\u0007\u009b2J\r\nnext\rlone\u2028x" },
    { role: "user", content: "second" },
  ] as const;

  void it("redirected output is exact: labels, unchanged content, blank lines between, one final newline, nothing when empty", () => {
    assert.equal(transcriptText([], { terminal: false }), "");
    assert.equal(
      transcriptText(messages, { terminal: false }),
      "YOU > first  message\nwith lines\ttab\n\nAI > first reply\u001b[31m\u001b]0;pwned\u0007\u009b2J\r\nnext\rlone\u2028x\n\nYOU > second\n",
    );
  });

  void it("terminal output neutralizes controls but keeps newlines, CRLF and tabs, and never changes the messages", () => {
    const before = JSON.stringify(messages);
    const shown = transcriptText(messages, { terminal: true });
    assert.equal(
      shown,
      "YOU > first  message\nwith lines\ttab\n\nAI > first reply\uFFFD[31m\uFFFD]0;pwned\uFFFD\uFFFD2J\r\nnext\uFFFDlone\uFFFDx\n\nYOU > second\n",
    );
    assert.ok(!Array.from(shown).some((char) => char !== "\n" && char !== "\t" && char !== "\r" && isUnsafe(char, false)));
    assert.equal(JSON.stringify(messages), before);
    assert.equal(transcriptText([], { terminal: true }), "");
  });
});
