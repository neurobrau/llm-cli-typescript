import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { StreamEvent } from "../src/domain/generation.js";
import { readPackageVersion } from "../src/version.js";
import {
  ControlledStream,
  ManualInput,
  MemoryHistory,
  ScriptedProvider,
  completedEvent,
  failedEvent,
  fakeInterrupts,
  incompleteEvent,
  ioError,
  promptWatcher,
  reasoning,
  runChat,
  streamAnswer,
  streamOf,
  text,
} from "./helpers/chat.js";
import type { ChatRun } from "./helpers/chat.js";
import { deferred } from "./helpers/deferred.js";
import { makeTree } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

const TITLE = `NeuroBräu TypeScript CLI ${readPackageVersion()}`;
const BANNER = `${TITLE}\nProvider: openai | Model: default-model\nType /help for commands, /exit to quit.\n\n`;
const epipe = (): Error => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let tree: Tree;
beforeEach(async () => {
  tree = await makeTree();
});
afterEach(async () => {
  await tree.cleanup();
});

/** Resolves once stdout has received a chunk that satisfies `match` (deterministic gate, no delays). */
function outputWatcher(match: (text: string) => boolean): { readonly onWrite: (stream: "out" | "err", text: string) => void; readonly seen: Promise<void> } {
  const seen = deferred();
  return {
    onWrite: (stream, chunk) => {
      if (stream === "out" && match(chunk)) seen.resolve();
    },
    seen: seen.promise,
  };
}

const oneShot = (extra: readonly string[], provider: ScriptedProvider, options: Parameters<typeof runChat>[3] = {}): Promise<ChatRun> =>
  runChat(["--stream", ...extra, "the prompt"], provider, new ManualInput([], true), { tree, ...options });

void describe("one-shot --stream", () => {
  void it("streams through provider.stream (never generate), touches no storage or input, and prints the answer", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(text("Hel"), text("lo"), completedEvent("Hello")));
    let storageFactories = 0;
    let inputs = 0;
    const run = await oneShot([], provider, {
      deps: {
        createHistoryStore: () => {
          storageFactories += 1;
          return new MemoryHistory();
        },
        createSettingsStore: () => {
          storageFactories += 1;
          throw new Error("settings must not be touched");
        },
        createInput: () => {
          inputs += 1;
          return new ManualInput([], true);
        },
      },
    });
    assert.equal(run.code, 0);
    assert.equal(run.out, "Hello\n");
    assert.equal(run.err, "");
    assert.equal(provider.calls, 0);
    assert.equal(provider.streamCalls, 1);
    assert.equal(storageFactories + inputs, 0);
    assert.deepEqual(provider.sent(0), ["user: the prompt"]);
  });

  void it("shows the first delta before the stream has finished", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    const watcher = outputWatcher((chunk) => chunk === "Hel");
    const pending = oneShot([], provider, { onWrite: watcher.onWrite });
    controlled.push(text("Hel"));
    await watcher.seen; // visible while the provider has not produced anything else
    controlled.push(text("lo"), completedEvent("Hello"));
    const run = await pending;
    assert.deepEqual(run.log, ["out:Hel", "out:lo", "out:\n"]);
    assert.equal(run.code, 0);
  });

  void it("applies backpressure: the next event is not pulled while a write is pending", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    const writing = deferred();
    const release = deferred();
    const pending = oneShot([], provider, {
      onWrite: async (stream, chunk) => {
        if (stream === "out" && chunk === "a") {
          writing.resolve();
          await release.promise;
        }
      },
    });
    controlled.push(text("a"), text("b"), completedEvent("ab"));
    await writing.promise;
    await settle();
    assert.equal(controlled.pulls, 1, "the second pull waits for the writer");
    release.resolve();
    assert.equal((await pending).out, "ab\n");
  });

  void it("never prints reasoning, and an empty completed answer still gets its newline", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(reasoning("secret"), completedEvent("")));
    const run = await oneShot([], provider);
    assert.equal(run.out, "\n");
    assert.ok(!run.log.join("").includes("secret"));
    assert.equal(run.code, 0);
  });

  void it("prints usage and the reported duration after the newline, and nothing without --usage", async () => {
    const provider = new ScriptedProvider("openai");
    const timing = { totalSeconds: 2.5, loadSeconds: 0.5, evalSeconds: 1 };
    provider.pushStream(streamOf(text("x"), completedEvent("x", { inputTokens: 3n, outputTokens: 4n }, timing)));
    const run = await oneShot(["--usage"], provider);
    assert.deepEqual(run.log, ["out:x", "out:\n", "err:Token usage: input=3, output=4\n", "err:Duration: 2.50 s (load 0.50 s, generation 1.00 s)\n"]);
    provider.pushStream(streamOf(text("x"), completedEvent("x", { inputTokens: 3n }, timing)));
    assert.equal((await oneShot([], provider)).err, "");
  });

  void it("does not invent a duration, and reports usage as not reported", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(text("x"), completedEvent("x")));
    const run = await oneShot(["--usage"], provider);
    assert.equal(run.err, "Token usage: not reported\n");
  });

  void it("incomplete: exit 8, partial line ended first, warning and reported usage after it", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(text("part"), incompleteEvent("part", { outputTokens: 9n })));
    const run = await oneShot(["--usage"], provider);
    assert.equal(run.code, 8);
    assert.deepEqual(run.log, [
      "out:part",
      "out:\n",
      "err:neurobrau: warning: response incomplete: the max output token limit was reached.\n",
      "err:Token usage: output=9\n",
    ]);
  });

  void it("failed: the mapped exit code, sanitized message, newline only after shown text", async () => {
    const cases: readonly { kind: Parameters<typeof failedEvent>[2]; code: number }[] = [
      { kind: "api", code: 1 },
      { kind: "missing_api_key", code: 3 },
      { kind: "authentication", code: 4 },
      { kind: "rate_limit", code: 5 },
      { kind: "timeout", code: 6 },
      { kind: "connection", code: 7 },
    ];
    for (const { kind, code } of cases) {
      const withText = new ScriptedProvider("openai");
      withText.pushStream(streamOf(text("so far"), failedEvent("boom", "so far", kind)));
      const run = await oneShot([], withText);
      assert.equal(run.code, code, String(kind));
      assert.deepEqual(run.log, ["out:so far", "out:\n", "err:neurobrau: error: boom\n"]);
      const bare = new ScriptedProvider("openai");
      bare.pushStream(streamOf(failedEvent("boom", "", kind)));
      const none = await oneShot([], bare);
      assert.deepEqual(none.log, ["err:neurobrau: error: boom\n"]);
    }
  });

  void it("synthesizes a failure when the stream ends without a terminal event, or throws a ProviderError", async () => {
    const ended = new ScriptedProvider("openai");
    ended.pushStream(streamOf(text("half")));
    const run = await oneShot([], ended);
    assert.equal(run.code, 1);
    assert.equal(run.out, "half\n");
    assert.equal(run.err, "neurobrau: error: The response stream ended without a result.\n");
    const thrown = new ScriptedProvider("openai");
    thrown.pushStream(() => {
      throw new (class extends Error {})("raw internal detail");
    });
    const bad = await oneShot([], thrown);
    assert.equal(bad.code, 1);
    assert.ok(!bad.log.join("").includes("raw internal detail") || bad.err.startsWith("neurobrau: error:"));
  });

  void it("stops at the first terminal event and never looks at trailing events", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(text("a"), completedEvent("a"), text("late"), failedEvent("late failure")));
    const run = await oneShot([], provider);
    assert.equal(run.out, "a\n");
    assert.equal(run.code, 0);
    assert.equal(provider.streamsOpen, 0);
  });

  void it("Ctrl+C after a partial answer: line ended, interrupted, 130, stream closed, late data ignored", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    const interrupts = fakeInterrupts();
    const watcher = outputWatcher((chunk) => chunk === "par");
    const pending = oneShot([], provider, { onWrite: watcher.onWrite, deps: { interrupt: interrupts.source } });
    controlled.push(text("par"));
    await watcher.seen;
    interrupts.fire();
    const run = await pending;
    assert.equal(run.code, 130);
    assert.deepEqual(run.log, ["out:par", "out:\n", "err:neurobrau: interrupted\n"]);
    assert.ok(controlled.returned);
    assert.equal(provider.streamsOpen, 0);
    assert.equal(interrupts.active(), 0);
  });

  void it("Ctrl+C before any output prints no stdout and exits 130", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    const interrupts = fakeInterrupts();
    const pending = oneShot([], provider, { deps: { interrupt: interrupts.source } });
    while (controlled.pulls === 0) await settle();
    interrupts.fire();
    const run = await pending;
    assert.equal(run.code, 130);
    assert.deepEqual(run.log, ["err:neurobrau: interrupted\n"]);
  });

  void it("a provider that ignores abort and return cannot block the exit or print late output", async () => {
    const provider = new ScriptedProvider("openai");
    const stuck = new ControlledStream({ cooperative: false });
    provider.pushStream(stuck.handler);
    const interrupts = fakeInterrupts();
    const pending = oneShot([], provider, { deps: { interrupt: interrupts.source, cleanupTimeoutMs: 30 } });
    while (stuck.pulls === 0) await settle();
    interrupts.fire();
    const run = await pending;
    assert.equal(run.code, 130);
    stuck.push(text("late"), completedEvent("late"));
    await settle();
    assert.equal(run.out, "");
    assert.equal(provider.streamCalls, 1, "no second request");
  });

  void it("EPIPE on stdout exits 141 quietly, aborts and closes the stream, and tries no newline", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    controlled.push(text("x"), text("y"), completedEvent("xy"));
    const writes: string[] = [];
    const run = await oneShot([], provider, {
      onWrite: (stream, chunk) => {
        if (stream === "out") {
          writes.push(chunk);
          throw epipe();
        }
      },
    });
    assert.equal(run.code, 141);
    assert.equal(run.err, "");
    assert.deepEqual(writes, ["x"]);
    assert.ok(controlled.returned);
    assert.equal(provider.streamsOpen, 0);
  });

  void it("EPIPE on the final newline is quiet as well; other output failures exit 1 with a fixed diagnostic", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(text("x"), completedEvent("x")));
    const quiet = await oneShot([], provider, {
      onWrite: (stream, chunk) => {
        if (stream === "out" && chunk === "\n") throw epipe();
      },
    });
    assert.equal(quiet.code, 141);
    assert.equal(quiet.err, "");
    provider.pushStream(streamOf(text("x"), completedEvent("x")));
    const other = await oneShot([], provider, {
      onWrite: (stream) => {
        if (stream === "out") throw new Error("disk full");
      },
    });
    assert.equal(other.code, 1);
    assert.equal(other.err, "neurobrau: error: cannot write output\n");
    assert.ok(!other.err.includes("disk full"));
  });

  void it("an output failure keeps its exit code even when closing the stream fails too", async () => {
    const provider = new ScriptedProvider("openai");
    const stuck = new ControlledStream({ cooperative: false });
    provider.pushStream(stuck.handler);
    stuck.push(text("x"));
    const run = await oneShot([], provider, {
      deps: { cleanupTimeoutMs: 30 },
      onWrite: (stream) => {
        if (stream === "out") throw epipe();
      },
    });
    assert.equal(run.code, 141);
  });

  void it("the non-streaming path is unchanged", async () => {
    const provider = new ScriptedProvider("openai");
    const run = await runChat(["the prompt"], provider, new ManualInput([], true), { tree });
    assert.equal(run.code, 0);
    assert.equal(provider.calls, 1);
    assert.equal(provider.streamCalls, 0);
    assert.equal(run.out, "reply 1\n");
  });
});

void describe("plain chat --stream", () => {
  const chat = (lines: readonly string[], provider: ScriptedProvider, extra: readonly string[] = [], options: Parameters<typeof runChat>[3] = {}): Promise<ChatRun> =>
    runChat(["--stream", "--no-history", ...extra], provider, new ManualInput(lines, true), { tree, ...options });

  void it("prints AI > once with the first delta, streams the rest and keeps context across turns", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(...streamAnswer("one two", undefined, 2)), streamOf(...streamAnswer("three")));
    const run = await chat(["first", "second", "/exit"], provider);
    assert.equal(run.code, 0);
    assert.equal(run.out, `${BANNER}YOU > AI > one two\nYOU > AI > three\nYOU > Goodbye.\n`);
    assert.ok(run.log.includes("out:AI > one "));
    assert.equal(provider.calls, 0);
    assert.deepEqual(provider.sent(1), ["user: first", "assistant: one two", "user: second"]);
    assert.equal(provider.maxStreamsOpen, 1);
  });

  void it("shows the first delta while the provider has not finished", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    const watcher = outputWatcher((chunk) => chunk === "AI > Hel");
    const pending = chat(["hi"], provider, [], { onWrite: watcher.onWrite });
    controlled.push(text("Hel"));
    await watcher.seen;
    controlled.push(text("lo"), completedEvent("Hello"));
    const run = await pending;
    assert.ok(run.out.includes("AI > Hello\n"));
  });

  void it("an empty completed answer prints the prefix and a line, and is committed like any other", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(completedEvent("")), streamOf(...streamAnswer("b")));
    const run = await chat(["a", "b"], provider);
    assert.ok(run.out.includes("YOU > AI > \nYOU > AI > b\n"));
    assert.deepEqual(provider.sent(1), ["user: a", "assistant: ", "user: b"]);
  });

  void it("keeps reasoning out of output, saved messages and later requests", async () => {
    const provider = new ScriptedProvider("openai");
    const history = new MemoryHistory();
    provider.pushStream(streamOf(reasoning("secret thoughts"), text("visible"), completedEvent("visible")), streamOf(...streamAnswer("b")));
    const run = await runChat(["--stream"], provider, new ManualInput(["one", "two"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.ok(!run.out.includes("secret") && !run.err.includes("secret"));
    assert.deepEqual(provider.sent(1), ["user: one", "assistant: visible", "user: two"]);
    assert.ok(!JSON.stringify(history.saved).includes("secret"));
  });

  void it("commits one pair and at most one usage record per completed turn, then saves once", async () => {
    const provider = new ScriptedProvider("openai");
    const history = new MemoryHistory();
    provider.pushStream(streamOf(text("a"), completedEvent("a", { inputTokens: 5n, outputTokens: 0n })), streamOf(...streamAnswer("b")));
    await runChat(["--stream"], provider, new ManualInput(["q1", "q2"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.equal(history.saved.length, 2);
    const [first, second] = history.saved;
    assert.deepEqual(first?.messages, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a" },
    ]);
    assert.equal(first.requests.length, 1);
    assert.deepEqual(first.requests[0]?.usage, { inputTokens: 5n, outputTokens: 0n });
    assert.equal(second?.messages.length, 4);
    assert.equal(second.requests.length, 1, "a turn without reported usage adds no record");
  });

  void it("failed with shown text keeps the partial visible, says it was not saved, and commits nothing", async () => {
    const provider = new ScriptedProvider("openai");
    const history = new MemoryHistory();
    provider.pushStream(streamOf(text("par"), failedEvent("connection lost", "par", "connection")), streamOf(...streamAnswer("ok")));
    const run = await runChat(["--stream"], provider, new ManualInput(["q1", "q2"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.equal(run.code, 0);
    assert.ok(run.out.includes("YOU > AI > par\nYOU > AI > ok\n"));
    assert.ok(run.err.includes("error: connection lost The partial response was not saved.\n"));
    assert.deepEqual(provider.sent(1), ["user: q2"]);
    assert.equal(history.saved.length, 1);
  });

  void it("failed without text has no suffix and no line break", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(failedEvent("nope")));
    const run = await chat(["q"], provider);
    assert.ok(!run.out.includes("AI > "), "no prefix and no line break for an answer that never started");
    assert.ok(run.err.includes("error: nope\n"));
    assert.ok(!run.err.includes("not saved"));
  });

  void it("incomplete adds no messages but keeps reported usage; a new conversation stays unsaved until a completed turn", async () => {
    const provider = new ScriptedProvider("openai");
    const history = new MemoryHistory();
    provider.pushStream(
      streamOf(text("par"), incompleteEvent("par", { outputTokens: 7n })),
      streamOf(incompleteEvent("", { outputTokens: 1n })),
      streamOf(...streamAnswer("ok", { inputTokens: 2n })),
      streamOf(text("p"), incompleteEvent("p", { outputTokens: 3n })),
    );
    const run = await runChat(["--stream"], provider, new ManualInput(["a", "b", "c", "d"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.ok(run.err.includes("warning: Response incomplete: the max output token limit was reached. The partial response was not saved.\n"));
    assert.ok(run.err.includes("warning: Response incomplete: the max output token limit was reached.\n"));
    assert.deepEqual(provider.sent(2), ["user: c"], "incomplete answers and prompts are not context");
    assert.deepEqual(provider.sent(3), ["user: c", "assistant: ok", "user: d"]);
    // Nothing was saved until the completed turn; then the earlier usage came along; the last incomplete adds its record.
    assert.equal(history.saved.length, 2);
    assert.deepEqual(history.saved[0]?.requests.map((r) => r.status), ["incomplete", "incomplete", "completed"]);
    assert.deepEqual(history.saved[1]?.requests.map((r) => r.status), ["incomplete", "incomplete", "completed", "incomplete"]);
    assert.equal(history.saved[1].messages.length, 2);
  });

  void it("--usage prints usage after a completed streamed turn", async () => {
    const provider = new ScriptedProvider("openai");
    provider.pushStream(streamOf(text("x"), completedEvent("x", { inputTokens: 1n, outputTokens: 2n }, { totalSeconds: 1 })));
    const run = await chat(["q"], provider, ["--usage"]);
    assert.ok(run.err.includes("Token usage: input=1, output=2\nDuration: 1.00 s\n"));
  });

  void it("Ctrl+C mid-answer: partial line closed, notice with the suffix, the same chat then works", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler, streamOf(...streamAnswer("fresh")));
    const interrupts = fakeInterrupts();
    const history = new MemoryHistory();
    const watcher = outputWatcher((chunk) => chunk === "AI > par");
    const input = new ManualInput(["slow"]);
    const pending = runChat(["--stream"], provider, input, { tree, onWrite: watcher.onWrite, deps: { interrupt: interrupts.source, createHistoryStore: () => history } });
    controlled.push(text("par"));
    await watcher.seen;
    interrupts.fire();
    interrupts.fire(); // repeats while cancelling are absorbed
    await settle();
    input.push("next", "/usage", "/exit");
    const run = await pending;
    assert.equal(run.code, 0);
    assert.ok(run.err.includes("\nRequest cancelled. The partial response was not saved.\n"));
    assert.ok(run.out.includes("AI > par\nYOU > "));
    assert.deepEqual(provider.sent(1), ["user: next"], "the cancelled prompt did not leak");
    assert.equal(provider.maxStreamsOpen, 1, "requests never overlap");
    assert.ok(controlled.returned);
    assert.equal(history.saved.length, 1);
    assert.deepEqual(history.saved[0]?.messages, [
      { role: "user", content: "next" },
      { role: "assistant", content: "fresh" },
    ]);
  });

  void it("Ctrl+C before any text has no partial suffix", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    const interrupts = fakeInterrupts();
    const input = new ManualInput(["slow"]);
    const pending = runChat(["--stream", "--no-history"], provider, input, { tree, deps: { interrupt: interrupts.source } });
    while (controlled.pulls === 0) await settle();
    interrupts.fire();
    await settle();
    input.end();
    const run = await pending;
    assert.ok(run.err.includes("\nRequest cancelled.\n"));
    assert.ok(!run.err.includes("not saved"));
    assert.ok(!run.out.includes("AI > "));
  });

  void it("a response completing together with Ctrl+C is discarded and never saved", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    const interrupts = fakeInterrupts();
    const history = new MemoryHistory();
    const input = new ManualInput(["q"]);
    const pending = runChat(["--stream"], provider, input, { tree, deps: { interrupt: interrupts.source, createHistoryStore: () => history } });
    while (controlled.pulls === 0) await settle();
    controlled.push(text("late"), completedEvent("late"));
    interrupts.fire(); // cancellation wins before the chat looks at the event
    input.push("/usage", "/exit");
    const run = await pending;
    assert.ok(run.err.includes("Request cancelled."));
    assert.deepEqual(history.calls.filter((call) => call === "save"), []);
    assert.match(run.out, /no API requests/);
  });

  void it("an interrupt that lands while a finished stream is being closed still wins over the commit", async () => {
    const provider = new ScriptedProvider("openai");
    const closing = deferred();
    const release = deferred();
    provider.pushStream(() => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => {
        let step = 0;
        return {
          next: () => {
            step += 1;
            return Promise.resolve(step === 1 ? { done: false, value: text("answer") } : { done: false, value: completedEvent("answer") });
          },
          return: async () => {
            closing.resolve();
            await release.promise;
            return { done: true, value: undefined };
          },
        };
      },
    }));
    const interrupts = fakeInterrupts();
    const history = new MemoryHistory();
    const input = new ManualInput(["q"]);
    const pending = runChat(["--stream"], provider, input, { tree, deps: { interrupt: interrupts.source, createHistoryStore: () => history } });
    await closing.promise; // the terminal event was received; cleanup is pending
    interrupts.fire();
    release.resolve();
    input.push("/usage", "/exit");
    const run = await pending;
    assert.ok(run.err.includes("Request cancelled. The partial response was not saved.\n"));
    assert.deepEqual(history.calls.filter((call) => call === "save"), []);
    assert.match(run.out, /no API requests/);
  });

  void it("a stream that ignores abort and return ends the chat with 130, with no late output, save or second request", async () => {
    const provider = new ScriptedProvider("openai");
    const stuck = new ControlledStream({ cooperative: false });
    provider.pushStream(stuck.handler);
    const interrupts = fakeInterrupts();
    const history = new MemoryHistory();
    const input = new ManualInput(["q", "next"]);
    const pending = runChat(["--stream"], provider, input, { tree, deps: { interrupt: interrupts.source, cleanupTimeoutMs: 30, createHistoryStore: () => history } });
    while (stuck.pulls === 0) await settle();
    interrupts.fire();
    const run = await pending;
    assert.equal(run.code, 130);
    stuck.push(text("late"), completedEvent("late"));
    await settle();
    assert.ok(!run.out.includes("late"));
    assert.equal(history.calls.filter((call) => call === "save").length, 0);
    assert.equal(provider.streamCalls, 1);
    assert.equal(interrupts.active(), 0);
  });

  void it("an output failure before the terminal commits nothing, even if the provider would have completed", async () => {
    const provider = new ScriptedProvider("openai");
    const history = new MemoryHistory();
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    controlled.push(text("a"), completedEvent("a"));
    const run = await runChat(["--stream"], provider, new ManualInput(["q", "next"]), {
      tree,
      deps: { createHistoryStore: () => history },
      onWrite: (stream, chunk) => {
        if (stream === "out" && chunk.startsWith("AI > ")) throw epipe();
      },
    });
    assert.equal(run.code, 141);
    assert.equal(run.err, "");
    assert.deepEqual(history.calls.filter((call) => call !== "loadActive" && call !== "loadLatest"), []);
    assert.equal(provider.streamCalls, 1, "no queued next turn");
    assert.equal(provider.streamsOpen, 0);
  });

  void it("once completion was accepted, persistence finishes even if the final newline fails", async () => {
    const provider = new ScriptedProvider("openai");
    const history = new MemoryHistory();
    provider.pushStream(streamOf(text("a"), completedEvent("a", { inputTokens: 1n })));
    const run = await runChat(["--stream"], provider, new ManualInput(["q", "next"]), {
      tree,
      deps: { createHistoryStore: () => history },
      onWrite: (stream, chunk) => {
        if (stream === "out" && chunk === "\n") throw epipe();
      },
    });
    assert.equal(run.code, 141);
    assert.equal(history.saved.length, 1);
    assert.equal(history.saved[0]?.messages.length, 2);
    assert.equal(provider.streamCalls, 1);
  });

  void it("Ctrl+C during persistence of an accepted answer exits 130 only after the save finished", async () => {
    const provider = new ScriptedProvider("openai");
    const history = new MemoryHistory();
    const gate = deferred();
    history.saveGate = gate.promise;
    const saving = deferred();
    history.onSave = () => {
      saving.resolve();
    };
    provider.pushStream(streamOf(text("a"), completedEvent("a")));
    const interrupts = fakeInterrupts();
    const pending = runChat(["--stream"], provider, new ManualInput(["q"]), { tree, deps: { interrupt: interrupts.source, createHistoryStore: () => history } });
    await saving.promise;
    interrupts.fire();
    await settle();
    assert.equal(history.saved.length, 0, "still saving");
    gate.resolve();
    const run = await pending;
    assert.equal(run.code, 130);
    assert.equal(history.saved.length, 1);
  });

  void it("a save error is a warning; the exchange stays in memory", async () => {
    const provider = new ScriptedProvider("openai");
    const history = new MemoryHistory();
    history.saveError = ioError("save");
    provider.pushStream(streamOf(...streamAnswer("a")), streamOf(...streamAnswer("b")));
    const run = await runChat(["--stream"], provider, new ManualInput(["q1", "q2"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.equal(run.code, 0);
    assert.match(run.err, /^warning: /m);
    assert.deepEqual(provider.sent(1), ["user: q1", "assistant: a", "user: q2"]);
  });

  void it("lines typed while streaming wait and are processed in order, commands included", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler, streamOf(...streamAnswer("second")));
    const input = new ManualInput(["first"]);
    const watcher = outputWatcher((chunk) => chunk === "AI > x");
    const pending = runChat(["--stream", "--no-history"], provider, input, { tree, onWrite: watcher.onWrite });
    controlled.push(text("x"));
    await watcher.seen;
    input.push("/usage", "again", "/exit"); // arrives while the answer is still streaming
    controlled.push(completedEvent("x"));
    const run = await pending;
    assert.equal(run.code, 0);
    assert.equal(provider.streamCalls, 2);
    assert.deepEqual(provider.sent(1), ["user: first", "assistant: x", "user: again"]);
    assert.ok(run.out.indexOf("no API requests") < run.out.indexOf("AI > second"));
  });

  void it("--no-history never constructs a history store while streaming", async () => {
    const provider = new ScriptedProvider("openai");
    let built = 0;
    await chat(["q"], provider, [], {
      deps: {
        createHistoryStore: () => {
          built += 1;
          return new MemoryHistory();
        },
      },
    });
    assert.equal(built, 0);
  });

  void it("idle Ctrl+C still exits 130", async () => {
    const interrupts = fakeInterrupts();
    const prompts = promptWatcher();
    const provider = new ScriptedProvider("openai");
    const pending = runChat(["--stream", "--no-history"], provider, new ManualInput(), { tree, onWrite: prompts.onWrite, deps: { interrupt: interrupts.source } });
    await prompts.reached(1);
    interrupts.fire();
    assert.equal((await pending).code, 130);
  });
});
