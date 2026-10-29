import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createAbortError } from "../src/domain/errors.js";
import { readPackageVersion } from "../src/version.js";
import { ManualInput, MemoryHistory, ScriptedProvider, answer, completed, deaf, failure, fakeInterrupts, gated, incomplete, ioError, outcome, promptWatcher, runChat } from "./helpers/chat.js";
import type { ChatRun } from "./helpers/chat.js";
import { deferred } from "./helpers/deferred.js";
import { makeTree } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

const TITLE = `NeuroBräu TypeScript CLI ${readPackageVersion()}`;
const BANNER = `${TITLE}\nProvider: openai | Model: default-model\nType /help for commands, /exit to quit.\n\n`;

let tree: Tree;
beforeEach(async () => {
  tree = await makeTree();
});
afterEach(async () => {
  await tree.cleanup();
});

const chat = (lines: readonly string[], provider: ScriptedProvider, extra: readonly string[] = ["--no-history"]): Promise<ChatRun> =>
  runChat(extra, provider, new ManualInput(lines, true), { tree });

/** Lets queued microtasks and I/O callbacks run (no timers). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

void describe("plain chat: turns and context", () => {
  void it("prints the banner, sends sequential requests with full committed context and says goodbye", async () => {
    const provider = new ScriptedProvider("openai", [answer("one"), answer("two")]);
    const run = await chat(["first", "second", "/exit"], provider);
    assert.equal(run.code, 0);
    assert.equal(run.err, "");
    assert.equal(run.out, `${BANNER}YOU > AI > one\nYOU > AI > two\nYOU > Goodbye.\n`);
    assert.deepEqual(provider.sent(0), ["user: first"]);
    assert.deepEqual(provider.sent(1), ["user: first", "assistant: one", "user: second"]);
    assert.equal(provider.maxInFlight, 1);
    assert.equal(provider.requests[0]?.model, "default-model");
  });

  void it("never sends commands, notices, usage reports or command-looking confirmations to the model", async () => {
    const provider = new ScriptedProvider("openai", [answer("a"), answer("b")]);
    const run = await chat(["hello", "/help", "\\USAGE", "/nope", "/usr/bin is what?", "/exit"], provider);
    assert.equal(run.code, 0);
    assert.equal(provider.calls, 2);
    assert.deepEqual(provider.sent(1), ["user: hello", "assistant: a", "user: /usr/bin is what?"]);
    assert.match(run.out, /Unknown command: \/nope\. Type \/help for commands\.\n/);
    assert.match(run.out, /Commands:\n/);
    assert.match(run.out, /Conversation usage|no API requests/);
  });

  void it("keeps reasoning text out of the answer, the committed messages and later requests", async () => {
    const provider = new ScriptedProvider("openai", [outcome({ kind: "completed", result: { text: "visible", reasoning: "secret thoughts" } }), answer("b")]);
    const run = await chat(["one", "two"], provider);
    assert.ok(!run.out.includes("secret thoughts"));
    assert.deepEqual(provider.sent(1), ["user: one", "assistant: visible", "user: two"]);
  });

  void it("trims input, ignores empty lines and accepts an allowed empty completed answer", async () => {
    const provider = new ScriptedProvider("openai", [answer(""), answer("x")]);
    const run = await chat(["", "   ", "  padded  ", "next"], provider);
    assert.equal(run.code, 0);
    assert.deepEqual(provider.sent(0), ["user: padded"]);
    assert.deepEqual(provider.sent(1), ["user: padded", "assistant: ", "user: next"]);
    assert.match(run.out, /YOU > AI > \n/);
    assert.ok(run.out.endsWith("YOU > \nGoodbye.\n"));
  });

  void it("sends the resolved request settings, with style instructions only as instructions", async () => {
    const provider = new ScriptedProvider("openai", [answer("ok")]);
    const run = await chat(["q"], provider, ["--no-history", "--answer-style", "brief", "--max-output-tokens", "77"]);
    assert.equal(run.code, 0);
    const [request] = provider.requests;
    assert.match(request?.instructions ?? "", /^Answer briefly/);
    assert.equal(request?.maxOutputTokens, 77);
    assert.deepEqual(provider.sent(0), ["user: q"]);
  });

  void it("shows reported usage per reply with --usage, for completed and incomplete outcomes", async () => {
    const provider = new ScriptedProvider("openai", [
      outcome(completed("a", { inputTokens: 3n, outputTokens: 4n })),
      outcome(incomplete("part", { inputTokens: 10n })),
      answer("c"),
    ]);
    const run = await chat(["1", "2", "3"], provider, ["--no-history", "--usage"]);
    assert.equal(run.err.split("Token usage: ").length - 1, 3);
    assert.match(run.err, /Token usage: input=3, output=4\n/);
    assert.match(run.err, /Token usage: input=10\n/);
    assert.match(run.err, /Token usage: not reported\n/);
  });
});

void describe("plain chat: failures and incomplete answers", () => {
  void it("reports a provider failure, keeps the chat going and does not leak the failed prompt", async () => {
    const provider = new ScriptedProvider("openai", [failure("The service is unavailable."), answer("fine")]);
    const run = await chat(["bad", "good", "/exit"], provider);
    assert.equal(run.code, 0);
    assert.equal(run.err, "error: The service is unavailable.\n");
    assert.deepEqual(provider.sent(1), ["user: good"]);
  });

  void it("shows an incomplete answer, does not commit it, and records its usage only in memory for a new conversation", async () => {
    const provider = new ScriptedProvider("openai", [outcome(incomplete("partial text", { inputTokens: 7n, outputTokens: 9n })), answer("full")]);
    const history = new MemoryHistory();
    const run = await runChat([], provider, new ManualInput(["long question", "again", "/usage", "/exit"], true), {
      tree,
      deps: { createHistoryStore: () => history },
    });
    assert.equal(run.code, 0);
    assert.match(run.out, /AI > partial text\n/);
    assert.match(run.err, /^warning: Response incomplete: the max output token limit was reached\. The partial response was not saved\.\n/);
    assert.deepEqual(provider.sent(1), ["user: again"]); // neither prompt nor partial text
    // The first incomplete request created no file; the later completed turn saves both records.
    assert.equal(history.saved.length, 1);
    assert.deepEqual(history.saved[0]?.requests.map((r) => r.status), ["incomplete"]);
    assert.deepEqual(history.saved[0].messages.map((m) => m.content), ["again", "full"]);
    assert.match(run.out, /Includes 1 incomplete answer/);
  });

  void it("an incomplete answer without usage records nothing and saves nothing", async () => {
    const provider = new ScriptedProvider("openai", [outcome(incomplete(""))]);
    const history = new MemoryHistory();
    const run = await runChat([], provider, new ManualInput(["q"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.equal(run.code, 0);
    assert.doesNotMatch(run.out, /AI > /);
    assert.match(run.err, /warning: Response incomplete: the max output token limit was reached\.\n/);
    assert.deepEqual(history.calls.filter((c) => c.startsWith("save")), []);
  });

  void it("saves an incomplete record when the conversation already has messages", async () => {
    const provider = new ScriptedProvider("openai", [answer("one"), outcome(incomplete("p", { outputTokens: 5n }))]);
    const history = new MemoryHistory();
    await runChat([], provider, new ManualInput(["a", "b"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.equal(history.saved.length, 2);
    assert.deepEqual(history.saved[1]?.requests.map((r) => r.status), ["incomplete"]);
    assert.equal(history.saved[1].messages.length, 2);
  });

  void it("exits 1 with fixed text for an unexpected provider exception", async () => {
    const provider = new ScriptedProvider("openai", [() => Promise.reject(new TypeError("secret detail sk-abc"))]);
    const run = await chat(["q"], provider);
    assert.equal(run.code, 1);
    assert.match(run.err, /^neurobrau: error: an internal error occurred\n$/);
    assert.ok(!run.err.includes("secret"));
  });
});

void describe("plain chat: input timing", () => {
  void it("keeps lines that arrive during a request, in order, and issues strictly sequential requests", async () => {
    const gate = deferred();
    const reached = deferred();
    const provider = new ScriptedProvider("openai", [gated(gate.promise, completed("A"), () => { reached.resolve(); }), answer("B")]);
    const input = new ManualInput(["first"]);
    const pending = runChat(["--no-history"], provider, input, { tree });
    await reached.promise;
    input.push("second", "/exit");
    await settle();
    assert.equal(provider.calls, 1); // second waits for the first
    gate.resolve();
    const run = await pending;
    assert.equal(run.code, 0);
    assert.equal(provider.maxInFlight, 1);
    assert.deepEqual(provider.sent(1), ["user: first", "assistant: A", "user: second"]);
  });

  void it("an end of input while a request is in flight does not cancel it", async () => {
    const gate = deferred();
    const reached = deferred();
    const provider = new ScriptedProvider("openai", [gated(gate.promise, completed("done"), () => { reached.resolve(); })]);
    const input = new ManualInput(["q"]);
    const pending = runChat(["--no-history"], provider, input, { tree });
    await reached.promise;
    input.end();
    await settle();
    gate.resolve();
    const run = await pending;
    assert.equal(run.code, 0);
    assert.match(run.out, /AI > done\nYOU > \nGoodbye\.\n$/);
  });

  void it("distinguishes a read error from the end of input", async () => {
    const provider = new ScriptedProvider("openai");
    const input = new ManualInput(["ok"]);
    input.fail();
    const run = await runChat(["--no-history"], provider, input, { tree });
    assert.equal(run.code, 1);
    assert.equal(provider.calls, 1); // the buffered line is still processed first
    assert.match(run.err, /neurobrau: error: could not read input\n$/);
    assert.ok(input.disposed);
  });

  void it("an unknown command name is escaped and never reaches the provider", async () => {
    const provider = new ScriptedProvider("openai");
    const run = await chat(["/bad\u001b[31mname"], provider);
    assert.match(run.out, /Unknown command: \/bad\\x1b\[31mname\./);
    assert.equal(provider.calls, 0);
    assert.ok(!run.out.includes("\u001b"));
  });
});

void describe("plain chat: interrupts and cancellation", () => {
  void it("exits 130 for Ctrl+C at the idle prompt and releases everything", async () => {
    const interrupts = fakeInterrupts();
    const input = new ManualInput();
    const provider = new ScriptedProvider("openai");
    const prompts = promptWatcher();
    const pending = runChat(["--no-history"], provider, input, { tree, onWrite: prompts.onWrite, deps: { interrupt: interrupts.source } });
    await prompts.reached(1);
    interrupts.fire();
    const run = await pending;
    assert.equal(run.code, 130);
    assert.ok(run.out.endsWith("YOU > \nGoodbye.\n"));
    assert.equal(interrupts.active(), 0);
    assert.ok(input.disposed);
    assert.equal(provider.calls, 0);
  });

  const timeouts = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

  void it("cancels the in-flight request, prints the notice and returns to the prompt without committing", async () => {
    const interrupts = fakeInterrupts();
    const reached = deferred();
    const provider = new ScriptedProvider("openai", [gated(new Promise<void>(() => undefined), completed("never"), () => { reached.resolve(); }), answer("after")]);
    const input = new ManualInput(["slow"]);
    const timersBefore = timeouts();
    const pending = runChat(["--no-history"], provider, input, { tree, deps: { interrupt: interrupts.source } });
    await reached.promise;
    interrupts.fire();
    interrupts.fire(); // repeated interrupts while cancelling are absorbed
    await settle();
    input.push("next", "/usage", "/exit");
    const run = await pending;
    assert.equal(run.code, 0);
    assert.ok(run.err.includes("Request cancelled.\n"));
    assert.equal(provider.calls, 2);
    assert.equal(timeouts(), timersBefore); // the cleanup timer was cleared
    assert.deepEqual(provider.sent(1), ["user: next"]); // the cancelled prompt did not leak
        assert.match(run.out, /no API requests/);
  });

  void it("drops a response that resolved while an interrupt had already won", async () => {
    const interrupts = fakeInterrupts();
    const gate = deferred();
    const reached = deferred();
    const provider = new ScriptedProvider("openai", [deaf(gate.promise, completed("late"), () => { reached.resolve(); })]);
    const input = new ManualInput(["q"]);
    const pending = runChat(["--no-history"], provider, input, { tree, deps: { interrupt: interrupts.source, cleanupTimeoutMs: 1000 } });
    await reached.promise;
    gate.resolve(); // the provider has an answer ...
    interrupts.fire(); // ... but cancellation happens before the chat continues
    input.push("/usage", "/exit");
    const run = await pending;
    assert.ok(run.err.includes("Request cancelled.\n"));
    assert.doesNotMatch(run.out, /late/);
    assert.match(run.out, /no API requests/);
  });

  void it("a provider that ignores the abort ends the chat with 130 and cannot change anything later", async () => {
    const interrupts = fakeInterrupts();
    const gate = deferred();
    const reached = deferred();
    const history = new MemoryHistory();
    const provider = new ScriptedProvider("openai", [deaf(gate.promise, completed("too late"), () => { reached.resolve(); })]);
    const input = new ManualInput(["q", "more"]);
    const pending = runChat([], provider, input, { tree, deps: { interrupt: interrupts.source, cleanupTimeoutMs: 20, createHistoryStore: () => history } });
    await reached.promise;
    interrupts.fire();
    const run = await pending;
    assert.equal(run.code, 130);
    assert.equal(run.err, "neurobrau: interrupted\n");
    const before = run.log.length;
    gate.resolve(); // the late answer arrives after the chat returned
    await settle();
    await settle();
    assert.equal(provider.calls, 1); // "more" was never sent
    assert.deepEqual(history.calls.filter((c) => c.startsWith("save")), []);
    assert.equal(interrupts.active(), 0);
    assert.ok(input.disposed);
    assert.equal(run.log.length, before);
  });

  void it("an interrupt during startup exits 130 before any banner or request", async () => {
    const interrupts = fakeInterrupts();
    const gate = deferred();
    const reached = deferred();
    class SlowStart extends ScriptedProvider {
      override async getCapabilities(model: string, signal: AbortSignal) {
        reached.resolve();
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => { reject(createAbortError()); }, { once: true });
          void gate.promise.then(resolve);
        });
        return super.getCapabilities(model);
      }
    }
    const provider = new SlowStart("openai");
    const input = new ManualInput(["q"]);
    const pending = runChat(["--no-history"], provider, input, { tree, deps: { interrupt: interrupts.source } });
    await reached.promise;
    interrupts.fire();
    const run = await pending;
    assert.equal(run.code, 130);
    assert.equal(run.out, "");
    assert.equal(run.err, "neurobrau: interrupted\n");
    assert.equal(provider.calls, 0);
    assert.equal(interrupts.active(), 0);
    assert.ok(input.disposed);
  });

  void it("an interrupt during persistence waits for the save, keeps the exchange and exits 130", async () => {
    const interrupts = fakeInterrupts();
    const history = new MemoryHistory();
    const saving = deferred();
    const release = deferred();
    history.saveGate = release.promise;
    history.onSave = () => { saving.resolve(); };
    const provider = new ScriptedProvider("openai", [answer("kept"), answer("never")]);
    const input = new ManualInput(["q", "second"]);
    const pending = runChat([], provider, input, { tree, deps: { interrupt: interrupts.source, createHistoryStore: () => history } });
    await saving.promise;
    interrupts.fire();
    await settle();
    assert.equal(history.saved.length, 0); // still writing
    release.resolve();
    const run = await pending;
    assert.equal(run.code, 130);
    assert.equal(history.saved.length, 1);
    assert.deepEqual(history.saved[0]?.messages.map((m) => m.content), ["q", "kept"]);
    assert.match(run.out, /AI > kept\n/);
    assert.ok(!run.err.includes("cancelled"));
    assert.equal(provider.calls, 1); // no new request after the interrupt
  });
});

void describe("plain chat: persistence outcomes", () => {
  void it("a failed save is a warning: the answer is shown and later turns include the exchange", async () => {
    const history = new MemoryHistory();
    history.saveError = ioError();
    const provider = new ScriptedProvider("openai", [answer("one"), answer("two")]);
    const input = new ManualInput(["a"]);
    const prompts = promptWatcher();
    const pending = runChat([], provider, input, { tree, onWrite: prompts.onWrite, deps: { createHistoryStore: () => history } });
    await prompts.reached(2);
    history.saveError = undefined; // storage recovers
    input.push("b");
    input.end();
    const run = await pending;
    assert.equal(run.code, 0);
    assert.match(run.err, /^warning: Could not save conversation history at .*: Permission denied\.\n/);
    assert.deepEqual(provider.sent(1), ["user: a", "assistant: one", "user: b"]);
    assert.deepEqual(history.saved[0]?.messages.map((m) => m.content), ["a", "one", "b", "two"]); // full accumulated state
  });

  void it("saves the conversation before active.json, once per selection", async () => {
    const history = new MemoryHistory();
    const provider = new ScriptedProvider("openai");
    await runChat([], provider, new ManualInput(["a", "b"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.deepEqual(history.calls.filter((c) => c.startsWith("save")), ["save", "saveActive", "save"]);
    assert.deepEqual(history.activeSaved, [{ provider: "openai", model: "default-model" }]);
  });

  void it("a failed active save does not undo the conversation save, and is retried next time", async () => {
    const history = new MemoryHistory();
    history.activeError = ioError("save");
    const provider = new ScriptedProvider("openai");
    const input = new ManualInput(["a"]);
    const prompts = promptWatcher();
    const pending = runChat([], provider, input, { tree, onWrite: prompts.onWrite, deps: { createHistoryStore: () => history } });
    await prompts.reached(2);
    history.activeError = undefined;
    input.push("b");
    input.end();
    const run = await pending;
    assert.equal(history.saved.length, 2);
    assert.equal(history.activeSaved.length, 1);
    assert.equal(run.err.split("warning:").length - 1, 1);
  });

  void it("--no-history never constructs or uses a history store", async () => {
    let built = 0;
    const provider = new ScriptedProvider("openai");
    const run = await runChat(["--no-history"], provider, new ManualInput(["a", "/reset", "/cleanup", "/exit"]), {
      tree,
      deps: { createHistoryStore: () => { built += 1; return new MemoryHistory(); } },
    });
    assert.equal(built, 0);
    assert.match(run.out, /Conversation history cleared\.\n/);
    assert.match(run.out, /Conversation history is disabled for this session \(--no-history\)\.\n/);
  });
});

void describe("plain chat: output failures", () => {
  const epipe = (): Error => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

  void it("exits 141 quietly when stdout is closed at the banner, with no request", async () => {
    const provider = new ScriptedProvider("openai");
    const run = await runChat(["--no-history"], provider, new ManualInput(["q"]), { tree, onWrite: (stream) => { if (stream === "out") throw epipe(); } });
    assert.equal(run.code, 141);
    assert.equal(provider.calls, 0);
    assert.equal(run.err, "");
  });

  void it("exits 141 when the answer cannot be written, after persistence finished", async () => {
    const history = new MemoryHistory();
    const provider = new ScriptedProvider("openai", [answer("hello")]);
    const run = await runChat([], provider, new ManualInput(["q", "second"]), {
      tree,
      deps: { createHistoryStore: () => history },
      onWrite: (stream, text) => { if (stream === "out" && text.startsWith("AI > ")) throw epipe(); },
    });
    assert.equal(run.code, 141);
    assert.equal(history.saved.length, 1);
    assert.equal(provider.calls, 1);
  });

  void it("exits 141 quietly when stderr is closed, without a further request or queued input", async () => {
    const provider = new ScriptedProvider("openai", [failure("down"), answer("never")]);
    const run = await runChat(["--no-history"], provider, new ManualInput(["q1", "q2"]), { tree, onWrite: (stream) => { if (stream === "err") throw epipe(); } });
    assert.equal(run.code, 141);
    assert.equal(provider.calls, 1);
  });

  void it("exits 1 when output fails for another reason", async () => {
    const provider = new ScriptedProvider("openai");
    const run = await runChat(["--no-history"], provider, new ManualInput([]), { tree, onWrite: (stream) => { if (stream === "out") throw new Error("disk full"); } });
    assert.equal(run.code, 1);
    assert.match(run.err, /cannot write output/);
  });
});
