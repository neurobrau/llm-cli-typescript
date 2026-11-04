import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STREAM_UNCLOSED } from "../src/application/stream-consumer.js";
import { createAbortError } from "../src/domain/errors.js";
import type { StreamEvent } from "../src/domain/generation.js";
import { ControlledStream, MemoryHistory, ScriptedProvider, answer, completed, completedEvent, deaf, gated, streamOf, text } from "./helpers/chat.js";
import { deferred } from "./helpers/deferred.js";
import { KEYS, startTui, until, settleAll } from "./helpers/tui.js";
import type { TuiSession } from "./helpers/tui.js";

const epipe = (): Error => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

async function submit(session: TuiSession, line: string): Promise<void> {
  await session.type(line);
  await session.key(KEYS.enter);
}

/** Ends the session through Ctrl+D (the draft must be empty) and returns the exit code. */
async function quit(session: TuiSession): Promise<number> {
  await session.key(KEYS.ctrlD);
  return (await session.result).code;
}

function assertCleanExit(session: TuiSession): void {
  assert.equal(session.term.closeCount >= 1, true);
  assert.equal(session.term.log.filter((entry) => entry === "close").length, 1, "restored exactly once");
  assert.ok(!session.term.log.includes("draw-after-close"), "no frame after the terminal was restored");
  assert.equal(session.signals.active, 0, "signal listeners removed");
  assert.equal(session.timers.pending, 0, "timers cancelled");
}

void describe("fullscreen: cancellation (Ctrl+C during a request)", () => {
  void it("before the first text: Cancelled., CANCELLED, nothing committed, and the next request works", async () => {
    const provider = new ScriptedProvider("ollama");
    const first = new ControlledStream();
    provider.pushStream(first.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    await submit(session, "slow");
    await until(() => first.pulls > 0, "first pull");
    await session.key(KEYS.ctrlC);
    await until(() => first.returned, "stream closed");
    assert.equal(session.term.status(), "CANCELLED");
    assert.ok(session.term.conversation().some((line) => line === "Cancelled."));
    first.push(text("LATE"), completedEvent("LATE"));
    await settleAll();
    assert.ok(!session.term.text().includes("LATE"));
    assert.equal(session.history.saved.length, 0);
    await submit(session, "again");
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.deepEqual(provider.sent(1), ["user: again"]);
    assert.equal(provider.maxStreamsOpen, 1);
    assert.equal(await quit(session), 0);
    assertCleanExit(session);
  });

  void it("mid-answer: the partial text stays visible, is never sent or saved, and the notice says so", async () => {
    const provider = new ScriptedProvider("ollama");
    const first = new ControlledStream();
    provider.pushStream(first.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    await submit(session, "story");
    first.push(text("Once upon"));
    await until(() => session.term.flat().includes("AI > Once upon"), "partial");
    await session.key(KEYS.ctrlC);
    await until(() => first.returned, "closed");
    assert.equal(session.term.status(), "CANCELLED | Partial response not saved");
    assert.ok(session.term.flat().includes("Cancelled. The partial answer above was not saved."));
    assert.ok(session.term.flat().includes("AI > Once upon"));
    first.push(text(" a time"), completedEvent("Once upon a time"));
    await settleAll();
    assert.ok(!session.term.flat().includes("a time"));
    await submit(session, "next");
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.deepEqual(provider.sent(1), ["user: next"]); // neither the cancelled prompt nor its partial answer
    assert.deepEqual(session.history.saved.at(-1)?.messages.map((m) => m.content), ["next", "stream reply 2"]);
    assert.equal(await quit(session), 0);
  });

  void it("a new request is refused while the cancelled one is still closing, with the draft kept", async () => {
    const provider = new ScriptedProvider("ollama");
    const closing = deferred();
    provider.pushStream((_request, signal) => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () =>
          new Promise<IteratorResult<StreamEvent>>((_resolve, reject) => {
            signal.addEventListener("abort", () => { reject(createAbortError()); }, { once: true });
          }),
        return: async () => {
          await closing.promise;
          return { done: true, value: undefined };
        },
      }),
    }));
    const session = await startTui({ provider, argv: ["--stream"], deps: { cleanupTimeoutMs: 10_000 } });
    await submit(session, "q");
    await session.key(KEYS.ctrlC);
    assert.equal(session.term.status().split(" | ")[0], "CANCELLED");
    await session.type("second");
    await session.key(KEYS.enter);
    assert.equal(session.term.status(), "WARNING | The cancelled response is still closing; try again shortly");
    assert.ok(session.term.inputLine().includes("YOU > second"));
    assert.equal(provider.streamCalls, 1);
    closing.resolve();
    await settleAll();
    await session.key(KEYS.enter);
    await until(() => provider.streamCalls === 2, "second request after the close");
    assert.equal(provider.maxStreamsOpen, 1);
    assert.equal(await quit(session), 0);
  });

  void it("a stream that ignores abort and return ends the program with 130, restored, with no late output or second request", async () => {
    const provider = new ScriptedProvider("ollama");
    const stuck = new ControlledStream({ cooperative: false });
    provider.pushStream(stuck.handler);
    const session = await startTui({ provider, argv: ["--stream"], deps: { cleanupTimeoutMs: 20 } });
    await submit(session, "q");
    await until(() => stuck.pulls > 0, "pull");
    await session.key(KEYS.ctrlC);
    // The bound is real time inside consumeStream; timers here are manual, so wait for the result.
    const done = await session.result;
    assert.equal(done.code, 130);
    stuck.push(text("late"), completedEvent("late"));
    await settleAll();
    assert.ok(!session.term.text().includes("late"));
    assert.equal(provider.streamCalls, 1);
    assert.equal(session.history.saved.length, 0);
    assertCleanExit(session);
  });

  void it("non-streaming: cancel retires the request; a late result is neither shown nor committed", async () => {
    const provider = new ScriptedProvider("ollama");
    const gate = deferred();
    provider.push(gated(gate.promise, completed("never shown")));
    const session = await startTui({ provider });
    await submit(session, "q");
    await until(() => provider.inFlight === 1, "request in flight");
    await session.key(KEYS.ctrlC);
    await until(() => provider.inFlight === 0, "request settled");
    assert.equal(session.term.status(), "CANCELLED");
    assert.ok(session.term.flat().includes("Request cancelled."));
    gate.resolve();
    await settleAll();
    assert.ok(!session.term.text().includes("never shown"));
    assert.equal(session.history.saved.length, 0);
    await submit(session, "again");
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.deepEqual(provider.sent(1), ["user: again"]);
    assert.equal(await quit(session), 0);
  });

  void it("non-streaming: a provider that ignores abort exits with 130, never overlapping", async () => {
    const provider = new ScriptedProvider("ollama");
    const gate = deferred();
    provider.push(deaf(gate.promise, completed("late")));
    const session = await startTui({ provider, deps: { cleanupTimeoutMs: 20 } });
    await submit(session, "q");
    await until(() => provider.inFlight === 1, "in flight");
    await session.key(KEYS.ctrlC);
    session.timers.advance(50); // the non-streaming cleanup bound runs on the injected timers
    assert.equal((await session.result).code, 130);
    gate.resolve();
    await settleAll();
    assert.equal(provider.calls, 1);
    assert.equal(session.history.saved.length, 0);
    assertCleanExit(session);
  });

  void it("race: Ctrl+C after the terminal event but before the stream finished closing wins - nothing is committed", async () => {
    const provider = new ScriptedProvider("ollama");
    const closing = deferred();
    const delivered = deferred();
    provider.pushStream(() => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () => {
          delivered.resolve();
          return Promise.resolve({ done: false, value: completedEvent("done text") });
        },
        return: async () => {
          await closing.promise;
          return { done: true, value: undefined };
        },
      }),
    }));
    const session = await startTui({ provider, argv: ["--stream"], deps: { cleanupTimeoutMs: 10_000 } });
    await submit(session, "q");
    await delivered.promise;
    await settleAll();
    await session.key(KEYS.ctrlC);
    closing.resolve();
    await until(() => session.term.status().split(" | ")[0] === "CANCELLED", "CANCELLED");
    await settleAll();
    assert.equal(session.history.saved.length, 0);
    assert.ok(!session.term.text().includes("done text"));
    await submit(session, "next");
    await until(() => provider.streamCalls === 2, "next request");
    assert.deepEqual(provider.sent(1), ["user: next"]);
    assert.equal(await quit(session), 0);
  });

  void it("Ctrl+C during the save finishes the committed save, then exits 130; it is not an unsaved cancelled response", async () => {
    const provider = new ScriptedProvider("ollama", [answer("kept")]);
    const history = new MemoryHistory();
    const gate = deferred();
    history.saveGate = gate.promise;
    const session = await startTui({ provider, history });
    await submit(session, "q");
    await until(() => history.calls.includes("save"), "save started");
    await session.key(KEYS.ctrlC);
    await session.key(KEYS.ctrlC); // repeated interrupts are absorbed
    await settleAll();
    assert.equal(history.saved.length, 0); // the save is still gated
    gate.resolve();
    const done = await session.result;
    assert.equal(done.code, 130);
    assert.deepEqual(history.saved.map((c) => c.messages.map((m) => m.content)), [["q", "kept"]]);
    assert.equal(history.calls.filter((call) => call === "save").length, 1);
    assertCleanExit(session);
  });

  void it("an external SIGINT follows the same rules as the key: it cancels a request, and exits when idle", async () => {
    const provider = new ScriptedProvider("ollama");
    const first = new ControlledStream();
    provider.pushStream(first.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    await submit(session, "q");
    await until(() => first.pulls > 0, "pull");
    session.signals.fire("SIGINT");
    await until(() => first.returned, "closed");
    assert.equal(session.term.status().split(" | ")[0], "CANCELLED");
    session.signals.fire("SIGINT");
    assert.equal((await session.result).code, 130);
    assertCleanExit(session);
    assert.equal(session.signals.registrations, 1, "one handler, not two competing ones");
  });
});

void describe("fullscreen: Task 007 close semantics are kept", () => {
  void it("a terminal event whose close never settles is a failure: exit 1, fixed diagnostic, nothing committed, no second request", async () => {
    const provider = new ScriptedProvider("ollama");
    provider.pushStream(() => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () => Promise.resolve({ done: false, value: completedEvent("answer") }),
        return: () => new Promise<IteratorResult<StreamEvent>>(() => undefined),
      }),
    }));
    const session = await startTui({ provider, argv: ["--stream"], deps: { cleanupTimeoutMs: 20 } });
    await submit(session, "q");
    const done = await session.result;
    assert.equal(done.code, 1);
    assert.ok(done.err.endsWith(`neurobrau: error: ${STREAM_UNCLOSED}\n`), done.err);
    assert.equal(session.history.saved.length, 0);
    assert.equal(provider.streamCalls, 1);
    assertCleanExit(session);
  });

  void it("a synchronous throw from next() is closed through the guarded path and ends with the safe internal error", async () => {
    const provider = new ScriptedProvider("ollama");
    let returned = 0;
    provider.pushStream(() => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () => {
          throw new Error("secret internal detail");
        },
        return: () => {
          returned += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    }));
    const session = await startTui({ provider, argv: ["--stream"] });
    await submit(session, "q");
    const done = await session.result;
    assert.equal(done.code, 1);
    assert.equal(done.err, "neurobrau: error: an internal error occurred\n");
    assert.ok(!done.err.includes("secret"));
    assert.equal(returned, 1);
    assertCleanExit(session);
  });

  void it("an output (draw) failure before the terminal event commits nothing and restores the terminal", async () => {
    const provider = new ScriptedProvider("ollama");
    const stream = new ControlledStream();
    provider.pushStream(stream.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    await submit(session, "q");
    session.term.drawError = epipe();
    stream.push(text("a"));
    const done = await session.result;
    // Even if the provider completes now, the interface already ended and nothing is committed.
    stream.push(completedEvent("a"));
    await settleAll();
    assert.equal(done.code, 141);
    assert.equal(done.err, "");
    assert.equal(session.history.saved.length, 0);
    assert.equal(stream.returned, true);
    assertCleanExit(session);
  });

  void it("a draw failure other than EPIPE exits 1 with a fixed diagnostic", async () => {
    const provider = new ScriptedProvider("ollama", [answer("x")]);
    const session = await startTui({ provider });
    session.term.drawError = new Error("disk exploded with secrets");
    await session.type("a");
    const done = await session.result;
    assert.equal(done.code, 1);
    assert.equal(done.err, "neurobrau: error: cannot write output\n");
    assertCleanExit(session);
  });
});

void describe("fullscreen: responsiveness and ownership while a request runs", () => {
  void it("typing, editing, scrolling, help, usage and resize work; Enter refuses with the draft kept; the warning expires", async () => {
    const provider = new ScriptedProvider("ollama");
    const stream = new ControlledStream();
    provider.pushStream(stream.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    await submit(session, "q");
    await session.type("draft ü");
    await session.key(KEYS.left);
    await session.key(KEYS.backspace); // removes the space before the cursor
    assert.ok(session.term.inputLine().includes("YOU > draftü"));
    await session.key(KEYS.enter);
    assert.equal(session.term.status(), "WARNING | A response is being generated; wait or press Ctrl+C");
    assert.ok(session.term.inputLine().includes("YOU > draftü"));
    assert.equal(provider.streamCalls, 1);
    session.timers.advance(2100);
    await settleAll();
    assert.match(session.term.status(), /^CONNECTING/);
    session.term.resize(30, 100);
    await settleAll();
    assert.equal(session.term.lines().length, 30);
    assert.ok(session.term.inputLine().includes("YOU > draftü"));
    await session.key(KEYS.f1); // help works and keeps the draft
    assert.ok(session.term.flat().includes("Commands:"));
    assert.ok(session.term.inputLine().includes("draftü"));
    await session.key(KEYS.ctrlU);
    await session.type("/usage");
    await session.key(KEYS.enter);
    assert.ok(session.term.flat().includes("Token usage: no API requests in this conversation yet."));
    await session.key(KEYS.f3);
    assert.equal(session.term.status(), "WARNING | Settings cannot change while a response is generated");
    await session.key(KEYS.ctrlD); // does nothing during a request
    assert.equal(provider.streamCalls, 1);
    session.timers.advance(2100); // the flash ends
    stream.push(text("ok"), completedEvent("ok"));
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.equal(await quit(session), 0);
  });

  void it("/exit during a request cancels it, closes the stream and exits 0 with nothing committed", async () => {
    const provider = new ScriptedProvider("ollama");
    const stream = new ControlledStream();
    provider.pushStream(stream.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    await submit(session, "q");
    await until(() => stream.pulls > 0, "pull");
    await submit(session, "/exit");
    const done = await session.result;
    assert.equal(done.code, 0);
    assert.equal(stream.returned, true);
    assert.equal(session.history.saved.length, 0);
    assertCleanExit(session);
  });

  void it("/reset and /cleanup cannot run while a request or a save is in progress", async () => {
    const provider = new ScriptedProvider("ollama", [answer("a")]);
    const history = new MemoryHistory();
    const gate = deferred();
    history.saveGate = gate.promise;
    history.files = 3;
    const session = await startTui({ provider, history });
    await submit(session, "q");
    await until(() => history.calls.includes("save"), "saving");
    await submit(session, "/reset");
    assert.equal(session.term.status(), "WARNING | Please wait; the conversation is being updated");
    assert.ok(session.term.inputLine().includes("/reset"));
    assert.ok(!history.calls.includes("count"));
    session.timers.advance(2100); // the warning flash ends
    gate.resolve();
    await until(() => history.saved.length === 1, "the save finished");
    await settleAll();
    await session.key(KEYS.enter); // now idle: the retained draft is accepted
    await settleAll();
    assert.ok(session.term.flat().includes("Started a new conversation."));
    assert.equal(await quit(session), 0);
  });

  void it("output backpressure: with a stalled terminal the consumer stops pulling after at most 256 events and nothing queues", async () => {
    const provider = new ScriptedProvider("ollama");
    const stream = new ControlledStream();
    provider.pushStream(stream.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    const stall = deferred();
    session.term.drawGate = stall.promise;
    const before = session.term.drawsStarted;
    await submit(session, "go");
    stream.push(...Array.from({ length: 2000 }, () => text("w ")));
    await settleAll(40);
    assert.ok(stream.pulls >= 256 && stream.pulls <= 258, `pulled ${String(stream.pulls)} events while the output was stalled`);
    assert.ok(session.term.drawsStarted - before <= 2, `at most one frame in flight, saw ${String(session.term.drawsStarted - before)}`);
    assert.equal(session.history.saved.length, 0, "not finished while the output is stalled");
    stall.resolve();
    await until(() => stream.pulls > 1500, "the consumer resumes");
    stream.push(completedEvent("w ".repeat(2000)));
    await until(() => session.history.saved.length === 1, "saved");
    assert.equal(session.history.saved.at(-1)?.messages[1]?.content, "w ".repeat(2000));
    await settleAll();
    assert.equal(await quit(session), 0);
  });

  void it("redraws are coalesced: many fast events produce far fewer frames", async () => {
    const provider = new ScriptedProvider("ollama");
    provider.pushStream(streamOf(...Array.from({ length: 400 }, () => text("word ")), completedEvent("word ".repeat(400))));
    const session = await startTui({ provider, argv: ["--stream"] });
    const before = session.term.frames.length;
    await submit(session, "many");
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.ok(session.term.frames.length - before < 100, `frames: ${String(session.term.frames.length - before)}`);
    assert.equal(await quit(session), 0);
  });
});

void describe("fullscreen: scrolling", () => {
  const long = (count: number): StreamEvent[] => Array.from({ length: count }, (_, i) => text(`word${String(i)} `));

  void it("follows new text at the bottom and keeps a scrolled-up view anchored across chunks", async () => {
    const provider = new ScriptedProvider("ollama");
    const stream = new ControlledStream();
    provider.pushStream(stream.handler);
    const session = await startTui({ provider, argv: ["--stream"] });
    await submit(session, "long");
    stream.push(...long(150));
    await until(() => session.term.flat().includes("word149"), "first batch");
    assert.ok(!session.term.flat().includes("word0 "));
    await session.key(KEYS.pageUp);
    const before = session.term.conversation().join("\n");
    assert.match(session.term.lines()[0] ?? "", /scrolled up \d+ \(PgDn\)/u);
    stream.push(...long(300).slice(150));
    await settleAll(30);
    assert.equal(session.term.conversation().join("\n"), before, "the visible lines did not move");
    for (let i = 0; i < 40; i += 1) await session.key(KEYS.pageDown);
    assert.ok(session.term.flat().includes("word299"));
    assert.ok(!(session.term.lines()[0] ?? "").includes("scrolled"));
    stream.push(completedEvent(long(300).map((e) => (e.kind === "text" ? e.text : "")).join("")));
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    assert.equal(await quit(session), 0);
  });

  void it("Up/Down move one line, clamp at both ends, and a submission returns to the bottom", async () => {
    const provider = new ScriptedProvider("ollama", [answer("line\n".repeat(40)), answer("short")]);
    const session = await startTui({ provider });
    await submit(session, "first");
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    await session.key(KEYS.up);
    assert.match(session.term.lines()[0] ?? "", /scrolled up 1 \(PgDn\)/u);
    await session.key(KEYS.down);
    await session.key(KEYS.down);
    assert.ok(!(session.term.lines()[0] ?? "").includes("scrolled"));
    for (let i = 0; i < 6; i += 1) await session.key(KEYS.pageUp);
    const top = /scrolled up (\d+)/u.exec(session.term.lines()[0] ?? "");
    assert.ok(top !== null);
    await session.key(KEYS.pageUp);
    assert.equal(/scrolled up (\d+)/u.exec(session.term.lines()[0] ?? "")?.[1], top[1]); // clamped at the oldest line
    await submit(session, "second");
    await until(() => provider.calls === 2, "second");
    await until(() => session.term.flat().includes("short"), "answer");
    assert.ok(!(session.term.lines()[0] ?? "").includes("scrolled"));
    assert.equal(await quit(session), 0);
  });

  void it("a resize re-clamps the offset without losing entries or the draft", async () => {
    const provider = new ScriptedProvider("ollama", [answer("word ".repeat(300))]);
    const session = await startTui({ provider });
    await submit(session, "q");
    await until(() => session.term.status().startsWith("DONE"), "DONE");
    await session.type("my draft");
    for (let i = 0; i < 5; i += 1) await session.key(KEYS.pageUp);
    assert.match(session.term.lines()[0] ?? "", /scrolled up \d+/u);
    session.term.resize(60, 200); // everything fits: the offset is clamped back to the bottom
    await settleAll();
    assert.ok(!(session.term.lines()[0] ?? "").includes("scrolled"));
    assert.ok(session.term.flat().includes("YOU > q") && session.term.flat().includes("AI > word"));
    session.term.resize(12, 40); // much less room: the whole transcript stays reachable
    await settleAll();
    for (let i = 0; i < 200; i += 1) await session.key(KEYS.pageUp);
    assert.ok(session.term.flat().includes("YOU > q"), "the oldest entry is reachable");
    assert.ok(session.term.inputLine().includes("YOU > my draft"));
    await session.key(KEYS.ctrlU);
    assert.equal(await quit(session), 0);
  });
});
