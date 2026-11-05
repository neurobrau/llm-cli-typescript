import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InputEditor } from "../src/tui/editor.js";
import { KeyDecoder } from "../src/tui/keys.js";
import { computeLayout } from "../src/tui/layout.js";
import { CUSTOM_ID, modelMenu, providerMenu, reasoningChoiceLabel, reasoningMenu, reasoningValueOf, selectableModels, styleMenu, tokensMenu } from "../src/tui/menu-builders.js";
import { Menu, footerOf, menuBox, menuLine } from "../src/tui/menu.js";
import type { MenuItem } from "../src/tui/menu.js";
import { parseTokenInput } from "../src/tui/token-input.js";
import { LEVELS, NONE, OFF_ON, UNKNOWN, model } from "./helpers/menus.js";

const must = <T>(value: T | undefined): T => {
  assert.ok(value !== undefined);
  return value;
};
const items = (count: number, current = -1): MenuItem[] => Array.from({ length: count }, (_, i) => ({ id: `i${String(i)}`, label: `item ${String(i)}`, current: i === current }));
const open = (list: MenuItem[], kind: "model" | "style" = "model"): Menu => {
  const menu = Menu.create(kind, "TITLE", list);
  assert.ok(menu !== undefined);
  return menu;
};

// The Go reference tests (internal/tui/menu_test.go: TestMenuLine, TestStyleMenuLayout) are the fixtures here.
void describe("menu list state (docs/tui-spec.md section 4b)", () => {
  void it("opens on the current item, otherwise on the first, and never opens empty", () => {
    assert.equal(open(items(5, 3)).index, 3);
    assert.equal(open(items(5)).index, 0);
    assert.equal(Menu.create("model", "T", []), undefined);
  });

  void it("the current marker and the highlight are independent", () => {
    const menu = open(items(4, 2));
    menu.handle("up", 10);
    assert.equal(menu.index, 1);
    assert.equal(menu.items[2]?.current, true);
    assert.equal(menu.items[1]?.current, false);
    assert.equal(menuLine(must(menu.items[2]), 0).startsWith("* "), true);
  });

  void it("clamps Up/Down/Home/End and pages by visible-1 (at least 1), keeping the highlight visible", () => {
    const menu = open(items(30));
    assert.equal(menu.handle("up", 5), undefined);
    assert.equal(menu.index, 0);
    menu.handle("pagedown", 5);
    assert.equal(menu.index, 4);
    menu.handle("pagedown", 5);
    assert.equal(menu.index, 8);
    assert.ok(menu.index >= menu.top && menu.index < menu.top + 5);
    menu.handle("end", 5);
    assert.equal(menu.index, 29);
    assert.equal(menu.top, 25);
    menu.handle("down", 5);
    assert.equal(menu.index, 29);
    menu.handle("pageup", 1); // one visible row: a page is still one item
    assert.equal(menu.index, 28);
    menu.handle("home", 5);
    assert.deepEqual([menu.index, menu.top], [0, 0]);
  });

  void it("Enter selects; Esc and Ctrl+D cancel; other keys do nothing", () => {
    const menu = open(items(3));
    assert.equal(menu.handle("enter", 5), "select");
    assert.equal(menu.handle("escape", 5), "cancel");
    assert.equal(menu.handle("ctrl-d", 5), "cancel");
    for (const key of ["f1", "f2", "left", "backspace", "ctrl-u", "delete"] as const) assert.equal(menu.handle(key, 5), undefined);
    assert.equal(menu.index, 0);
  });

  void it("re-clamps the scroll when the visible count shrinks (resize) without losing the highlight", () => {
    const menu = open(items(30, 20));
    menu.scrollIntoView(18);
    menu.scrollIntoView(3);
    assert.equal(menu.index, 20);
    assert.ok(menu.index >= menu.top && menu.index < menu.top + 3);
  });
});

void describe("menu lines and geometry", () => {
  void it("right-aligns a note only when it fits, clips with ~, and has a natural form (Go TestMenuLine)", () => {
    const item: MenuItem = { id: "m", label: "qwen3.5:4b", note: "4.7B Q4_K_M", current: true };
    assert.equal(menuLine(item, 26), "* qwen3.5:4b   4.7B Q4_K_M");
    assert.equal(menuLine(item, 14), "* qwen3.5:4b  ");
    assert.equal(menuLine({ id: "x", label: "a-very-long-model-name" }, 10), "  a-very-~");
    assert.equal(menuLine(item, 0), "* qwen3.5:4b  4.7B Q4_K_M");
  });

  void it("keeps identity apart from the clipped display and counts code points", () => {
    const long = "модель-😀-".repeat(8);
    const line = menuLine({ id: long, label: long }, 12);
    assert.equal(Array.from(line).length, 12);
    assert.ok(line.endsWith("~"));
    assert.equal(open([{ id: long, label: long }]).selected.id, long);
  });

  void it("is 39 wide at x=9, rows 7-11 for the answer-style menu at 80x25 (Go TestStyleMenuLayout)", () => {
    const layout = computeLayout({ rows: 25, cols: 80 });
    assert.ok(layout !== undefined);
    const menu = must(styleMenu("normal"));
    assert.deepEqual(menuBox(menu, layout), { x: 9, y: 7, width: 39, height: 5, visible: 3 });
    assert.equal(footerOf(menu), "2/3 Enter=OK Esc=cancel");
    const narrow = computeLayout({ rows: 25, cols: 63 });
    assert.ok(narrow !== undefined);
    assert.deepEqual(menuBox(menu, narrow), { x: 12, y: 7, width: 39, height: 5, visible: 3 });
  });

  void it("is at least 30 wide, wide enough for title and footer, capped at C-2, and shows at most height-2 items", () => {
    const layout = computeLayout({ rows: 12, cols: 40 });
    assert.ok(layout !== undefined);
    const tiny = open([{ id: "a", label: "a" }]);
    assert.equal(menuBox(tiny, layout).width, 30);
    const wide = open([{ id: "w", label: "w".repeat(80) }]);
    assert.equal(menuBox(wide, layout).width, 38);
    const many = open(items(40));
    assert.equal(menuBox(many, layout).visible, 3); // conversation height 5 - 2
    assert.ok(menuBox(many, layout).y >= layout.conversationTop);
  });
});

void describe("menu contents", () => {
  void it("F3 lists OpenAI then Ollama with the current marked", () => {
    const menu = must(providerMenu("ollama"));
    assert.deepEqual(menu.items.map((item) => [item.id, item.label, item.current]), [["openai", "OpenAI", false], ["ollama", "Ollama", true]]);
    assert.equal(menu.title, "SELECT PROVIDER");
  });

  void it("F2 keeps provider order and exact IDs, uses reported details, drops remote/non-completion/duplicates", () => {
    const models = [
      model("Z:latest", "7B Q4"),
      model("a/b:c"),
      model("__proto__", "x"),
      model("Z:latest", "dup"),
      model("cloud:cloud", undefined, { remote: true }),
      model("embed", undefined, { capabilities: ["embedding"] }),
      model("chat", undefined, { capabilities: ["completion", "tools"] }),
      model("Ünï/😀"),
    ];
    assert.deepEqual(selectableModels(models).map((m) => m.id), ["Z:latest", "a/b:c", "__proto__", "chat", "Ünï/😀"]);
    const menu = must(modelMenu("ollama", models, "a/b:c"));
    assert.equal(menu.title, "SELECT OLLAMA MODEL");
    assert.deepEqual(menu.items.map((item) => [item.id, item.note, item.current]), [["Z:latest", "7B Q4", false], ["a/b:c", undefined, true], ["__proto__", "x", false], ["chat", undefined, false], ["Ünï/😀", undefined, false]]);
    assert.equal(menu.index, 1);
    assert.equal(modelMenu("openai", [], "m"), undefined);
  });

  void it("an active model absent from the list is not synthesized: no current marker, the first item is highlighted", () => {
    const menu = must(modelMenu("openai", [model("gpt-a"), model("gpt-b")], "my-custom-model"));
    assert.equal(menu.index, 0);
    assert.ok(menu.items.every((item) => item.current !== true));
    assert.equal(menu.title, "SELECT OPENAI MODEL");
  });

  void it("F4 offers the documented items per support kind and marks the current choice by provenance", () => {
    const levels = reasoningMenu("m", LEVELS, { effort: "low", explicit: false, source: "builtin" });
    assert.ok(levels.kind === "menu");
    assert.deepEqual(levels.menu.items.map((item) => [item.label, item.note, item.current]), [
      ["Model default", "no effort sent: medium", false],
      ["Low", undefined, true],
      ["Medium", undefined, false],
      ["High", undefined, false],
    ]);
    const explicitDefault = reasoningMenu("m", LEVELS, { explicit: true, source: "saved" });
    assert.ok(explicitDefault.kind === "menu");
    assert.equal(explicitDefault.menu.items[0]?.current, true);
    assert.equal(explicitDefault.menu.index, 0);
    const unset = reasoningMenu("m", LEVELS, { explicit: false, source: "builtin" });
    assert.ok(unset.kind === "menu");
    assert.ok(unset.menu.items.every((item) => item.current !== true), "absence of a parameter alone is not an explicit Model default");

    const noModelDefault = reasoningMenu("m", { reasoning: { known: true, values: ["high"], allowsModelDefault: true } }, { explicit: false, source: "builtin" });
    assert.ok(noModelDefault.kind === "menu");
    assert.equal(noModelDefault.menu.items[0]?.note, "no effort sent");

    const offOn = reasoningMenu("q", OFF_ON, { effort: "off", explicit: false, source: "builtin" });
    assert.ok(offOn.kind === "menu");
    assert.deepEqual(offOn.menu.items.map((item) => [item.label, item.current]), [["Off", true], ["On", false]]);

    const none = reasoningMenu("plain-model", NONE, { explicit: false, source: "builtin" });
    assert.deepEqual(none, { kind: "none", message: "plain-model does not support reasoning." });

    const unknown = reasoningMenu("gpt-x", UNKNOWN, { effort: "high", explicit: true, source: "cli" });
    assert.ok(unknown.kind === "menu");
    assert.deepEqual(unknown.menu.items.map((item) => [item.label, item.current]), [["Model default (support unknown)", false]]);
    assert.equal(unknown.info, "Reasoning support for gpt-x is not confirmed, so only the model's default is offered. --reasoning-effort sends a value explicitly.");
  });

  void it("F4 maps items to stored values and confirmation labels", () => {
    assert.equal(reasoningValueOf("model-default"), "default");
    assert.equal(reasoningValueOf("value:xhigh"), "xhigh");
    assert.equal(reasoningValueOf("junk"), undefined);
    assert.equal(reasoningChoiceLabel("model-default"), "Model default (no effort parameter is sent)");
    assert.equal(reasoningChoiceLabel("value:xhigh"), "XHigh");
    assert.equal(reasoningChoiceLabel("value:off"), "Off");
    assert.equal(reasoningChoiceLabel("value:max"), "Max");
    assert.equal(reasoningChoiceLabel("value:custom-level"), "Custom-level");
  });

  void it("F5 offers Default, the presets within the known limit, and Custom with its note; a non-preset current value is Custom (n)", () => {
    const base = must(tokensMenu({ explicit: false, source: "builtin" }, undefined));
    assert.deepEqual(base.items.map((item) => [item.label, item.note, item.current]), [
      ["Default", "model default", true],
      ["256", undefined, false],
      ["512", undefined, false],
      ["1024", undefined, false],
      ["2048", undefined, false],
      ["4096", undefined, false],
      ["Custom...", "any positive number", false],
    ]);
    const limited = must(tokensMenu({ value: 512, explicit: true, source: "saved" }, 1000));
    assert.deepEqual(limited.items.map((item) => item.label), ["Default", "256", "512", "Custom..."]);
    assert.equal(limited.items.at(-1)?.note, "up to 1000");
    const custom = must(tokensMenu({ value: 300, explicit: true, source: "cli" }, 8192));
    assert.equal(custom.items.at(-1)?.label, "Custom (300)");
    assert.equal(custom.items.at(-1)?.current, true);
    assert.equal(custom.items.at(-1)?.id, CUSTOM_ID);
    assert.equal(custom.index, custom.items.length - 1);
    const explicitDefault = must(tokensMenu({ explicit: true, source: "saved" }, undefined));
    assert.equal(explicitDefault.items[0]?.current, true);
  });

  void it("F6 lists brief, normal, detailed with notes and the effective style current", () => {
    const menu = must(styleMenu("detailed"));
    assert.deepEqual(menu.items.map((item) => [item.label, item.note, item.current]), [
      ["Brief", "short, concise answers", false],
      ["Normal", "standard answers", false],
      ["Detailed", "thorough, with examples", true],
    ]);
    assert.equal(menu.title, "ANSWER STYLE");
  });
});

void describe("custom token input", () => {
  void it("accepts digits as bigint within the limits and rejects everything else with actionable text", () => {
    assert.deepEqual(parseTokenInput("512", 8192, "m"), { ok: true, value: 512n });
    assert.deepEqual(parseTokenInput("007", undefined, "m"), { ok: true, value: 7n });
    assert.deepEqual(parseTokenInput("9007199254740991", undefined, "m"), { ok: true, value: 9007199254740991n });
    const cases: readonly (readonly [string, number | undefined, string])[] = [
      ["", 100, "Enter a positive whole number. Try again or press Esc."],
      ["abc", 100, "'abc' is not a positive whole number. Try again or press Esc."],
      ["12x", 100, "'12x' is not a positive whole number. Try again or press Esc."],
      ["-5", 100, "'-5' is not a positive whole number. Try again or press Esc."],
      ["1.5", 100, "'1.5' is not a positive whole number. Try again or press Esc."],
      ["1e3", 100, "'1e3' is not a positive whole number. Try again or press Esc."],
      ["٣", 100, "'٣' is not a positive whole number. Try again or press Esc."],
      ["0", 100, "Max output tokens must be a positive whole number, not 0. Try again or press Esc."],
      ["000", undefined, "Max output tokens must be a positive whole number, not 0. Try again or press Esc."],
      ["101", 100, "101 exceeds the limit of 100 output tokens for m. Try again or press Esc."],
      ["9007199254740993", 100, "9007199254740993 exceeds the limit of 100 output tokens for m. Try again or press Esc."],
      ["9007199254740992", undefined, "9007199254740992 is more than the largest supported number of 9007199254740991 output tokens. Try again or press Esc."],
      ["99999999999999999999999999", undefined, "99999999999999999999999999 is more than the largest supported number of 9007199254740991 output tokens. Try again or press Esc."],
    ];
    for (const [text, limit, message] of cases) assert.deepEqual(parseTokenInput(text, limit, "m"), { ok: false, message }, text);
  });
});

void describe("Esc handling in the key decoder", () => {
  void it("a lone Esc becomes the escape key only after the wait; sequences are never split", () => {
    const decoder = new KeyDecoder();
    assert.deepEqual(decoder.feed("\x1b"), []);
    assert.deepEqual(decoder.dropEscape(), [{ kind: "key", name: "escape" }]);
    assert.deepEqual(decoder.dropEscape(), []);
    assert.deepEqual(decoder.feed("\x1b[1"), []);
    assert.equal(decoder.pendingEscape, false); // inside a sequence: not a lone Esc
    assert.deepEqual(decoder.feed("5~"), [{ kind: "key", name: "f5" }]);
    decoder.feed("\x1b");
    assert.deepEqual(decoder.feed("OP"), [{ kind: "key", name: "f1" }]);
  });

  void it("byte-at-a-time arrows and F-keys decode without an escape key", () => {
    const decoder = new KeyDecoder();
    const out = Array.from("\x1b[A\x1bOQ\x1b[17~").flatMap((char) => decoder.feed(char));
    assert.deepEqual(out.map((key) => (key.kind === "key" ? key.name : key.kind)), ["up", "f2", "f6"]);
  });
});

void describe("editor draft restore", () => {
  void it("restores text and cursor exactly, also with non-BMP characters and out-of-range cursors", () => {
    const editor = new InputEditor();
    editor.insert("héllo 😀 wörld");
    editor.home();
    for (let i = 0; i < 8; i += 1) editor.right();
    const saved = { text: editor.text, cursor: editor.cursor };
    editor.clear();
    editor.insert("999");
    editor.restore(saved.text, saved.cursor);
    assert.equal(editor.text, "héllo 😀 wörld");
    assert.equal(editor.cursor, saved.cursor);
    editor.restore("a😀b", 2); // inside a surrogate pair: moved to its start
    assert.equal(editor.cursor, 1);
    editor.restore("abc", 99);
    assert.equal(editor.cursor, 3);
  });
});
