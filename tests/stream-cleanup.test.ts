import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { STREAM_UNCLOSED, consumeStream } from "../src/application/stream-consumer.js";
import type { StreamEvent } from "../src/domain/generation.js";
import { ProviderError } from "../src/domain/errors.js";
import {
  ControlledStream,
  ManualInput,
  MemoryHistory,
  ScriptedProvider,
  completedEvent,
  fakeInterrupts,
  runChat,
  text,
} from "./helpers/chat.js";
import { makeTree } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const epipe = (): Error => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
const never = (): Promise<IteratorResult<StreamEvent>> => new Promise(() => undefined);

/** An iterator whose `return()` never settles; counts calls. */
function hanging(events: readonly StreamEvent[]): { readonly iterable: (signal: AbortSignal) => AsyncIterable<StreamEvent>; readonly calls: { next: number; ret: number; aborted: boolean } } {
  const calls = { next: 0, ret: 0, aborted: false };
  const queue = [...events];
  return {
    calls,
    iterable: (signal) => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () => {
          calls.next += 1;
          const event = queue.shift();
          return Promise.resolve(event === undefined ? { done: true, value: undefined } : { done: false, value: event });
        },
        return: () => {
          calls.ret += 1;
          calls.aborted = signal.aborted;
          return never();
        },
      }),
    }),
  };
}

void describe("consumeStream cleanup bound", () => {
  void it("a terminal event with a hanging return() is unclosed, closed once, after aborting the request", async () => {
    const stream = hanging([text("a"), completedEvent("a")]);
    const seen: string[] = [];
    const result = await consumeStream(stream.iterable, new AbortController().signal, (t) => {
      seen.push(t);
      return Promise.resolve();
    }, 20);
    assert.equal(result.end.kind, "unclosed");
    assert.deepEqual(seen, ["a"]);
    assert.equal(stream.calls.ret, 1);
    assert.equal(stream.calls.aborted, true);
  });

  void it("a failed stream and an early end with a hanging return() are unclosed too", async () => {
    const early = hanging([]);
    assert.equal((await consumeStream(early.iterable, new AbortController().signal, () => Promise.resolve(), 20)).end.kind, "unclosed");
    assert.equal(early.calls.ret, 1);
  });

  void it("caller cancellation during a hanging close stays stuck, not unclosed", async () => {
    const parent = new AbortController();
    const stream = hanging([completedEvent("a")]);
    const pending = consumeStream(stream.iterable, parent.signal, () => Promise.resolve(), 20);
    await settle();
    parent.abort();
    assert.equal((await pending).end.kind, "stuck");
    assert.equal(stream.calls.ret, 1);
  });

  void it("an output failure keeps its original error when closing hangs", async () => {
    const stream = hanging([text("a"), completedEvent("a")]);
    const failure = epipe();
    const result = await consumeStream(stream.iterable, new AbortController().signal, () => Promise.reject(failure), 20);
    assert.ok(result.end.kind === "output-error");
    assert.equal(result.end.error, failure);
    assert.equal(stream.calls.ret, 1);
  });

  void it("a synchronous throw of next() aborts and closes the iterator once, and is rethrown", async () => {
    const boom = new Error("sync next");
    const calls = { ret: 0, aborted: false };
    const open = (signal: AbortSignal): AsyncIterable<StreamEvent> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () => {
          throw boom;
        },
        return: () => {
          calls.ret += 1;
          calls.aborted = signal.aborted;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    });
    await assert.rejects(consumeStream(open, new AbortController().signal, () => Promise.resolve(), 20), (error: unknown) => error === boom);
    assert.deepEqual(calls, { ret: 1, aborted: true });
  });

  void it("a synchronous ProviderError from next() is a failed terminal; a hanging return() cannot hide an unexpected error", async () => {
    const open = (hangReturn: boolean, thrown: unknown) => (): AsyncIterable<StreamEvent> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () => {
          throw thrown;
        },
        return: () => (hangReturn ? never() : Promise.resolve({ done: true, value: undefined })),
      }),
    });
    const signal = new AbortController().signal;
    const failed = await consumeStream(open(false, new ProviderError("down", "connection")), signal, () => Promise.resolve(), 20);
    assert.ok(failed.end.kind === "terminal" && failed.end.event.kind === "failed");
    const unclosed = await consumeStream(open(true, new ProviderError("down", "connection")), signal, () => Promise.resolve(), 20);
    assert.equal(unclosed.end.kind, "unclosed");
    const odd = new Error("odd");
    await assert.rejects(consumeStream(open(true, odd), signal, () => Promise.resolve(), 20), (error: unknown) => error === odd);
  });

  void it("a late rejection of an abandoned return() is consumed", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const open = (): AsyncIterable<StreamEvent> => ({
        [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
          next: () => Promise.resolve({ done: false, value: completedEvent("a") }),
          return: () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => {
                reject(new Error("late"));
              }, 40);
            }),
        }),
      });
      const result = await consumeStream(open, new AbortController().signal, () => Promise.resolve(), 10);
      assert.equal(result.end.kind, "unclosed");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

let tree: Tree;
beforeEach(async () => {
  tree = await makeTree();
});
afterEach(async () => {
  await tree.cleanup();
});

/** A cooperative stream (abort works) whose `return()` never settles; delivers `events` first. */
function hangingOnReturn(events: readonly StreamEvent[]): { readonly handler: ScriptedHandler; readonly returns: () => number } {
  let returns = 0;
  const queue = [...events];
  return {
    returns: () => returns,
    handler: () => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () => {
          const event = queue.shift();
          return Promise.resolve(event === undefined ? { done: true, value: undefined } : { done: false, value: event });
        },
        return: () => {
          returns += 1;
          return never();
        },
      }),
    }),
  };
}
type ScriptedHandler = Parameters<ScriptedProvider["pushStream"]>[0];

void describe("a stream that cannot be closed after its terminal event", () => {
  void it("one-shot: exit 1 with a fixed diagnostic after the shown text, nothing else", async () => {
    const provider = new ScriptedProvider("openai");
    const stream = hangingOnReturn([text("par"), completedEvent("part")]);
    provider.pushStream(stream.handler);
    const run = await runChat(["--stream", "the prompt"], provider, new ManualInput([], true), { tree, deps: { cleanupTimeoutMs: 20 } });
    assert.equal(run.code, 1);
    assert.equal(run.out, "par\n");
    assert.equal(run.err, `neurobrau: error: ${STREAM_UNCLOSED}\n`);
    assert.equal(stream.returns(), 1);
    assert.equal(provider.streamCalls, 1);
  });

  void it("one-shot: a caller interrupt while the close hangs keeps exit 130", async () => {
    const provider = new ScriptedProvider("openai");
    const stream = hangingOnReturn([completedEvent("a")]);
    provider.pushStream(stream.handler);
    const interrupts = fakeInterrupts();
    const pending = runChat(["--stream", "the prompt"], provider, new ManualInput([], true), { tree, deps: { interrupt: interrupts.source, cleanupTimeoutMs: 40 } });
    while (stream.returns() === 0) await settle();
    interrupts.fire();
    assert.equal((await pending).code, 130);
  });

  void it("one-shot: an output failure keeps its exit code when the close hangs too", async () => {
    const provider = new ScriptedProvider("openai");
    const stream = hangingOnReturn([text("x"), completedEvent("x")]);
    provider.pushStream(stream.handler);
    const run = await runChat(["--stream", "the prompt"], provider, new ManualInput([], true), {
      tree,
      deps: { cleanupTimeoutMs: 20 },
      onWrite: (kind) => {
        if (kind === "out") throw epipe();
      },
    });
    assert.equal(run.code, 141);
  });

  void it("chat: ends with exit 1, commits and saves nothing, and starts no second request", async () => {
    const provider = new ScriptedProvider("openai");
    const stream = hangingOnReturn([text("par"), completedEvent("part")]);
    provider.pushStream(stream.handler);
    const history = new MemoryHistory();
    const run = await runChat(["--stream"], provider, new ManualInput(["q", "next", "/exit"]), { tree, deps: { cleanupTimeoutMs: 20, createHistoryStore: () => history } });
    assert.equal(run.code, 1);
    assert.ok(run.err.endsWith(`neurobrau: error: ${STREAM_UNCLOSED}\n`), run.err);
    assert.equal(history.calls.filter((call) => call === "save").length, 0);
    assert.equal(provider.streamCalls, 1);
    assert.equal(stream.returns(), 1);
    assert.ok(!run.out.includes("Goodbye"));
  });

  void it("chat: a clean close still commits (control)", async () => {
    const provider = new ScriptedProvider("openai");
    const controlled = new ControlledStream();
    provider.pushStream(controlled.handler);
    controlled.push(text("ok"), completedEvent("ok"));
    const history = new MemoryHistory();
    const run = await runChat(["--stream"], provider, new ManualInput(["q", "/exit"]), { tree, deps: { createHistoryStore: () => history } });
    assert.equal(run.code, 0);
    assert.equal(history.calls.filter((call) => call === "save").length, 1);
  });
});

void describe("consumeStream reasoning observer (fullscreen status)", () => {
  void it("is told that the model is thinking - never what - and the text path is unchanged", async () => {
    const seen: string[] = [];
    const events: StreamEvent[] = [{ kind: "reasoning", text: "SECRET" }, text("a"), { kind: "reasoning", text: "MORE" }, completedEvent("a")];
    const calls = { ret: 0 };
    const open = (): AsyncIterable<StreamEvent> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: () => {
          const event = events.shift();
          return Promise.resolve(event === undefined ? { done: true, value: undefined } : { done: false, value: event });
        },
        return: () => {
          calls.ret += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    });
    const delivered: string[] = [];
    const result = await consumeStream(open, new AbortController().signal, (t) => { delivered.push(t); return Promise.resolve(); }, 20, (...args: unknown[]) => {
      seen.push(`reasoning(${String(args.length)} args)`);
    });
    assert.equal(result.end.kind, "terminal");
    assert.deepEqual(seen, ["reasoning(0 args)", "reasoning(0 args)"]);
    assert.deepEqual(delivered, ["a"]);
    assert.equal(result.text, "a");
    assert.equal(calls.ret, 1);
  });

  void it("an observer that throws is an output failure: the stream is aborted and closed exactly once", async () => {
    const stream = hanging([{ kind: "reasoning", text: "x" }, completedEvent("a")]);
    const failure = new Error("observer failed");
    const result = await consumeStream(stream.iterable, new AbortController().signal, () => Promise.resolve(), 20, () => { throw failure; });
    assert.ok(result.end.kind === "output-error" || result.end.kind === "unclosed");
    assert.equal(stream.calls.ret, 1);
    assert.equal(stream.calls.aborted, true);
  });
});
