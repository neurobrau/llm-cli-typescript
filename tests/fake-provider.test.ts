import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError, isAbortError } from "../src/domain/errors.js";
import { isTerminalEvent } from "../src/domain/generation.js";
import type { GenerationRequest, Message, StreamEvent } from "../src/domain/generation.js";
import type { Provider } from "../src/domain/provider.js";
import { deferred } from "./helpers/deferred.js";
import { FakeProvider } from "./helpers/fake-provider.js";

const request: GenerationRequest = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  reasoning: { explicit: false, source: "builtin" },
};

async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

void describe("FakeProvider", () => {
  void it("conforms to the Provider contract and answers metadata calls", async () => {
    const provider: Provider = new FakeProvider({
      models: [{ id: "m", remote: false, capabilities: [] }],
      defaultModel: "m",
      availability: { available: false, message: "down" },
    });
    const signal = new AbortController().signal;
    assert.equal(provider.id, "openai");
    assert.deepEqual(await provider.listModels(signal), [{ id: "m", remote: false, capabilities: [] }]);
    assert.equal(await provider.defaultModel(signal), "m");
    assert.deepEqual(await provider.checkAvailability(signal), { available: false, message: "down" });
    assert.equal((await provider.getCapabilities("m", signal)).reasoning.known, false);
  });

  void it("returns completed and incomplete outcomes and rejects with a ProviderError", async () => {
    const signal = new AbortController().signal;
    const completed = new FakeProvider({
      outcome: { kind: "completed", result: { text: "ok", reasoning: "think", usage: { inputTokens: 0n } } },
    });
    const outcome = await completed.generate(request, signal);
    assert.ok(outcome.kind === "completed");
    assert.equal(outcome.result.text, "ok");
    assert.equal(outcome.result.reasoning, "think");
    const incomplete = new FakeProvider({
      outcome: { kind: "incomplete", reason: "max_output_tokens", partialText: "par", usage: { outputTokens: 5n } },
    });
    assert.deepEqual(await incomplete.generate(request, signal), {
      kind: "incomplete",
      reason: "max_output_tokens",
      partialText: "par",
      usage: { outputTokens: 5n },
    });
    const failing = new FakeProvider({ outcome: new ProviderError("limit", "rate_limit") });
    await assert.rejects(failing.generate(request, signal), (error: unknown) => {
      return error instanceof ProviderError && error.kind === "rate_limit";
    });
  });

  void it("captures immutable request snapshots", async () => {
    const provider = new FakeProvider();
    const messages: Message[] = [{ role: "user", content: "hi" }];
    await provider.generate({ ...request, messages }, new AbortController().signal);
    messages.push({ role: "user", content: "mutated" });
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.messages.length, 1);
    assert.ok(Object.isFrozen(provider.requests[0]));
  });

  void it("streams separate text and reasoning with a single terminal event", async () => {
    const events: readonly StreamEvent[] = [
      { kind: "reasoning", text: "hmm" },
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
      { kind: "completed", result: { text: "Hello", reasoning: "hmm" }, metadata: { doneReason: "stop" } },
    ];
    const provider = new FakeProvider({ events });
    const received = await collect(provider.stream(request, new AbortController().signal));
    assert.deepEqual(received, events);
    assert.equal(received.filter(isTerminalEvent).length, 1);
    const last = received.at(-1);
    assert.ok(last !== undefined && isTerminalEvent(last));
    const text = received.flatMap((event) => (event.kind === "text" ? [event.text] : [])).join("");
    assert.equal(text, "Hello");
    assert.equal(provider.streamCleanups, 1);
  });

  void it("rejects before doing any work when the signal is already aborted", async () => {
    const provider = new FakeProvider();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.generate(request, controller.signal), isAbortError);
    await assert.rejects(provider.listModels(controller.signal), isAbortError);
    await assert.rejects(collect(provider.stream(request, controller.signal)), isAbortError);
    assert.equal(provider.requests.length, 0);
    assert.equal(provider.activeAbortListeners, 0);
  });

  void it("cancels a pending generate with an AbortError and removes its listener", async () => {
    const provider = new FakeProvider({ gate: deferred() });
    const controller = new AbortController();
    const pending = provider.generate(request, controller.signal);
    await provider.reachedPending;
    assert.equal(provider.activeAbortListeners, 1);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => isAbortError(error) && !(error instanceof ProviderError));
    assert.equal(provider.activeAbortListeners, 0);
  });

  void it("removes the abort listener after normal completion", async () => {
    const gate = deferred();
    const provider = new FakeProvider({ gate, outcome: { kind: "completed", result: { text: "x" } } });
    const pending = provider.generate(request, new AbortController().signal);
    await provider.reachedPending;
    assert.equal(provider.activeAbortListeners, 1);
    gate.resolve();
    assert.equal((await pending).kind, "completed");
    assert.equal(provider.activeAbortListeners, 0);
  });

  void it("cancels a pending stream without events and cleans up once", async () => {
    const provider = new FakeProvider({ gate: deferred(), events: [{ kind: "text", text: "never" }] });
    const controller = new AbortController();
    const consumed = collect(provider.stream(request, controller.signal));
    await provider.reachedPending;
    controller.abort();
    await assert.rejects(consumed, isAbortError);
    assert.equal(provider.activeAbortListeners, 0);
    assert.equal(provider.streamCleanups, 1);
  });

  void it("runs cleanup exactly once on early iterator return, even if return is repeated", async () => {
    const provider = new FakeProvider({
      events: [
        { kind: "text", text: "a" },
        { kind: "text", text: "b" },
        { kind: "completed", result: { text: "ab" } },
      ],
    });
    const iterator = provider.stream(request, new AbortController().signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.deepEqual(first.value, { kind: "text", text: "a" });
    await iterator.return(undefined);
    await iterator.return(undefined);
    assert.equal(provider.streamCleanups, 1);
    assert.equal((await iterator.next()).done, true);
  });

  void it("rejects when aborted immediately after a call without a gate", async () => {
    const outcome = { kind: "completed", result: { text: "x" } } as const;
    const provider = new FakeProvider({ outcome, models: [], defaultModel: "m" });
    const calls: readonly ((signal: AbortSignal) => Promise<unknown>)[] = [
      (signal) => provider.generate(request, signal),
      (signal) => provider.listModels(signal),
      (signal) => provider.checkAvailability(signal),
      (signal) => provider.defaultModel(signal),
      (signal) => provider.getCapabilities("m", signal),
      (signal) => collect(provider.stream(request, signal)),
    ];
    for (const call of calls) {
      const controller = new AbortController();
      const pending = call(controller.signal);
      controller.abort(); // before the result is awaited
      await assert.rejects(pending, isAbortError);
    }
    assert.equal(provider.activeAbortListeners, 0);
  });

  void it("stops a stream when aborted between events and cleans up once", async () => {
    const provider = new FakeProvider({
      events: [
        { kind: "text", text: "a" },
        { kind: "completed", result: { text: "a" } },
      ],
    });
    const controller = new AbortController();
    const iterator = provider.stream(request, controller.signal);
    assert.deepEqual((await iterator.next()).value, { kind: "text", text: "a" });
    controller.abort();
    await assert.rejects(iterator.next(), isAbortError);
    assert.equal(provider.streamCleanups, 1);
  });

  void it("normalizes custom abort reasons to AbortError across all methods", async () => {
    const reasons: readonly unknown[] = [new Error("custom"), "a string", 42, undefined, new ProviderError("x", "timeout")];
    for (const reason of reasons) {
      const aborted = new AbortController();
      aborted.abort(reason);
      const provider = new FakeProvider();
      const rejections = [
        provider.generate(request, aborted.signal),
        provider.listModels(aborted.signal),
        provider.checkAvailability(aborted.signal),
        provider.defaultModel(aborted.signal),
        provider.getCapabilities("m", aborted.signal),
        collect(provider.stream(request, aborted.signal)),
      ];
      for (const rejection of rejections) {
        await assert.rejects(rejection, (error: unknown) => isAbortError(error) && !(error instanceof ProviderError));
      }

      // Abort with a custom reason while an operation is pending.
      const gated = new FakeProvider({ gate: deferred() });
      const controller = new AbortController();
      const pending = gated.generate(request, controller.signal);
      await gated.reachedPending;
      controller.abort(reason);
      await assert.rejects(pending, (error: unknown) => isAbortError(error) && error !== reason);
      assert.equal(gated.activeAbortListeners, 0);
    }
  });
});
