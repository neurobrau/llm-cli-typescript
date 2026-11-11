import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { frameLines } from "../src/tui/frame.js";
import { horizontalRule } from "../src/tui/layout.js";
import { readPackageVersion } from "../src/version.js";
import { ControlledStream, ScriptedProvider, answer, completed, completedEvent, reasoning, streamOf, text } from "./helpers/chat.js";
import type { StoredConversation } from "../src/storage/types.js";
import { FakeTerminal, KEYS, startTui, until, settleAll } from "./helpers/tui.js";

const TITLE = `NeuroBräu TypeScript CLI ${readPackageVersion()}`;

/** Quits through Ctrl+D (empty input) and returns the run result. */
async function quit(session: Awaited<ReturnType<typeof startTui>>): Promise<number> {
  await session.key(KEYS.ctrlD);
  return (await session.result).code;
}

void describe("fullscreen: baseline geometry, text roles and colors (docs/tui-spec.md section 2)", () => {
  void it("renders the exact 80x25 screen right after a completed streamed answer", async () => {
    const provider = new ScriptedProvider("ollama");
    const stream = new ControlledStream();
    provider.pushStream(stream.handler);
    const session = await startTui({ argv: ["--stream", "--provider", "ollama", "--model", "qwen3.5:4b"], provider });
    await session.type("What is a neural network?");
    await session.key(KEYS.enter);
    stream.push(
      text("A neural network is a model made of layers of connected units that learn weights from data."),
      completedEvent("A neural network is a model made of layers of connected units that learn weights from data.", { inputTokens: 17n, outputTokens: 30n, totalTokens: 47n }, { totalSeconds: 7.17, loadSeconds: 0.2, evalSeconds: 1.88 }),
    );
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    const lines = session.term.lines();
    assert.equal(lines.length, 25);
    for (const line of lines) assert.equal(Array.from(line).length, 80);
    assert.equal((lines[0] ?? "").slice(0, 59), horizontalRule(59, TITLE));
    assert.ok((lines[0] ?? "").endsWith("+-[ LLM SETTINGS ]---+"));
    assert.equal((lines[0] ?? "")[58], "+");
    assert.equal(lines[1], "| YOU > What is a neural network?                         | F2 MODEL           |");
    assert.equal(lines[2], "|                                                         |  qwen3.5:4b        |");
    assert.equal(lines[3], "| AI > A neural network is a model made of layers of      | F3 PROVIDER        |");
    assert.equal(lines[4], "|      connected units that learn weights from data.      |  Ollama            |");
    assert.equal(lines[5], "|                                                         | F4 REASONING       |");
    assert.equal(lines[7], "|                                                         | F5 MAX TOKENS      |");
    assert.equal(lines[9], "|                                                         | F6 ANSWER STYLE    |");
    assert.equal(lines[11], "|                                                         | TOKENS             |");
    assert.equal(lines[12], "|                                                         |  in 17 out 30      |");
    assert.equal(lines[13], "|                                                         |  total 47          |");
    assert.equal(lines[14], "|                                                         |  context 17        |");
    assert.equal(lines[15], "|                                                         | COST (EST.)        |");
    assert.equal(lines[16], "|                                                         |  $0 (local)        |");
    assert.equal(lines[18], "|                                                         |                    |");
    assert.equal(lines[19], "+-[ Status ]----------------------------------------------+--------------------+");
    assert.equal(lines[20], `| ${"DONE | 7.17s total | load 0.20s | generation 1.88s | 15.96 tok/s".padEnd(76)} |`);
    assert.equal(lines[21], "+-[ Input ]--------------------------------------------------------------------+");
    assert.equal(lines[22], "| YOU >                                                                        |");
    assert.equal(lines[23], `+${"-".repeat(78)}+`);
    assert.equal(lines[24]?.slice(0, 79), " F1 /help | /reset /exit | F2-F6 settings | PgUp/PgDn scroll | Ctrl+C quit".padEnd(79));
    assert.equal(lines[24][79], " "); // the bottom-right cell is never written
    assert.deepEqual(session.term.frame.cursor, { row: 22, col: 8 });
    assert.equal(await quit(session), 0);
  });

  void it("uses the specified style for every text role", async () => {
    const provider = new ScriptedProvider("ollama", [answer("fine")]);
    const session = await startTui({ provider });
    await session.type("hello");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    const done = session.term.frame; // the DONE state ends with the next key
    await session.type("/bogus");
    await session.key(KEYS.enter);
    const { frame } = session.term;
    const find = (needle: string): { row: number; col: number } => {
      const lines = frameLines(frame);
      for (const [row, line] of lines.entries()) {
        const col = line.indexOf(needle);
        if (col >= 0) return { row, col };
      }
      throw new Error(`missing ${needle}`);
    };
    const styleAt = (needle: string): string | undefined => {
      const { row, col } = find(needle);
      return frame.styles[row]?.[col];
    };
    assert.equal(styleAt("+-["), "border");
    assert.equal(styleAt("F2 MODEL"), "border");
    assert.equal(styleAt("YOU > hello"), "user");
    assert.equal(styleAt("hello"), "text");
    assert.equal(styleAt("AI > fine"), "ai");
    assert.equal(styleAt("fine"), "text");
    assert.equal(styleAt("Unknown command"), "error");
    const doneRow = frameLines(done).findIndex((line) => line.startsWith("| DONE"));
    assert.equal(done.styles[doneRow]?.[2], "ai");
    assert.equal(done.styles[doneRow][9], "text");
    assert.equal(styleAt("F1 /help"), "border");
    assert.equal(await quit(session), 0);
  });

  void it("the 63/64-column transition hides and shows the settings panel", async () => {
    const term = new FakeTerminal({ rows: 25, cols: 64 });
    const session = await startTui({ terminal: term });
    assert.ok(term.text().includes("LLM SETTINGS"));
    assert.equal(term.lines()[0]?.[42], "+");
    term.resize(25, 63);
    await settleAll();
    assert.ok(!term.text().includes("LLM SETTINGS"));
    assert.equal(term.lines()[0], horizontalRule(63, TITLE));
    term.resize(25, 64);
    await settleAll();
    assert.ok(term.text().includes("LLM SETTINGS"));
    assert.equal(await quit(session), 0);
  });

  void it("is correct at the 40x12 minimum and never writes out of bounds while growing and shrinking", async () => {
    const term = new FakeTerminal({ rows: 12, cols: 40 });
    const session = await startTui({ terminal: term });
    for (const [rows, cols] of [[12, 40], [30, 120], [13, 41], [50, 200], [12, 40]] as const) {
      term.resize(rows, cols);
      await settleAll();
      const lines = term.lines();
      assert.equal(lines.length, rows);
      for (const line of lines) assert.equal(Array.from(line).length, cols);
      assert.equal(lines[rows - 1]?.at(-1), " ");
      assert.equal(lines[rows - 2], `+${"-".repeat(cols - 2)}+`);
      assert.ok(lines[rows - 3]?.startsWith("| YOU >"));
      assert.ok(lines[0]?.startsWith(`+-[ ${TITLE}`.slice(0, cols - 2)));
    }
    assert.equal(await quit(session), 0);
  });

  void it("below the minimum shows the clipped message, keeps the draft and input working, and recovers on resize", async () => {
    const term = new FakeTerminal({ rows: 25, cols: 80 });
    const session = await startTui({ terminal: term });
    await session.type("my draft");
    term.resize(11, 39);
    await settleAll();
    assert.deepEqual(term.lines().slice(0, 3).map((line) => line.trimEnd()), ["Terminal too small.", "Need 40x12, have 39x11.", "Resize or press Ctrl+C."]);
    assert.equal(term.frame.cursor, undefined);
    assert.equal(term.lines().length, 11);
    await session.type("!");
    term.resize(3, 10);
    await settleAll();
    assert.deepEqual(term.lines().map((line) => line.trimEnd()), ["Terminal", "Need 40x1", "Resize or"]);
    assert.ok(term.lines().every((line) => Array.from(line).length === 10));
    term.resize(1, 1);
    await settleAll();
    assert.equal(term.lines().length, 1);
    term.resize(25, 80);
    await settleAll();
    assert.ok(term.inputLine().startsWith("| YOU > my draft!"));
    assert.equal((await (async () => { await session.key(KEYS.ctrlC); return session.result; })()).code, 130);
  });
});

void describe("fullscreen: startup contents", () => {
  const stored = (overrides: Partial<StoredConversation> = {}): StoredConversation => ({
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: new Date("2026-10-21T07:00:00.000Z"),
    updatedAt: new Date("2026-10-21T08:00:00.000Z"),
    provider: "ollama",
    model: "m1",
    messages: [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ],
    requests: [
      { at: new Date(0), provider: "ollama", model: "m1", status: "completed", usage: { inputTokens: 100n, outputTokens: 50n, totalTokens: 150n } },
      { at: new Date(0), provider: "ollama", model: "m1", status: "completed", usage: { inputTokens: 200n, outputTokens: 80n } },
    ],
    ...overrides,
  });

  void it("shows restored messages, then warnings, then the restored notice, and totals from the stored records", async () => {
    const { MemoryHistory } = await import("./helpers/chat.js");
    const history = new MemoryHistory();
    history.latest = stored();
    const session = await startTui({ history, argv: ["--provider", "ollama"] });
    const view = session.term.conversation().filter((line) => line !== "");
    assert.ok(view[0]?.startsWith("YOU > old question"));
    assert.ok(view[1]?.startsWith("AI > old answer"));
    assert.ok(session.term.flat().includes("Restored conversation from 2026-"));
    assert.ok(session.term.flat().includes("(2 messages). Type /reset to start a new one."));
    const panel = session.term.lines().map((line) => line.slice(60, 78).trim());
    assert.deepEqual(panel.slice(11, 17), ["TOKENS", "in 300 out 130", "total 150", "context 200", "COST (EST.)", "$0 (local)"]);
    assert.equal(await quit(session), 0);
  });

  void it("keeps startup warnings as error entries and no restored notice for an empty conversation", async () => {
    const { MemoryHistory } = await import("./helpers/chat.js");
    const history = new MemoryHistory();
    history.latest = stored({ messages: [], requests: [] });
    const session = await startTui({ history, argv: ["--provider", "ollama", "--no-history"] });
    assert.ok(!session.term.text().includes("Restored conversation"));
    assert.equal(await quit(session), 0);
  });
});

void describe("fullscreen: non-streaming exchange", () => {
  void it("shows the waiting status before the answer, commits the pair and saves", async () => {
    const provider = new ScriptedProvider("ollama");
    const gate = (await import("./helpers/deferred.js")).deferred();
    provider.push(async () => {
      await gate.promise;
      return completed("the answer", { inputTokens: 3n, outputTokens: 4n, totalTokens: 7n });
    });
    const session = await startTui({ provider });
    await session.type("question");
    await session.key(KEYS.enter);
    assert.equal(session.term.status(), "GENERATING | Waiting for the complete response | Ctrl+C Cancel");
    assert.ok(session.term.conversation()[0]?.startsWith("YOU > question"));
    assert.equal(session.history.saved.length, 0);
    session.timers.advance(1500);
    gate.resolve();
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.equal(session.term.status(), "DONE | 1.50s observed");
    assert.ok(session.term.text().includes("AI > the answer"));
    assert.deepEqual(session.history.saved.at(-1)?.messages, [
      { role: "user", content: "question" },
      { role: "assistant", content: "the answer" },
    ]);
    await session.type("x");
    assert.equal(session.term.status(), "READY | Conversation saved");
    await session.key(KEYS.ctrlU);
    assert.equal(await quit(session), 0);
  });

  void it("an API error is visible but never enters the context or storage; the next request does not contain it", async () => {
    const { failure } = await import("./helpers/chat.js");
    const provider = new ScriptedProvider("ollama", [failure("service down", "connection"), answer("second answer")]);
    const session = await startTui({ provider });
    await session.type("first");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("ERROR"), "ERROR");
    assert.equal(session.term.status(), "ERROR | service down");
    assert.ok(session.term.flat().includes("Error: service down"));
    await session.type("second");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.deepEqual(provider.sent(1), ["user: second"]);
    assert.deepEqual(session.history.saved.at(-1)?.messages.map((m) => m.content), ["second", "second answer"]);
    assert.ok(session.term.text().includes("YOU > first"));
    assert.equal(await quit(session), 0);
  });

  void it("an incomplete answer keeps the partial text visible, records usage once and saves no messages", async () => {
    const { incomplete } = await import("./helpers/chat.js");
    const provider = new ScriptedProvider("ollama", [() => Promise.resolve(incomplete("partial words", { inputTokens: 5n, outputTokens: 6n }))]);
    const session = await startTui({ provider });
    await session.type("long one");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("WARNING"), "WARNING");
    assert.equal(session.term.status(), "WARNING | Response incomplete: the max output token limit was reached");
    const text_ = session.term.flat();
    assert.ok(text_.includes("AI > partial words"));
    assert.ok(text_.includes("Incomplete: the max output token limit was reached. The partial answer above was not saved."));
    assert.ok(session.term.lines().some((line) => line.includes("in 5 out 6")));
    assert.equal(session.history.saved.length, 0); // a first incomplete-only conversation stays unsaved
    await session.type("again");
    await session.key(KEYS.enter);
    await until(() => provider.calls === 2, "second request");
    assert.deepEqual(provider.sent(1), ["user: again"]);
    assert.equal(await quit(session), 0);
  });

  void it("a save failure is a warning; the exchange stays in memory and in later requests", async () => {
    const { MemoryHistory, ioError } = await import("./helpers/chat.js");
    const history = new MemoryHistory();
    history.saveError = ioError();
    const provider = new ScriptedProvider("ollama", [answer("A1"), answer("A2")]);
    const session = await startTui({ provider, history });
    await session.type("Q1");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.ok(session.term.flat().includes("Warning: "));
    await session.type("x");
    assert.equal(session.term.status(), "WARNING | Conversation not saved");
    await session.key(KEYS.ctrlU);
    await session.type("Q2");
    await session.key(KEYS.enter);
    await until(() => provider.calls === 2, "second request");
    assert.deepEqual(provider.sent(1), ["user: Q1", "assistant: A1", "user: Q2"]);
    assert.equal(await quit(session), 0);
  });
});

void describe("fullscreen: streaming exchange", () => {
  void it("text appears before the terminal event, as one growing entry; reasoning only changes the status", async () => {
    const provider = new ScriptedProvider("ollama");
    const stream = new ControlledStream();
    provider.pushStream(stream.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    await session.type("go");
    await session.key(KEYS.enter);
    assert.match(session.term.status(), /^CONNECTING \| 0\.0s elapsed \| Ctrl\+C Cancel$/);
    stream.push(reasoning("SECRET REASONING"));
    await until(() => session.term.status().startsWith("GENERATING | Thinking"), "thinking");
    session.timers.advance(1300);
    await settleAll();
    assert.equal(session.term.status(), "GENERATING | Thinking | 1.3s elapsed | Ctrl+C Cancel");
    assert.ok(!session.term.text().includes("SECRET"));
    stream.push(text("Hel"));
    await until(() => session.term.text().includes("AI > Hel"), "first delta");
    assert.equal(session.term.status().split(" | ")[0], "GENERATING");
    assert.ok(!session.term.status().includes("Thinking"));
    assert.equal(session.history.saved.length, 0); // nothing before the terminal event
    stream.push(text("lo"));
    await until(() => session.term.text().includes("AI > Hello"), "second delta");
    assert.equal(session.term.conversation().filter((line) => line.startsWith("AI >")).length, 1);
    stream.push(completedEvent("Hello", { inputTokens: 1n, outputTokens: 2n }));
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.equal(session.term.status(), "DONE | 1.30s observed | first text after 1.30s");
    assert.ok(!session.term.text().includes("SECRET"));
    assert.deepEqual(session.history.saved.at(-1)?.messages.map((m) => m.content), ["go", "Hello"]);
    assert.ok(!JSON.stringify(session.history.saved, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)).includes("SECRET"));
    assert.equal(await quit(session), 0);
  });

  void it("an empty completed answer is valid and committed", async () => {
    const provider = new ScriptedProvider("ollama");
    provider.pushStream(streamOf(completedEvent("")));
    const session = await startTui({ provider, argv: ["--stream"] });
    await session.type("quiet");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.deepEqual(session.history.saved.at(-1)?.messages.map((m) => m.content), ["quiet", ""]);
    assert.equal(await quit(session), 0);
  });

  void it("a failed stream after some text keeps the partial visible with the not-saved notice and commits nothing", async () => {
    const { failedEvent } = await import("./helpers/chat.js");
    const provider = new ScriptedProvider("ollama");
    provider.pushStream(streamOf(text("half"), failedEvent("link lost", "half", "connection")));
    const session = await startTui({ provider, argv: ["--stream"] });
    await session.type("go");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("ERROR"), "ERROR");
    assert.ok(session.term.text().includes("AI > half"));
    assert.ok(session.term.flat().includes("Error: link lost The partial answer above was not saved."));
    assert.equal(session.history.saved.length, 0);
    await session.type("next");
    await session.key(KEYS.enter);
    await until(() => provider.streamCalls === 2, "second");
    assert.deepEqual(provider.sent(1), ["user: next"]);
    assert.equal(await quit(session), 0);
  });

  void it("an incomplete stream records usage once and keeps the partial answer out of storage", async () => {
    const { incompleteEvent } = await import("./helpers/chat.js");
    const provider = new ScriptedProvider("ollama");
    provider.pushStream(streamOf(text("par"), incompleteEvent("par", { inputTokens: 4n, outputTokens: 5n })));
    const session = await startTui({ provider, argv: ["--stream"] });
    await session.type("go");
    await session.key(KEYS.enter);
    await until(() => session.term.status().startsWith("WARNING"), "WARNING");
    assert.ok(session.term.flat().includes("Incomplete: the max output token limit was reached. The partial answer above was not saved."));
    assert.ok(session.term.lines().some((line) => line.includes("in 4 out 5")));
    assert.equal(await quit(session), 0);
  });
});
