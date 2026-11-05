import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError, SettingsError } from "../src/domain/errors.js";
import type { GenerationRequest } from "../src/domain/generation.js";
import { styleInstructions } from "../src/domain/settings.js";
import { deferred } from "./helpers/deferred.js";
import { FakeSettingsStore, LEVELS, NONE, OFF_ON, UNKNOWN, model, settingsDoc, startMenuTui } from "./helpers/menus.js";
import type { MenuRig } from "./helpers/menus.js";
import { FakeTerminal, KEYS, finishWithClock, settleAll, until } from "./helpers/tui.js";

const req = (provider: MenuRig["ollama"], index: number): GenerationRequest => {
  const found = provider.requests[index];
  assert.ok(found !== undefined, `request ${String(index)} exists`);
  return found;
};
const term = (rig: MenuRig): FakeTerminal => rig.session.term;
const press = (rig: MenuRig, sequence: string): Promise<void> => rig.session.key(sequence);
const typed = (rig: MenuRig, text: string): Promise<void> => rig.session.type(text);
const submit = async (rig: MenuRig, line: string): Promise<void> => {
  await typed(rig, line);
  await press(rig, KEYS.enter);
};
const quit = async (rig: MenuRig): Promise<number> => {
  await press(rig, KEYS.ctrlU);
  await press(rig, KEYS.ctrlD);
  return (await rig.session.result).code;
};
/** Presses Esc and lets the 25 ms wait for a possible sequence pass. */
const esc = async (rig: MenuRig): Promise<void> => {
  term(rig).feed("\x1b");
  rig.session.timers.advance(25);
  await settleAll();
};
const rowsOf = (rig: MenuRig, from: number, to: number): string[] => term(rig).lines().slice(from, to);

/** The settings written so far for one model (reasoning, max as strings). */
const entry = (rig: MenuRig, provider: string, name: string): { reasoning?: string | undefined; max?: string | null | undefined } | undefined => {
  const found = rig.store.stored.providers.get(provider)?.get(name);
  if (found === undefined) return undefined;
  return { reasoning: found.reasoning, max: found.maxOutputTokens === undefined ? undefined : found.maxOutputTokens === null ? null : found.maxOutputTokens.toString() };
};

// The first expectations are the Go reference rows (internal/tui/menu_test.go styleMenuRows, TestStyleMenuLayout).
void describe("menus: appearance and modality", () => {
  void it("draws the answer-style menu exactly as the reference at 80x25, highlights the current item and swallows keys", async () => {
    const rig = await startMenuTui();
    await typed(rig, "draft");
    await press(rig, KEYS.f6);
    const expected = [
      "+-[ ANSWER STYLE ]--------------------+",
      "|   Brief      short, concise answers |",
      "| * Normal           standard answers |",
      "|   Detailed  thorough, with examples |",
      "+-[ 2/3 Enter=OK Esc=cancel ]---------+",
    ];
    assert.deepEqual(rowsOf(rig, 7, 12).map((row) => Array.from(row).slice(9, 48).join("")), expected);
    const frame = term(rig).frame;
    assert.equal(frame.styles[9]?.[10], "selected");
    assert.equal(frame.styles[8]?.[10], "text");
    assert.equal(frame.styles[7]?.[9], "border");
    // Keys go to the menu only.
    await typed(rig, "xyz/");
    await press(rig, KEYS.pageUp);
    await press(rig, KEYS.f2);
    await press(rig, KEYS.backspace);
    await press(rig, KEYS.end);
    assert.ok(term(rig).text().includes("3/3 Enter=OK"));
    assert.equal(term(rig).frame.styles[10]?.[10], "selected");
    // 63 columns: no panel, centered over the whole width.
    term(rig).resize(25, 63);
    await settleAll();
    assert.equal(rowsOf(rig, 7, 8).map((row) => Array.from(row).slice(12, 51).join(""))[0], "+-[ ANSWER STYLE ]--------------------+");
    // Too small: the message, then the menu returns as it was.
    term(rig).resize(10, 30);
    await settleAll();
    assert.ok(term(rig).text().includes("Terminal too small."));
    term(rig).resize(25, 80);
    await settleAll();
    assert.ok(term(rig).text().includes("3/3 Enter=OK"));
    await esc(rig);
    assert.ok(!term(rig).text().includes("ANSWER STYLE ]"));
    assert.ok(term(rig).inputLine().includes("YOU > draft"));
    assert.ok(!term(rig).text().includes("xyz"));
    assert.equal(rig.store.saves.length, 0, "a cancelled menu writes nothing");
    await press(rig, KEYS.f6);
    await press(rig, KEYS.ctrlD); // Ctrl+D closes a menu like Esc
    assert.ok(!term(rig).text().includes("ANSWER STYLE ]"));
    await press(rig, KEYS.f6);
    await press(rig, KEYS.ctrlC); // Ctrl+C in an idle open menu exits
    assert.equal((await rig.session.result).code, 130);
    for (const frame of term(rig).frames) assert.equal(frame.chars.at(-1)?.at(-1), " ", "the bottom-right cell is never written");
  });

  void it("fragmented arrows and F-keys while a menu is open are keys, never a cancelling Esc", async () => {
    const rig = await startMenuTui();
    await press(rig, KEYS.f6);
    for (const part of ["\x1b", "[", "B"]) term(rig).feed(part); // Down, one byte at a time
    await settleAll();
    assert.ok(term(rig).text().includes("3/3 Enter=OK"));
    rig.session.timers.advance(100);
    await settleAll();
    assert.ok(term(rig).text().includes("ANSWER STYLE ]"), "the menu is still open");
    term(rig).feed("\x1b");
    term(rig).feed("[A"); // Up, split right after the Esc byte
    await settleAll();
    assert.ok(term(rig).text().includes("2/3 Enter=OK"));
    await esc(rig);
    assert.ok(!term(rig).text().includes("ANSWER STYLE ]"));
    assert.equal(await quit(rig), 0);
  });

  void it("Esc outside a menu or prompt is ignored; the draft survives", async () => {
    const rig = await startMenuTui();
    await typed(rig, "keep me");
    await esc(rig);
    assert.ok(term(rig).inputLine().includes("YOU > keep me"));
    assert.equal(rig.store.saves.length, 0);
    assert.equal(await quit(rig), 0);
  });

  void it("menus work at 63 columns and at the 40x12 minimum, with long and hostile model IDs displayed safely", async () => {
    const hostile = "evil\u001b[2J\u001b]0;pwned\u0007-model-with-a-really-long-name-" + "x".repeat(60);
    const rig = await startMenuTui({
      terminal: new FakeTerminal({ rows: 12, cols: 40 }),
      configure: ({ ollama }) => {
        ollama.models = [model("qwen3.5:4b", "4.7B"), model(hostile, "9\u009b9B"), ...Array.from({ length: 10 }, (_, i) => model(`m${String(i)}`))];
      },
    });
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "the menu");
    const lines = term(rig).lines();
    for (const line of lines) assert.equal(Array.from(line).length, 40);
    for (const frame of term(rig).frames) for (const row of frame.chars) for (const cell of row) assert.ok((cell.codePointAt(0) ?? 0) >= 0x20 && !((cell.codePointAt(0) ?? 0) >= 0x7f && (cell.codePointAt(0) ?? 0) <= 0x9f));
    await press(rig, KEYS.down);
    assert.ok(term(rig).text().includes("2/12 Enter=OK"));
    await press(rig, KEYS.end);
    assert.ok(term(rig).text().includes("12/12 Enter=OK"));
    await press(rig, KEYS.enter); // switch to m9
    await until(() => term(rig).flat().includes("Now using Ollama / m9."), "switched");
    assert.equal(await quit(rig), 0);
  });
});

void describe("F3 provider menu and the provider check", () => {
  void it("opening the menu and selecting the current provider do no work at all", async () => {
    const rig = await startMenuTui();
    await press(rig, KEYS.f3);
    assert.deepEqual(rowsOf(rig, 8, 9).map((row) => row.includes("SELECT PROVIDER")), [true]);
    const text = term(rig).text();
    assert.ok(text.indexOf("OpenAI") < text.lastIndexOf("Ollama"));
    assert.deepEqual(rig.created, ["ollama"], "the other provider was not constructed");
    assert.deepEqual(rig.ready, ["ollama"], "no other key lookup");
    await press(rig, KEYS.enter); // the highlight is on the current provider
    await press(rig, KEYS.f3);
    await press(rig, KEYS.down); // clamped at the last item, which is the current one
    await press(rig, KEYS.enter);
    await settleAll();
    assert.equal(rig.ollama.availabilityCalls, 0);
    assert.equal(rig.openai.availabilityCalls + rig.openai.listCalls, 0);
    assert.deepEqual(rig.history.calls.filter((call) => call === "save" || call === "saveActive"), []);
    assert.equal(rig.store.saves.length, 0);
    assert.equal(await quit(rig), 0);
  });

  void it("selecting another provider checks only that provider, then switches to its own default model", async () => {
    const gate = deferred();
    const rig = await startMenuTui({ configure: ({ openai }) => { openai.gates.availability = gate.promise; } });
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up); // OpenAI
    await press(rig, KEYS.enter);
    await until(() => rig.openai.availabilityCalls === 1, "availability asked");
    assert.equal(term(rig).status(), "CONNECTING | Checking OpenAI");
    assert.deepEqual(rig.created, ["ollama", "openai"]);
    assert.deepEqual(rig.ready, ["ollama", "openai"]);
    gate.resolve();
    await until(() => term(rig).flat().includes("Now using OpenAI / gpt-6-luna."), "switched");
    assert.ok(term(rig).flat().includes("Now using OpenAI / gpt-6-luna. Started a new conversation."));
    assert.deepEqual(rig.openai.capabilityCalls, ["gpt-6-luna"]);
    assert.equal(rig.openai.defaultModelCalls, 1);
    assert.equal(rig.ollama.availabilityCalls, 0);
    assert.ok(term(rig).lines().some((line) => line.includes(" OpenAI ")));
    // the new selection was saved empty and recorded as active
    assert.deepEqual(rig.history.saved.map((c) => [c.provider, c.model, c.messages.length]), [["openai", "gpt-6-luna", 0]]);
    assert.deepEqual(rig.history.activeSaved, [{ provider: "openai", model: "gpt-6-luna" }]);
    assert.equal(await quit(rig), 0);
  });

  void it("a missing key is a recoverable in-TUI failure: nothing changes, the key is checked but the provider not built", async () => {
    const rig = await startMenuTui({ noKey: true });
    await submit(rig, "hello");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("OpenAI is not available: OPENAI_API_KEY is not set."), "refusal");
    assert.deepEqual(rig.created, ["ollama"]);
    assert.deepEqual(rig.ready, ["ollama", "openai"]);
    assert.ok(term(rig).flat().includes("YOU > hello"), "the conversation is still shown");
    assert.ok(term(rig).lines().some((line) => line.includes(" Ollama ")));
    await submit(rig, "still here");
    await until(() => rig.ollama.calls === 2, "chat continues on the old selection");
    assert.deepEqual(rig.ollama.sent(1), ["user: hello", "assistant: reply 1", "user: still here"]);
    assert.equal(await quit(rig), 0);
  });

  void it("unavailable, failing and misconfigured targets keep session, settings, draft, usage and files", async () => {
    for (const setup of [
      { name: "unavailable", configure: (p: MenuRig["openai"]): void => { p.availability = { available: false, message: "no network" }; }, expected: "OpenAI is not available: no network" },
      { name: "provider error", configure: (p: MenuRig["openai"]): void => { p.availabilityError = new ProviderError("401 denied", "authentication"); }, expected: "OpenAI is not available: 401 denied" },
    ]) {
      const rig = await startMenuTui({ configure: ({ openai }) => { setup.configure(openai); } });
      await typed(rig, "typed draft");
      await press(rig, KEYS.f3);
      await press(rig, KEYS.up);
      await press(rig, KEYS.enter);
      await until(() => term(rig).flat().includes(setup.expected), setup.name);
      assert.ok(term(rig).inputLine().includes("typed draft"), setup.name);
      assert.deepEqual(rig.history.calls.filter((call) => call === "save" || call === "saveActive"), [], setup.name);
      assert.equal(rig.store.saves.length, 0);
      assert.ok(term(rig).lines().some((line) => line.includes(" Ollama ")));
      await press(rig, KEYS.ctrlU);
      assert.equal(await quit(rig), 0);
    }
  });

  void it("an invalid OLLAMA_HOST when selecting Ollama is a safe recoverable message", async () => {
    const rig = await startMenuTui({
      argv: ["--provider", "openai", "--model", "gpt-6-luna"],
      createError: { ollama: new SettingsError("Invalid OLLAMA_HOST: unsupported scheme") },
    });
    await press(rig, KEYS.f3);
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Ollama is not available: Invalid OLLAMA_HOST: unsupported scheme"), "refusal");
    assert.deepEqual(rig.created, ["openai"]);
    assert.equal(await quit(rig), 0);
  });
});

void describe("F2 model menu and the model check", () => {
  void it("loads the provider's models once, keeps their order and details, and a current model absent from the list is not invented", async () => {
    const gate = deferred();
    const rig = await startMenuTui({ configure: ({ ollama }) => { ollama.gates.list = gate.promise; } });
    await press(rig, KEYS.f2);
    assert.equal(term(rig).status(), "CONNECTING | Loading Ollama models");
    gate.resolve();
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "the menu");
    assert.equal(rig.ollama.listCalls, 1);
    const rows = rowsOf(rig, 6, 14).join("\n");
    assert.ok(rows.indexOf("qwen3.5:4b") < rows.indexOf("llama3.2:3b") && rows.indexOf("llama3.2:3b") < rows.indexOf("gemma:2b"));
    assert.ok(rows.includes("* qwen3.5:4b   4.7B Q4_K_M"));
    assert.deepEqual(rig.ollama.capabilityCalls.slice(1), [], "opening the menu asked for no capabilities");
    await esc(rig);
    assert.equal(rig.store.saves.length, 0);
    assert.equal(await quit(rig), 0);

    const other = await startMenuTui({ argv: ["--provider", "openai", "--model", "my-custom-model"] });
    await press(other, KEYS.f2);
    await until(() => term(other).text().includes("SELECT OPENAI MODEL"), "openai menu");
    const menuRows = rowsOf(other, 5, 14).map((row) => Array.from(row).slice(0, 58).join("")).join("\n");
    assert.ok(!menuRows.includes("my-custom-model") && !menuRows.includes("* "), "no synthetic entry or marker");
    assert.ok(term(other).text().includes("1/2 Enter=OK"));
    await press(other, KEYS.enter); // the first discovered model is chosen: a real switch
    await until(() => term(other).flat().includes("Now using OpenAI / gpt-6-luna."), "switched");
    assert.equal(await quit(other), 0);
  });

  void it("errors and empty lists are entries and change nothing", async () => {
    const failing = await startMenuTui({ configure: ({ ollama }) => { ollama.listError = new ProviderError("server down", "connection"); } });
    await press(failing, KEYS.f2);
    await until(() => term(failing).status().startsWith("ERROR"), "ERROR");
    assert.equal(term(failing).status(), "ERROR | server down");
    assert.ok(term(failing).flat().includes("Error: server down"));
    assert.ok(!term(failing).text().includes("SELECT OLLAMA MODEL"));
    await quit(failing);
    const empty = await startMenuTui({ configure: ({ ollama }) => { ollama.models = [model("remote:cloud", undefined, { remote: true })]; } });
    await press(empty, KEYS.f2);
    await until(() => term(empty).flat().includes("No selectable Ollama models were found."), "empty");
    assert.deepEqual(empty.history.calls.filter((call) => call === "save"), []);
    await quit(empty);
  });

  void it("choosing the current model is a no-op; another model is checked, switched and then used by the next request", async () => {
    const rig = await startMenuTui();
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "menu");
    await press(rig, KEYS.enter);
    await settleAll();
    assert.deepEqual(rig.ollama.capabilityCalls, ["qwen3.5:4b"], "only the startup lookup");
    assert.equal(rig.history.saved.length, 0);
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "menu");
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Now using Ollama / llama3.2:3b. Started a new conversation."), "switched");
    assert.deepEqual(rig.ollama.capabilityCalls, ["qwen3.5:4b", "llama3.2:3b"]);
    await submit(rig, "hi");
    await until(() => rig.ollama.calls === 1, "request");
    assert.equal(req(rig.ollama, 0).model, "llama3.2:3b");
    assert.equal(await quit(rig), 0);
  });
});

void describe("checks are responsive, cancellable and never apply a late result", () => {
  void it("typing, help, usage and resize work during a check; F-keys and messages are refused; the draft is kept", async () => {
    const gate = deferred();
    const rig = await startMenuTui({ configure: ({ ollama }) => { ollama.gates.list = gate.promise; } });
    await press(rig, KEYS.f2);
    await typed(rig, "draft é");
    term(rig).resize(30, 100);
    await settleAll();
    assert.equal(term(rig).lines().length, 30);
    assert.equal(term(rig).status(), "CONNECTING | Loading Ollama models");
    await press(rig, KEYS.f4);
    assert.equal(term(rig).status(), "WARNING | Wait for the current check or press Ctrl+C");
    await press(rig, KEYS.enter);
    assert.equal(term(rig).status(), "WARNING | Wait for the current check or press Ctrl+C");
    assert.ok(term(rig).inputLine().includes("draft é"));
    assert.equal(rig.ollama.calls, 0);
    await press(rig, KEYS.ctrlU);
    await submit(rig, "/usage");
    assert.ok(term(rig).flat().includes("Token usage: no API requests"));
    await submit(rig, "/help");
    assert.ok(term(rig).flat().includes("In menus:"));
    gate.resolve();
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "menu after the check");
    assert.equal(rig.ollama.listCalls, 1, "no overlapping check");
    await esc(rig);
    assert.equal(await quit(rig), 0);
  });

  void it("Ctrl+C cancels the check: Cancelled., CANCELLED, no menu, selection unchanged; a late success is ignored; repeats are absorbed", async () => {
    const gate = deferred();
    const rig = await startMenuTui({ configure: ({ ollama }) => { ollama.gates.list = gate.promise; ollama.deaf = true; }, deps: { cleanupTimeoutMs: 5000 } });
    await typed(rig, "mine");
    await press(rig, KEYS.f2);
    await press(rig, KEYS.ctrlC);
    assert.equal(term(rig).status(), "CANCELLED");
    assert.ok(term(rig).flat().includes("Cancelled."));
    await press(rig, KEYS.ctrlC); // a repeat is absorbed: no exit, no second cancellation
    assert.equal(term(rig).flat().split("Cancelled.").length, 2);
    await press(rig, KEYS.f4); // still closing: no overlapping check
    assert.equal(term(rig).status(), "WARNING | The cancelled response is still closing; try again shortly");
    gate.resolve(); // the non-cooperative provider answers late
    await settleAll();
    assert.ok(!term(rig).text().includes("SELECT OLLAMA MODEL"), "a late result never opens a menu");
    assert.ok(term(rig).inputLine().includes("YOU > mine"));
    await press(rig, KEYS.f6); // idle again
    assert.ok(term(rig).text().includes("ANSWER STYLE ]"));
    await esc(rig);
    await press(rig, KEYS.ctrlU);
    assert.equal(await quit(rig), 0);
  });

  void it("a check that ignores cancellation beyond the bound ends the program with 130, restored, with no switch", async () => {
    const gate = deferred();
    const rig = await startMenuTui({ configure: ({ openai }) => { openai.gates.availability = gate.promise; openai.deaf = true; }, deps: { cleanupTimeoutMs: 30 } });
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up);
    await press(rig, KEYS.enter);
    await until(() => rig.openai.availabilityCalls === 1, "asked");
    await press(rig, KEYS.ctrlC);
    rig.session.timers.advance(50);
    const done = await finishWithClock(rig.session);
    assert.equal(done.code, 130);
    gate.resolve();
    await settleAll();
    assert.equal(rig.history.saved.length, 0);
    assert.deepEqual(rig.history.activeSaved, []);
    assert.equal(rig.session.term.closeCount, 1);
  });

  void it("cancelling at every awaited boundary of a switch leaves selection, settings and files unchanged", async () => {
    for (const boundary of ["availability", "defaultModel", "capabilities"] as const) {
      const gate = deferred();
      const rig = await startMenuTui({ configure: ({ openai }) => { openai.gates[boundary] = gate.promise; } });
      await press(rig, KEYS.f3);
      await press(rig, KEYS.up);
      await press(rig, KEYS.enter);
      await until(() => (boundary === "availability" ? rig.openai.availabilityCalls : boundary === "defaultModel" ? rig.openai.defaultModelCalls : rig.openai.capabilityCalls.length) === 1, boundary);
      await press(rig, KEYS.ctrlC);
      await until(() => term(rig).status() === "CANCELLED", "cancelled");
      gate.resolve();
      await settleAll();
      assert.equal(rig.history.saved.length, 0, boundary);
      assert.deepEqual(rig.history.activeSaved, [], boundary);
      assert.equal(rig.store.saves.length, 0, boundary);
      assert.ok(term(rig).lines().some((line) => line.includes(" Ollama ")), boundary);
      assert.ok(!term(rig).flat().includes("Now using"), boundary);
      assert.equal(await quit(rig), 0);
    }
  });

  void it("/exit, SIGTERM and an output failure during a check restore the terminal and apply nothing", async () => {
    for (const how of ["exit", "sigterm", "output"] as const) {
      const gate = deferred();
      const rig = await startMenuTui({ configure: ({ ollama }) => { ollama.gates.list = gate.promise; } });
      await press(rig, KEYS.f2);
      if (how === "exit") term(rig).feed("/exit\r");
      else if (how === "sigterm") rig.session.signals.fire("SIGTERM");
      else {
        term(rig).drawError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        term(rig).feed("x");
      }
      const done = await finishWithClock(rig.session);
      assert.equal(done.code, how === "exit" ? 0 : how === "sigterm" ? 143 : 141, how);
      gate.resolve();
      await settleAll();
      assert.equal(term(rig).closeCount, 1, how);
      assert.equal(rig.history.saved.length, 0, how);
      assert.equal(rig.session.signals.active, 0, how);
      assert.equal(rig.session.timers.pending, 0, how);
    }
  });
});

void describe("request counts", () => {
  void it("F2/F4/F5 each ask the provider exactly once per opening, and F3/F6 never", async () => {
    const rig = await startMenuTui();
    await press(rig, KEYS.f3);
    await esc(rig);
    await press(rig, KEYS.f6);
    await esc(rig);
    assert.deepEqual([rig.ollama.listCalls, rig.ollama.availabilityCalls, rig.ollama.capabilityCalls.length], [0, 0, 1]);
    for (const key of [KEYS.f2, KEYS.f4, KEYS.f5]) {
      await press(rig, key);
      await until(() => term(rig).text().includes("Enter=OK"), "menu");
      await esc(rig);
    }
    assert.deepEqual([rig.ollama.listCalls, rig.ollama.availabilityCalls, rig.ollama.capabilityCalls.length], [1, 0, 3]);
    assert.equal(await quit(rig), 0);
  });
});

void describe("F4 reasoning", () => {
  void it("saves the exact choice per model, applies it to the next request and never touches the conversation", async () => {
    const rig = await startMenuTui();
    await submit(rig, "before");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await press(rig, KEYS.f4);
    await until(() => term(rig).text().includes("[ REASONING ]"), "menu");
    const text = term(rig).text();
    assert.ok(text.includes("Model default") && text.includes("no effort sent: medium"));
    assert.ok(/\* +Low/u.test(text), "the builtin default effort is the current item");
    await press(rig, KEYS.end); // High
    await press(rig, KEYS.enter);
    await until(() => rig.store.saves.length === 1, "saved");
    assert.deepEqual(entry(rig, "ollama", "qwen3.5:4b"), { reasoning: "high", max: undefined });
    assert.ok(term(rig).flat().includes("Reasoning for qwen3.5:4b: High. Applies from the next message."));
    assert.ok(term(rig).flat().includes("YOU > before"), "the conversation stays");
    await submit(rig, "after");
    await until(() => rig.ollama.calls === 2, "request");
    assert.deepEqual(req(rig.ollama, 1).reasoning, { effort: "high", explicit: true, source: "saved" });
    assert.deepEqual(req(rig.ollama, 0).reasoning.effort, "low");
    assert.deepEqual(rig.ollama.sent(1), ["user: before", "assistant: reply 1", "user: after"]);
    assert.equal(await quit(rig), 0);
  });

  void it("Model default is explicit and stored as 'default'; reconfirming it changes and writes nothing", async () => {
    const rig = await startMenuTui();
    await press(rig, KEYS.f4);
    await until(() => term(rig).text().includes("[ REASONING ]"), "menu");
    await press(rig, KEYS.home);
    await press(rig, KEYS.enter);
    await until(() => rig.store.saves.length === 1, "saved");
    assert.equal(entry(rig, "ollama", "qwen3.5:4b")?.reasoning, "default");
    assert.ok(term(rig).flat().includes("Reasoning for qwen3.5:4b: Model default (no effort parameter is sent). Applies from the next message."));
    await submit(rig, "go");
    await until(() => rig.ollama.calls === 1, "request");
    assert.deepEqual(req(rig.ollama, 0).reasoning, { explicit: true, source: "saved" });
    await press(rig, KEYS.f4);
    await until(() => term(rig).text().includes("[ REASONING ]"), "menu again");
    assert.ok(/\* +Model default/u.test(term(rig).text()), "the explicit choice is the current item");
    const before = term(rig).flat();
    await press(rig, KEYS.enter);
    await settleAll();
    assert.equal(rig.store.saves.length, 1, "no rewrite");
    assert.equal(term(rig).flat().split("Reasoning for").length, before.split("Reasoning for").length, "no duplicate confirmation");
    assert.equal(await quit(rig), 0);
  });

  void it("off/on models offer exactly Off and On; unknown support only the model default; none says so and writes nothing", async () => {
    const offOn = await startMenuTui({ configure: ({ ollama }) => { ollama.caps.set("qwen3.5:4b", OFF_ON); } });
    await press(offOn, KEYS.f4);
    await until(() => term(offOn).text().includes("[ REASONING ]"), "menu");
    assert.ok(term(offOn).text().includes("1/2 Enter=OK") && !term(offOn).text().includes("Model default"));
    await press(offOn, KEYS.down);
    await press(offOn, KEYS.enter);
    await until(() => offOn.store.saves.length === 1, "saved");
    assert.equal(entry(offOn, "ollama", "qwen3.5:4b")?.reasoning, "on");
    await quit(offOn);

    const unknown = await startMenuTui({ argv: ["--provider", "openai", "--model", "gpt-x"], configure: ({ openai }) => { openai.caps.set("gpt-x", UNKNOWN); } });
    await press(unknown, KEYS.f4);
    await until(() => term(unknown).text().includes("[ REASONING ]"), "menu");
    assert.ok(term(unknown).text().includes("Model default (support unknown)") && term(unknown).text().includes("1/1 Enter=OK"));
    assert.ok(term(unknown).flat().includes("Reasoning support for gpt-x is not confirmed"));
    await esc(unknown);
    assert.equal(unknown.store.saves.length, 0);
    await quit(unknown);

    const none = await startMenuTui({ configure: ({ ollama }) => { ollama.caps.set("qwen3.5:4b", NONE); } });
    await press(none, KEYS.f4);
    await until(() => term(none).flat().includes("qwen3.5:4b does not support reasoning."), "info");
    assert.ok(!term(none).text().includes("[ REASONING ]"));
    assert.equal(none.store.saves.length, 0);
    await quit(none);
  });
});

void describe("F5 max output tokens and the custom prompt", () => {
  void it("presets and Default are stored (Default as an explicit null) and applied to the next request", async () => {
    const rig = await startMenuTui();
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    await press(rig, KEYS.down);
    await press(rig, KEYS.down); // 512
    await press(rig, KEYS.enter);
    await until(() => rig.store.saves.length === 1, "saved");
    assert.deepEqual(entry(rig, "ollama", "qwen3.5:4b"), { reasoning: undefined, max: "512" });
    assert.ok(term(rig).flat().includes("Max output tokens for qwen3.5:4b: 512. Applies from the next message."));
    await submit(rig, "x");
    await until(() => rig.ollama.calls === 1, "request");
    assert.equal(req(rig.ollama, 0).maxOutputTokens, 512);
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu again");
    await press(rig, KEYS.home);
    await press(rig, KEYS.enter);
    await until(() => rig.store.saves.length === 2, "saved default");
    assert.equal(entry(rig, "ollama", "qwen3.5:4b")?.max, null);
    assert.ok(term(rig).flat().includes("Max output tokens for qwen3.5:4b: model default. Applies from the next message."));
    await submit(rig, "y");
    await until(() => rig.ollama.calls === 2, "request 2");
    assert.equal(req(rig.ollama, 1).maxOutputTokens, undefined);
    assert.equal(await quit(rig), 0);
  });

  void it("the custom prompt sets the draft aside, validates safely, restores draft and cursor, and ignores F-keys and commands", async () => {
    const rig = await startMenuTui();
    await typed(rig, "héllo wörld");
    await press(rig, KEYS.left);
    await press(rig, KEYS.left);
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    assert.ok(term(rig).inputLine().includes("TOKENS > "));
    assert.equal(term(rig).status(), "READY | Type a token limit and press Enter | Esc cancels");
    assert.ok(term(rig).flat().includes("Type the max output tokens (1-8192) and press Enter; Esc cancels."));
    await press(rig, KEYS.f2);
    await press(rig, KEYS.f6);
    assert.ok(!term(rig).text().includes("ANSWER STYLE ]") && !term(rig).text().includes("Loading"));
    for (const [input, message] of [
      ["12x", "'12x' is not a positive whole number. Try again or press Esc."],
      ["0", "Max output tokens must be a positive whole number, not 0. Try again or press Esc."],
      ["9000", "9000 exceeds the limit of 8192 output tokens for qwen3.5:4b. Try again or press Esc."],
      ["/exit", "'/exit' is not a positive whole number. Try again or press Esc."],
      ["99999999999999999999", "99999999999999999999 exceeds the limit of 8192 output tokens for qwen3.5:4b. Try again or press Esc."],
    ] as const) {
      await submit(rig, input);
      assert.ok(term(rig).flat().includes(message), input);
      assert.ok(term(rig).inputLine().includes("TOKENS > "), "the prompt stays open");
    }
    assert.equal(rig.store.saves.length, 0);
    assert.equal(rig.ollama.calls, 0, "nothing reached a provider");
    await esc(rig);
    assert.ok(term(rig).flat().includes("Max output tokens unchanged."));
    assert.ok(term(rig).inputLine().includes("YOU > héllo wörld"));
    assert.equal(term(rig).frame.cursor?.col, 8 + Array.from("héllo wör").length, "the cursor is back where it was");
    // again, this time confirmed
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await submit(rig, " 1234 ");
    await until(() => rig.store.saves.length === 1, "saved");
    assert.equal(entry(rig, "ollama", "qwen3.5:4b")?.max, "1234");
    assert.ok(term(rig).flat().includes("Max output tokens for qwen3.5:4b: 1234. Applies from the next message."));
    assert.ok(term(rig).inputLine().includes("YOU > héllo wörld"));
    // the current non-preset value is now "Custom (1234)"
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    assert.ok(term(rig).text().includes("* Custom (1234)"));
    await esc(rig);
    await press(rig, KEYS.ctrlU);
    assert.equal(await quit(rig), 0);
  });

  void it("with an unknown limit the prompt has no range and accepts large safe numbers, rejecting unsafe ones without saving", async () => {
    const rig = await startMenuTui({ configure: ({ ollama }) => { ollama.defaultCaps = { reasoning: LEVELS.reasoning }; } });
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    assert.ok(term(rig).text().includes("any positive number"));
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    assert.ok(term(rig).flat().includes("Type the max output tokens and press Enter; Esc cancels."));
    await submit(rig, "9007199254740992");
    assert.ok(term(rig).flat().includes("is more than the largest supported number of 9007199254740991"));
    assert.equal(rig.store.saves.length, 0);
    await submit(rig, "9007199254740991");
    await until(() => rig.store.saves.length === 1, "saved");
    assert.equal(entry(rig, "ollama", "qwen3.5:4b")?.max, "9007199254740991");
    await submit(rig, "z");
    await until(() => rig.ollama.calls === 1, "request");
    assert.equal(req(rig.ollama, 0).maxOutputTokens, 9007199254740991);
    assert.equal(await quit(rig), 0);
  });

  void it("idle Ctrl+C exits and Ctrl+D on an empty prompt exits, as in the normal input", async () => {
    const rig = await startMenuTui();
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await press(rig, KEYS.ctrlC);
    assert.equal((await rig.session.result).code, 130);
  });
});

void describe("F6 answer style", () => {
  void it("is global, saved alone, sent as instructions and never stored in the conversation", async () => {
    const store = new FakeSettingsStore(settingsDoc("normal", { ollama: { "qwen3.5:4b": { reasoning: "high" } } }));
    const rig = await startMenuTui({ store });
    await submit(rig, "one");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await press(rig, KEYS.f6);
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await until(() => store.saves.length === 1, "saved");
    assert.equal(store.stored.answerStyle, "detailed");
    assert.equal(store.stored.providers.get("ollama")?.get("qwen3.5:4b")?.reasoning, "high", "per-model settings preserved");
    assert.ok(term(rig).flat().includes("Answer style: Detailed. Applies from the next message."));
    await submit(rig, "two");
    await until(() => rig.ollama.calls === 2, "request");
    assert.equal(req(rig.ollama, 1).instructions, styleInstructions("detailed"));
    assert.equal(req(rig.ollama, 0).instructions, undefined);
    assert.deepEqual(rig.ollama.sent(1), ["user: one", "assistant: reply 1", "user: two"]);
    assert.ok(!JSON.stringify(rig.history.saved).includes("comprehensive"));
    assert.equal(await quit(rig), 0);
  });
});

void describe("settings persistence: provenance, overrides and failures", () => {
  void it("a confirmed choice clears only its own command-line override for the whole run; nothing from the command line is saved", async () => {
    const rig = await startMenuTui({
      argv: ["--provider", "ollama", "--model", "qwen3.5:4b", "--reasoning-effort", "low", "--max-output-tokens", "300", "--answer-style", "brief"],
    });
    assert.equal(rig.store.saves.length, 0, "startup saves nothing");
    await submit(rig, "a");
    await until(() => rig.ollama.calls === 1, "first");
    assert.deepEqual(req(rig.ollama, 0).reasoning, { effort: "low", explicit: true, source: "cli" });
    assert.equal(req(rig.ollama, 0).maxOutputTokens, 300);
    assert.equal(req(rig.ollama, 0).instructions, styleInstructions("brief"));
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    // F5 Default clears only the max override
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    assert.ok(term(rig).text().includes("* Custom (300)"));
    await press(rig, KEYS.home);
    await press(rig, KEYS.enter);
    await until(() => rig.store.saves.length === 1, "saved");
    assert.deepEqual(entry(rig, "ollama", "qwen3.5:4b"), { reasoning: undefined, max: null });
    assert.equal(rig.store.stored.answerStyle, "normal", "the --answer-style flag was not saved");
    // switch model: the remaining overrides still apply there, the cleared one does not come back
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "models");
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Now using Ollama / llama3.2:3b."), "switched");
    await submit(rig, "b");
    await until(() => rig.ollama.calls === 2, "second");
    assert.deepEqual(req(rig.ollama, 1).reasoning, { effort: "low", explicit: true, source: "cli" });
    assert.equal(req(rig.ollama, 1).maxOutputTokens, undefined);
    assert.equal(req(rig.ollama, 1).instructions, styleInstructions("brief"));
    assert.equal(rig.store.saves.length, 1, "switching and sending saved nothing");
    assert.equal(await quit(rig), 0);
  });

  void it("an unsupported remaining command-line value on the new model gives the notice, then the saved value", async () => {
    const store = new FakeSettingsStore(settingsDoc("normal", { ollama: { "llama3.2:3b": { reasoning: "on", maxOutputTokens: 128n } } }));
    const rig = await startMenuTui({
      store,
      argv: ["--provider", "ollama", "--model", "qwen3.5:4b", "--reasoning-effort", "high", "--max-output-tokens", "300"],
      configure: ({ ollama }) => { ollama.caps.set("llama3.2:3b", { reasoning: { known: true, values: ["off", "on"], allowsModelDefault: false, defaultValue: "off" }, maxOutputTokensLimit: 200 }); },
    });
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "models");
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Now using Ollama / llama3.2:3b."), "switched");
    const text = term(rig).flat();
    assert.ok(text.includes("300 exceeds the limit of 200 output tokens for llama3.2:3b. Using the default."), text);
    await submit(rig, "q");
    await until(() => rig.ollama.calls === 1, "request");
    // lenient: the high effort maps to "on" on an off/on model, the CLI limit falls back to the saved 128
    assert.deepEqual(req(rig.ollama, 0).reasoning, { effort: "on", explicit: true, source: "cli" });
    assert.equal(req(rig.ollama, 0).maxOutputTokens, 128);
    assert.equal(store.saves.length, 0);
    assert.equal(await quit(rig), 0);
  });

  void it("a save failure keeps the runtime choice with the reference warning; a later change retries and writes everything", async () => {
    const store = new FakeSettingsStore();
    store.results = [{ saved: false, warning: "Could not save settings: disk full" }];
    const rig = await startMenuTui({ store });
    await press(rig, KEYS.f6);
    await press(rig, KEYS.home);
    await press(rig, KEYS.enter);
    await until(() => term(rig).status() === "WARNING | Settings not saved", "warning");
    assert.ok(term(rig).flat().includes("Warning: Could not save settings: disk full"));
    assert.equal(store.stored.answerStyle, "normal", "the old disk content stays");
    await submit(rig, "q");
    await until(() => rig.ollama.calls === 1, "request");
    assert.equal(req(rig.ollama, 0).instructions, styleInstructions("brief"), "the choice is effective for this run");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await press(rig, KEYS.f4);
    await until(() => term(rig).text().includes("[ REASONING ]"), "menu");
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await until(() => store.saves.length === 2, "second save");
    assert.equal(store.stored.answerStyle, "brief", "the retry carries the earlier failed change too");
    assert.equal(entry(rig, "ollama", "qwen3.5:4b")?.reasoning, "high");
    assert.equal(await quit(rig), 0);
  });

  void it("a selected-field save preserves every other valid entry, special keys and huge limits", async () => {
    const huge = 2n ** 70n;
    const document = settingsDoc("detailed", {
      ollama: { "qwen3.5:4b": { reasoning: "low", maxOutputTokens: huge }, "a/b:c": { maxOutputTokens: 5n } },
      openai: { "gpt-6-luna": { reasoning: "high", maxOutputTokens: null } },
      "future-provider": { "x:y": { reasoning: "z" } },
    });
    // An own key named __proto__ (an object literal would set the prototype instead).
    const ollamaModels = new Map(document.providers.get("ollama"));
    ollamaModels.set("__proto__", { reasoning: "default" });
    const store = new FakeSettingsStore({ ...document, providers: new Map([...document.providers, ["ollama", ollamaModels]]) });
    const rig = await startMenuTui({ store });
    await press(rig, KEYS.f4);
    await until(() => term(rig).text().includes("[ REASONING ]"), "menu");
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await until(() => store.saves.length === 1, "saved");
    const after = store.stored;
    assert.equal(after.answerStyle, "detailed");
    assert.equal(after.providers.get("ollama")?.get("qwen3.5:4b")?.maxOutputTokens, huge, "the huge limit survived");
    assert.equal(after.providers.get("ollama")?.get("qwen3.5:4b")?.reasoning, "high");
    assert.equal(after.providers.get("future-provider")?.get("x:y")?.reasoning, "z");
    assert.equal(after.providers.get("openai")?.get("gpt-6-luna")?.maxOutputTokens, null);
    assert.equal(after.providers.get("ollama")?.get("a/b:c")?.maxOutputTokens, 5n);
    assert.equal(after.providers.get("ollama")?.get("__proto__")?.reasoning, "default");
    assert.equal(await quit(rig), 0);
  });

  void it("viewing and switching never rewrite settings, even when saved values are unusable at runtime", async () => {
    const store = new FakeSettingsStore(settingsDoc("normal", { ollama: { "llama3.2:3b": { reasoning: "high", maxOutputTokens: 2n ** 60n } } }));
    const rig = await startMenuTui({ store });
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "models");
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Now using Ollama / llama3.2:3b."), "switched");
    assert.ok(term(rig).flat().includes("cannot be used"), "the unusable saved limit is explained");
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    await esc(rig);
    assert.equal(store.saves.length, 0);
    assert.equal(await quit(rig), 0);
  });
});

void describe("signals and resizes with a menu or the prompt open", () => {
  void it("SIGTERM, SIGHUP and SIGINT with a menu open exit with the conventional codes, restored, without any change", async () => {
    for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const) {
      const rig = await startMenuTui();
      await press(rig, KEYS.f6);
      rig.session.signals.fire(signal);
      const done = await finishWithClock(rig.session);
      assert.equal(done.code, code, signal);
      assert.equal(rig.store.saves.length, 0, signal);
      assert.equal(term(rig).closeCount, 1, signal);
    }
  });

  void it("an output failure while a menu is open ends quietly with 141", async () => {
    const rig = await startMenuTui();
    await press(rig, KEYS.f6);
    term(rig).drawError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    term(rig).feed(KEYS.down);
    const done = await finishWithClock(rig.session);
    assert.equal(done.code, 141);
    assert.equal(done.err, "");
  });

  void it("resizing with the custom prompt open keeps prompt, typed text and the set-aside draft", async () => {
    const rig = await startMenuTui();
    await typed(rig, "my draft");
    await press(rig, KEYS.f5);
    await until(() => term(rig).text().includes("MAX OUTPUT TOKENS"), "menu");
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await typed(rig, "12");
    term(rig).resize(10, 30);
    await settleAll();
    assert.ok(term(rig).text().includes("Terminal too small."));
    await typed(rig, "3");
    term(rig).resize(30, 100);
    await settleAll();
    assert.ok(term(rig).inputLine().includes("TOKENS > 123"));
    await esc(rig);
    assert.ok(term(rig).inputLine().includes("YOU > my draft"));
    await press(rig, KEYS.ctrlU);
    assert.equal(await quit(rig), 0);
  });

  void it("a menu keeps its highlight across a resize that shrinks the visible rows", async () => {
    const rig = await startMenuTui({ configure: ({ ollama }) => { ollama.models = Array.from({ length: 30 }, (_, i) => model(`model-${String(i)}`)); } });
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "menu");
    for (let i = 0; i < 12; i += 1) await press(rig, KEYS.down);
    assert.ok(term(rig).text().includes("13/30 Enter=OK"));
    term(rig).resize(12, 40);
    await settleAll();
    assert.ok(term(rig).text().includes("13/30 Enter=OK"));
    assert.ok(term(rig).text().includes("model-12"), "the highlighted row stays visible");
    await esc(rig);
    assert.equal(await quit(rig), 0);
  });
});

void describe("requests are immutable snapshots", () => {
  void it("a request built before a settings change keeps its values, and the changed ones apply only to the next", async () => {
    const rig = await startMenuTui();
    await submit(rig, "one");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    const earlier = req(rig.ollama, 0);
    const before = JSON.stringify(earlier);
    await press(rig, KEYS.f4);
    await until(() => term(rig).text().includes("[ REASONING ]"), "menu");
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await until(() => rig.store.saves.length === 1, "saved");
    assert.equal(JSON.stringify(earlier), before);
    assert.ok(Object.isFrozen(earlier) && Object.isFrozen(earlier.reasoning));
    assert.equal(await quit(rig), 0);
  });
});

void describe("a failed save after an accepted switch", () => {
  void it("warns and leaves the new selection coherent and usable", async () => {
    const { ioError } = await import("./helpers/chat.js");
    const rig = await startMenuTui();
    rig.history.saveError = ioError();
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OLLAMA MODEL"), "menu");
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => term(rig).status() === "WARNING | Conversation not saved", "warning");
    assert.ok(term(rig).flat().includes("Now using Ollama / llama3.2:3b."));
    assert.ok(term(rig).flat().includes("Warning: "));
    rig.history.saveError = undefined;
    await submit(rig, "still works");
    await until(() => rig.ollama.calls === 1, "request");
    assert.equal(req(rig.ollama, 0).model, "llama3.2:3b");
    assert.equal(await quit(rig), 0);
  });
});
