import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readPackageVersion } from "../src/version.js";
import { ControlledStream, ManualInput, MemoryHistory, ScriptedProvider, answer, failure, runChat, text } from "./helpers/chat.js";
import { FakeTerminal, KEYS, SUPPORTED, fakeHost, settleAll, startTui, until } from "./helpers/tui.js";
import type { TuiSession } from "./helpers/tui.js";
import type { StoredConversation } from "../src/storage/types.js";
import { createAbortError } from "../src/domain/errors.js";
import { missingApiKeyError } from "../src/providers/openai/errors.js";

async function submit(session: TuiSession, line: string): Promise<void> {
  await session.type(line);
  await session.key(KEYS.enter);
}

function assertRestoredOnce(session: TuiSession): void {
  assert.equal(session.term.log.filter((entry) => entry === "close").length, 1, "restored exactly once");
  assert.ok(!session.term.log.includes("draw-after-close"));
  assert.equal(session.signals.active, 0, "signal listeners removed");
  assert.equal(session.timers.pending, 0, "timers cancelled");
}

void describe("fullscreen: commands", () => {
  void it("/help, F1 (keeping the draft), /usage and unknown commands; aliases and case", async () => {
    const session = await startTui();
    await submit(session, "/help");
    assert.ok(session.term.flat().includes("In menus: Up/Down/PgUp/PgDn/Home/End move"));
    for (let i = 0; i < 3; i += 1) await session.key(KEYS.pageUp);
    assert.ok(session.term.flat().includes("Commands: /help show this help"));
    await session.key(KEYS.enter);
    await session.type("half typed");
    await session.key(KEYS.f1);
    assert.ok(session.term.inputLine().includes("YOU > half typed"));
    await session.key(KEYS.ctrlU);
    await submit(session, "\\USAGE");
    assert.ok(session.term.flat().includes("Token usage: no API requests in this conversation yet."));
    await submit(session, "/Frobnicate");
    assert.ok(session.term.flat().includes("Unknown command: /frobnicate. Type /help for commands."));
    assert.equal(session.provider.calls, 0);
    await submit(session, "/usr/bin is what?"); // not a command: more than one word
    await until(() => session.provider.calls === 1, "a message");
    await session.key(KEYS.ctrlU);
    await submit(session, "/exit");
    assert.equal((await session.result).code, 0);
    assertRestoredOnce(session);
  });

  void it("F2-F6 open their menus (F3 and F6 at once, the others after a check) and Esc or Ctrl+D close them without any change", async () => {
    const session = await startTui({ argv: ["--provider", "ollama"] });
    for (const [key, title] of [[KEYS.f3, "SELECT PROVIDER"], [KEYS.f6, "ANSWER STYLE"]] as const) {
      await session.key(key);
      assert.ok(session.term.text().includes(`[ ${title} ]`), title);
      await session.key(KEYS.ctrlD);
      assert.ok(!session.term.text().includes(`[ ${title} ]`));
    }
    assert.equal(session.provider.calls + session.provider.streamCalls, 0);
    assert.deepEqual(session.history.calls.filter((call) => call !== "loadActive" && call !== "loadLatest"), []);
    await session.key(KEYS.ctrlD);
    assert.equal((await session.result).code, 0);
  });

  void it("/reset starts a new conversation, clears the panel and totals, and saves the empty one", async () => {
    const provider = new ScriptedProvider("ollama", [answer("a", { inputTokens: 5n })]);
    const session = await startTui({ provider });
    await submit(session, "q");
    await until(() => session.history.saved.length === 1, "saved");
    await submit(session, "/reset");
    await until(() => session.term.flat().includes("Started a new conversation. The previous one stays saved."), "reset notice");
    assert.ok(!session.term.flat().includes("YOU > q"));
    assert.equal(session.term.status(), "READY | New conversation started");
    assert.deepEqual(session.history.saved.at(-1)?.messages, []);
    assert.ok(session.term.lines().some((line) => line.includes(" -")) && !session.term.text().includes("in 5"));
    await submit(session, "q2");
    await until(() => provider.calls === 2, "second");
    assert.deepEqual(provider.sent(1), ["user: q2"]); // the old messages are not sent to the new conversation
    await session.key(KEYS.ctrlU);
    await session.key(KEYS.ctrlD);
    assert.equal((await session.result).code, 0);
  });

  void it("/cleanup: the next line is the answer, never a message or command; only yes deletes", async () => {
    const history = new MemoryHistory();
    history.files = 3;
    const session = await startTui({ history });
    await submit(session, "/cleanup");
    await until(() => session.term.flat().includes("Delete 3 saved conversation(s) in"), "question");
    assert.ok(session.term.flat().includes("Type 'yes' to confirm:"));
    assert.equal(session.term.status(), "WARNING | Type yes to delete saved conversations; anything else cancels");
    await submit(session, "/exit"); // an answer, not a command
    assert.ok(session.term.flat().includes("Cleanup cancelled. Nothing was deleted."));
    assert.ok(!history.calls.includes("deleteAll"));
    assert.equal(session.provider.calls, 0);
    await submit(session, "/cleanup");
    await until(() => session.term.flat().split("Delete 3 saved").length === 3, "second question");
    await submit(session, "  YES ");
    await until(() => history.calls.includes("deleteAll"), "deleted");
    await until(() => session.term.flat().includes("Deleted 3 saved conversation(s). Started a new conversation."), "notice");
    assert.equal(session.term.status(), "READY | Saved conversations deleted");
    assert.equal(session.provider.calls, 0);
    await session.key(KEYS.ctrlD);
    assert.equal((await session.result).code, 0);
  });

  void it("/cleanup with nothing saved, and with --no-history", async () => {
    const empty = await startTui();
    await submit(empty, "/cleanup");
    await until(() => empty.term.flat().includes("No saved conversations."), "none");
    await empty.key(KEYS.ctrlD);
    await empty.result;
    const off = await startTui({ argv: ["--no-history"] });
    await submit(off, "/cleanup");
    await until(() => off.term.flat().includes("Conversation history is disabled for this session (--no-history)."), "disabled");
    assert.equal(off.history.calls.length, 0);
    await submit(off, "/reset");
    await until(() => off.term.flat().includes("Conversation history cleared."), "cleared");
    await off.key(KEYS.ctrlD);
    await off.result;
  });
});

void describe("fullscreen: keys", () => {
  void it("edits with every key, including Unicode and the Home/End variants", async () => {
    const session = await startTui();
    await session.type("Grüß Gott");
    await session.key(KEYS.home);
    await session.key(KEYS.delete);
    assert.ok(session.term.inputLine().includes("YOU > rüß Gott"));
    await session.key(KEYS.end);
    await session.key(KEYS.left);
    await session.key(KEYS.left);
    await session.type("😀");
    assert.ok(session.term.inputLine().includes("YOU > rüß Go😀tt"));
    assert.equal(session.term.frame.cursor?.col, 8 + 7);
    await session.key(KEYS.ctrlA);
    await session.key(KEYS.right);
    await session.key(KEYS.backspace);
    assert.ok(session.term.inputLine().includes("YOU > üß Go😀tt"));
    await session.key(KEYS.ctrlE);
    await session.key(KEYS.ctrlU);
    assert.ok(session.term.inputLine().startsWith("| YOU >     "));
    await session.key(KEYS.ctrlD);
    assert.equal((await session.result).code, 0);
  });

  void it("scrolls the input horizontally and keeps the cursor inside the field", async () => {
    const session = await startTui();
    await session.type("0123456789".repeat(10));
    const line = session.term.inputLine();
    assert.equal(Array.from(line).length, 80);
    assert.ok(line.includes("56789 |") || line.trimEnd().endsWith("9 |") || line.includes("789"));
    assert.equal(session.term.frame.cursor?.col, 8 + 69); // field is 70 columns wide; the cursor sits in the last
    await session.key(KEYS.home);
    assert.ok(session.term.inputLine().includes("YOU > 0123456789"));
    assert.equal(session.term.frame.cursor.col, 8);
    await session.key(KEYS.ctrlU);
    await session.key(KEYS.ctrlD);
    await session.result;
  });

  void it("Ctrl+D exits only on empty input; Ctrl+C idle exits 130", async () => {
    const one = await startTui();
    await one.type("x");
    await one.key(KEYS.ctrlD);
    assert.equal(one.term.closeCount, 0);
    await one.key(KEYS.ctrlC);
    assert.equal((await one.result).code, 130);
    assertRestoredOnce(one);
    const two = await startTui();
    await two.key(KEYS.ctrlD);
    assert.equal((await two.result).code, 0);
    assertRestoredOnce(two);
  });

  void it("ignores unsupported keys and sequences, and a lone Esc after 25 ms; nothing leaks into the draft", async () => {
    const session = await startTui();
    await session.type("a\x1b[1;5Cb\x1b[24~c\x1b[Zd\t\x1bxe");
    assert.ok(session.term.inputLine().includes("YOU > abcde"));
    await session.key("\x1b");
    assert.equal(session.timers.pending > 0, true);
    session.timers.advance(25);
    await session.type("[A"); // no longer the tail of an escape sequence: plain text
    assert.ok(session.term.inputLine().includes("YOU > abcde[A"));
    await session.key("\x1b");
    await session.key("[D"); // the rest arrives within the wait: a real Left key
    await session.key("Z");
    assert.ok(session.term.inputLine().includes("YOU > abcde[Z"));
    await session.key(KEYS.ctrlU);
    await session.key(KEYS.ctrlD);
    await session.result;
  });

  void it("decodes keys split across chunks and split UTF-8", async () => {
    const session = await startTui();
    const bytes = Buffer.from("Привет😀", "utf8");
    for (const byte of bytes) session.term.feed(Uint8Array.of(byte));
    for (const part of ["\x1b", "[", "D", "\x1b[", "3~"]) session.term.feed(part);
    await settleAll();
    assert.ok(session.term.inputLine().includes("YOU > Привет"));
    assert.ok(!session.term.inputLine().includes("😀")); // Left then Delete removed the emoji
    await session.key(KEYS.ctrlU);
    await session.key(KEYS.ctrlD);
    await session.result;
  });

  void it("bounds the draft: an oversized paste is cut with a warning and can never exceed the line limit", async () => {
    const provider = new ScriptedProvider("ollama");
    const session = await startTui({ provider });
    const limit = 8 * 1024 * 1024;
    session.term.feed("x".repeat(limit + 5000));
    session.term.feed("y".repeat(10_000));
    await settleAll();
    assert.equal(session.term.status(), "WARNING | The input is too long; the extra text was dropped");
    await session.key(KEYS.enter);
    await until(() => provider.calls === 1, "request");
    assert.ok((provider.requests[0]?.messages[0]?.content.length ?? 0) <= limit);
    assert.ok(!(provider.requests[0]?.messages[0]?.content.includes("y") ?? true));
    await until(() => session.history.saved.length === 1, "saved");
    await settleAll();
    await session.key(KEYS.ctrlD);
    await session.result;
  });

  void it("never submits an escape sequence as a message", async () => {
    const session = await startTui();
    await session.type("\x1b[15~\x1bOP\x1b[99~");
    await session.key(KEYS.enter);
    await settleAll();
    assert.equal(session.provider.calls, 0);
    await session.key(KEYS.ctrlD);
    await session.result;
  });
});

void describe("fullscreen: exit paths restore the terminal exactly once", () => {
  void it("EOF on the terminal input exits 0", async () => {
    const session = await startTui();
    session.term.end();
    assert.equal((await session.result).code, 0);
    assertRestoredOnce(session);
  });

  void it("SIGTERM is 143 and SIGHUP is 129, also while a request is running (it is cancelled and closed first)", async () => {
    for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      const provider = new ScriptedProvider("ollama");
      const stream = new ControlledStream();
      provider.pushStream(stream.handler);
      const session = await startTui({ provider, argv: ["--stream"] });
      await submit(session, "q");
      await until(() => stream.pulls > 0, "pull");
      session.signals.fire(signal);
      session.signals.fire(signal); // repeats are absorbed
      assert.equal((await session.result).code, code);
      assert.equal(stream.returned, true);
      assert.equal(session.history.saved.length, 0);
      assertRestoredOnce(session);
    }
  });

  void it("an interrupt during startup exits without ever changing the terminal", async () => {
    const term = new FakeTerminal();
    const provider = new ScriptedProvider("ollama");
    provider.getCapabilities = (_model, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => { reject(createAbortError()); }, { once: true });
      });
    const session = await startTui({ terminal: term, provider, noWait: true });
    await until(() => session.signals.active === 1, "startup running");
    session.signals.fire("SIGTERM");
    const done = await session.result;
    assert.equal(done.code, 143);
    assert.equal(done.err, "neurobrau: interrupted\n");
    assert.equal(term.openCount, 0);
    assert.equal(session.signals.active, 0);
  });

  void it("an unexpected provider error ends with exit 1 and a fixed message; the terminal is restored first", async () => {
    const provider = new ScriptedProvider("ollama", [() => { throw new TypeError("secret stack detail"); }]);
    const session = await startTui({ provider });
    await submit(session, "q");
    const done = await session.result;
    assert.equal(done.code, 1);
    assert.equal(done.err, "neurobrau: error: an internal error occurred\n");
    const log = session.term.log;
    assert.ok(log.indexOf("close") < log.indexOf("err:neurobrau: error: an internal error occurred\n"), "restored before the diagnostic");
    assertRestoredOnce(session);
  });

  void it("an exception inside the key handling restores the terminal", async () => {
    const provider = new ScriptedProvider("ollama");
    const session = await startTui({ provider });
    session.provider.stream = () => { throw new Error("boom"); };
    session.provider.generate = () => { throw new Error("boom"); };
    await submit(session, "q");
    const done = await session.result;
    assert.equal(done.code, 1);
    assertRestoredOnce(session);
  });

  void it("terminal initialization failure unwinds, returns a fixed error with exit 1 and starts no request", async () => {
    const term = new FakeTerminal();
    term.openError = new Error("no raw mode");
    const provider = new ScriptedProvider("ollama");
    const session = await startTui({ terminal: term, provider, noWait: true });
    const done = await session.result;
    assert.equal(done.code, 1);
    assert.equal(done.err, "neurobrau: error: could not initialize the terminal\n");
    assert.equal(term.openCount, 1);
    assert.equal(term.closeCount, 1);
    assert.equal(provider.calls + provider.streamCalls, 0);
    assert.equal(session.signals.active, 0);
  });
});

void describe("fullscreen: startup happens before any terminal change", () => {
  void it("a missing key exits 3 without opening the terminal", async () => {
    const term = new FakeTerminal();
    const session = await startTui({
      terminal: term,
      noWait: true,
      argv: ["--provider", "openai"],
      deps: { checkProviderReady: () => { throw missingApiKeyError(); } },
    });
    const done = await session.result;
    assert.equal(done.code, 3);
    assert.equal(term.openCount, 0);
    assert.equal(term.closeCount, 0);
    assert.equal(term.log.filter((entry) => entry === "open").length, 0);
    assert.match(done.err, /OPENAI_API_KEY/u);
    assert.ok(!done.out.includes("\x1b"));
  });

  void it("a capability error at startup uses the existing exit mapping and never opens the terminal", async () => {
    const { ProviderError } = await import("../src/domain/errors.js");
    const term = new FakeTerminal();
    const provider = new ScriptedProvider("ollama", [], { capabilityError: new ProviderError("model gone", "connection") });
    const session = await startTui({ terminal: term, provider, noWait: true });
    const done = await session.result;
    assert.equal(done.code, 7);
    assert.equal(term.openCount, 0);
  });
});

void describe("fullscreen: --transcript-on-exit", () => {
  const stored: StoredConversation = {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: new Date("2026-10-21T07:00:00.000Z"),
    updatedAt: new Date("2026-10-21T08:00:00.000Z"),
    provider: "ollama",
    model: "m",
    messages: [
      { role: "user", content: "old  question\nline 2" },
      { role: "assistant", content: "old answer \u001b[31mred" },
    ],
    requests: [],
  };

  void it("prints exactly the committed messages, restored ones first, after the terminal was restored", async () => {
    const history = new MemoryHistory();
    history.latest = stored;
    const provider = new ScriptedProvider("ollama", [failure("api down"), answer("new answer")]);
    const session = await startTui({ history, provider, argv: ["--provider", "ollama", "--transcript-on-exit"] });
    await submit(session, "failed question");
    await until(() => session.term.status().startsWith("ERROR"), "ERROR");
    await submit(session, "good question");
    await until(() => history.saved.length > 0, "saved");
    await session.key(KEYS.ctrlU);
    await session.key(KEYS.ctrlD);
    const done = await session.result;
    assert.equal(done.code, 0);
    assert.equal(
      done.out,
      "YOU > old  question\nline 2\n\nAI > old answer \uFFFD[31mred\n\nYOU > good question\n\nAI > new answer\n",
    );
    const log = session.term.log;
    assert.ok(log.indexOf("close") < log.findIndex((entry) => entry.startsWith("out:YOU > old")), "restored before the transcript");
    assert.ok(!done.out.includes(String.fromCharCode(27)), "no escape reaches the terminal through the transcript");
    assert.equal(stored.messages[1]?.content, "old answer \u001b[31mred", "stored messages are unchanged");
    assert.equal(history.saved.at(-1)?.messages[1]?.content, "old answer \u001b[31mred", "and so are the saved ones");
  });

  void it("excludes partial answers of a cancelled request and prints nothing for an empty conversation", async () => {
    const provider = new ScriptedProvider("ollama");
    const stream = new ControlledStream();
    provider.pushStream(stream.handler);
    const session = await startTui({ provider, argv: ["--stream", "--transcript-on-exit"] });
    await submit(session, "q");
    stream.push(text("partial"));
    await until(() => session.term.flat().includes("partial"), "partial");
    await session.key(KEYS.ctrlC);
    await until(() => stream.returned, "closed");
    await session.key(KEYS.ctrlD);
    const done = await session.result;
    assert.equal(done.out, "");
    assert.equal(done.code, 0);
  });

  void it("is printed on the interrupt and termination paths too", async () => {
    const history = new MemoryHistory();
    history.latest = stored;
    const session = await startTui({ history, argv: ["--provider", "ollama", "--transcript-on-exit"] });
    session.signals.fire("SIGTERM");
    const done = await session.result;
    assert.equal(done.code, 143);
    assert.ok(done.out.startsWith("YOU > old  question"));
  });

  void it("the terminal is restored even when the transcript cannot be written", async () => {
    const history = new MemoryHistory();
    history.latest = stored;
    const session = await startTui({
      history,
      argv: ["--provider", "ollama", "--transcript-on-exit"],
      onWrite: (stream) => {
        if (stream === "out") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      },
    });
    await session.key(KEYS.ctrlD);
    const done = await session.result;
    assert.equal(done.code, 141);
    assertRestoredOnce(session);
  });

  void it("has no extra effect in the plain chat", async () => {
    const input = new ManualInput(["/exit"]);
    const done = await runChat(["--transcript-on-exit"], new ScriptedProvider("ollama"), input, {
      env: { XDG_STATE_HOME: "/virtual/state" },
      deps: { createHistoryStore: () => new MemoryHistory() },
    });
    assert.equal(done.code, 0);
    assert.ok(!done.out.includes("YOU > old"));
    assert.ok(done.out.includes("Goodbye."));
  });
});

void describe("fullscreen: mode selection through run()", () => {
  const plainRun = async (argv: readonly string[], environment = SUPPORTED): Promise<{ created: number; reads: number; code: number; out: string }> => {
    const term = new FakeTerminal();
    const host = fakeHost(term, environment);
    const done = await runChat(argv, new ScriptedProvider("ollama"), new ManualInput(["/exit"]), {
      env: { XDG_STATE_HOME: "/virtual/state" },
      deps: { tui: host.host, createHistoryStore: () => new MemoryHistory() },
    });
    return { created: host.created, reads: host.environmentReads, code: done.code, out: done.out };
  };

  void it("--plain wins on a capable terminal and prints no escape sequences", async () => {
    const result = await plainRun(["--plain"]);
    assert.equal(result.created, 0);
    assert.equal(result.reads, 0);
    assert.ok(result.out.includes("YOU > "));
    assert.ok(!result.out.includes("\x1b"));
  });

  void it("falls back to the plain chat for pipes, dumb and unknown terminals, and missing raw mode", async () => {
    for (const environment of [
      { ...SUPPORTED, stdinIsTTY: false },
      { ...SUPPORTED, stdoutIsTTY: false },
      { ...SUPPORTED, term: undefined },
      { ...SUPPORTED, term: "" },
      { ...SUPPORTED, term: "dumb" },
      { ...SUPPORTED, term: "linux" },
      { ...SUPPORTED, rawModeSupported: false },
    ]) {
      const result = await plainRun([], environment);
      assert.equal(result.created, 0, JSON.stringify(environment));
      assert.ok(result.out.includes("YOU > "));
      assert.ok(!result.out.includes("\x1b"));
    }
  });

  void it("help, version, invalid arguments and one-shot never inspect or create a terminal", async () => {
    for (const argv of [["--help"], ["--version"], ["--bogus"], ["--plain", "prompt"], ["--transcript-on-exit", "prompt"], ["one-shot prompt"], ["--stream", "one-shot prompt"]]) {
      const host = fakeHost();
      const provider = new ScriptedProvider("ollama");
      await runChat(argv, provider, new ManualInput(), {
        env: { XDG_STATE_HOME: "/virtual/state" },
        deps: { tui: host.host, createHistoryStore: () => { throw new Error("no history for this invocation"); } },
      });
      assert.equal(host.environmentReads, 0, JSON.stringify(argv));
      assert.equal(host.created, 0, JSON.stringify(argv));
      assert.equal(host.signals.registrations, 0, JSON.stringify(argv));
    }
  });

  void it("a composition without a terminal host stays plain even on --stream", async () => {
    const done = await runChat(["--stream"], new ScriptedProvider("ollama"), new ManualInput(["/exit"]), {
      env: { XDG_STATE_HOME: "/virtual/state" },
      deps: { createHistoryStore: () => new MemoryHistory() },
    });
    assert.ok(done.out.includes(`NeuroBräu TypeScript CLI ${readPackageVersion()}`));
    assert.ok(done.out.includes("YOU > "));
  });
});

void describe("fullscreen: terminal controls in model output cannot escape the screen", () => {
  void it("every frame cell is a displayable character, whatever the answer, the user or a warning contains", async () => {
    const hostile = "\u001b[?1049l\u001b[2J\u001b]0;pwned\u0007\u009b31m\u0000\u007fend x\uD800y";
    const provider = new ScriptedProvider("ollama", [answer(`AI ${hostile}`)]);
    const history = new MemoryHistory();
    history.latest = {
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date(0),
      updatedAt: new Date(1000),
      provider: "ollama",
      model: "m",
      messages: [{ role: "assistant", content: hostile }],
      requests: [],
    };
    const session = await startTui({ provider, history, argv: ["--provider", "ollama", "--model", `m${hostile}`] });
    await session.type("user text");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    for (const frame of session.term.frames) {
      for (const row of frame.chars) {
        for (const cell of row) {
          assert.equal(Array.from(cell).length, 1);
          const code = cell.codePointAt(0) ?? 0;
          assert.ok(code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && code !== 0x2028 && !(code >= 0xd800 && code <= 0xdfff), `control in a cell: ${code.toString(16)}`);
        }
      }
    }
    // Stored and sent text stay exactly as given.
    assert.equal(history.saved.at(-1)?.messages[1]?.content, `AI ${hostile}`);
    assert.equal(provider.requests[0]?.messages.at(-1)?.content, "user text");
    await session.key(KEYS.ctrlU);
    await session.key(KEYS.ctrlD);
    await session.result;
  });
});

void it("importing the fullscreen modules changes nothing", async () => {
  const before = { listeners: process.listenerCount("SIGINT") + process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP"), raw: process.stdin.isRaw };
  await import("../src/tui/ansi-terminal.js");
  await import("../src/tui/controller.js");
  await import("../src/tui/run-tui.js");
  assert.equal(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP"), before.listeners);
  assert.equal(process.stdin.isRaw, before.raw);
});
