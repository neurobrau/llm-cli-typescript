import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { after, before, beforeEach, describe, it } from "node:test";

import { ProviderError, isAbortError } from "../src/domain/errors.js";
import type { ProviderErrorKind } from "../src/domain/errors.js";
import type { GenerationRequest, StreamEvent, TerminalStreamEvent } from "../src/domain/generation.js";
import { isTerminalEvent } from "../src/domain/generation.js";
import { eventOf, nextEvent } from "./helpers/stream.js";
import { deferred } from "./helpers/deferred.js";
import { Loopback, SSE, completedBody, json, liveStream, sseEvent, textReply } from "./helpers/loopback.js";
import type { ServerStream } from "./helpers/loopback.js";
import { KEY, baseRequest, bodyOf, providerFor } from "./helpers/openai.js";

let server: Loopback;

before(async () => {
  server = await Loopback.start();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  server.requests.length = 0;
  server.unexpected.length = 0;
  assert.equal(server.pending, 0, "a previous test left queued responders");
});

const signal = (): AbortSignal => new AbortController().signal;

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

function terminalOf(events: readonly StreamEvent[]): TerminalStreamEvent {
  const terminals = events.filter(isTerminalEvent);
  assert.equal(terminals.length, 1, "exactly one terminal event");
  const [terminal] = terminals;
  assert.ok(terminal !== undefined);
  assert.equal(events.at(-1), terminal, "the terminal event is last");
  return terminal;
}

const answerOf = (events: readonly StreamEvent[]): string => events.flatMap((e) => (e.kind === "text" ? [e.text] : [])).join("");

const delta = (text: string): string => sseEvent("response.output_text.delta", { delta: text, item_id: "i", output_index: 0, content_index: 0 });
const created = (): string => sseEvent("response.created", { response: { id: "resp_1", status: "in_progress" } });
const completed = (text: string, extra: Record<string, unknown> = {}): string =>
  sseEvent("response.completed", { response: completedBody(text, extra) });

function failedOf(events: readonly StreamEvent[]): Extract<StreamEvent, { kind: "failed" }> {
  const terminal = terminalOf(events);
  assert.ok(terminal.kind === "failed", `expected failed, got ${terminal.kind}`);
  return terminal;
}

void describe("OpenAI streaming: wire and mapping", { timeout: 30_000 }, () => {
  void it("sends stream:true with the non-streaming request mapping, once, with retries off", async () => {
    server.expect(textReply(SSE, created(), delta("a"), completed("a")));
    const request: GenerationRequest = {
      model: "gpt-5",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
      reasoning: { effort: "high", explicit: true, source: "cli" },
      maxOutputTokens: 321,
      instructions: "Be brief.",
    };
    const events = await collect(providerFor(server).provider.stream(request, signal()));
    assert.equal(terminalOf(events).kind, "completed");
    const [sent] = server.requests;
    assert.ok(sent !== undefined);
    assert.equal(sent.path, "/v1/responses");
    assert.deepEqual(bodyOf(sent), {
      model: "gpt-5",
      input: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
      store: false,
      stream: true,
      instructions: "Be brief.",
      reasoning: { effort: "high" },
      max_output_tokens: 321,
    });
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
    assert.equal(server.requests.length, 1);
  });

  void it("never starts the request before the first pull, and snapshots the request when stream() is called", async () => {
    server.expect(textReply(SSE, delta("x"), completed("x")));
    const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: "original" }];
    const request = { ...baseRequest, messages };
    const { provider, keyReads, apiCreations } = providerFor(server);
    const stream = provider.stream(request, signal());
    messages[0] = { role: "user", content: "mutated" };
    messages.push({ role: "assistant", content: "extra" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(keyReads() + apiCreations() + server.requests.length, 0);
    await collect(stream);
    const sent = bodyOf(server.requests[0] ?? assert.fail("no request"));
    assert.deepEqual(sent.input, [{ role: "user", content: "original" }]);
  });

  void it("delivers the first delta before the server sends anything else", async () => {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const iterator = providerFor(server).provider.stream(baseRequest, signal())[Symbol.asyncIterator]();
    const first = iterator.next();
    const remote = await live.opened();
    await remote.write(created());
    await remote.write(delta("Hel"));
    const one = await first; // resolved while the server still holds the rest back
    assert.deepEqual(one.value, { kind: "text", text: "Hel" });
    const second = iterator.next();
    await remote.write(delta("lo"));
    assert.deepEqual((await second).value, { kind: "text", text: "lo" });
    await remote.write(completed("Hello"));
    const last = await nextEvent(iterator);
    assert.ok(last?.kind === "completed");
    assert.equal(last.result.text, "Hello");
    assert.equal((await iterator.next()).done, true);
    remote.end();
  });

  void it("maps text, reasoning, unrelated events and the completed body (usage, tier, metadata)", async () => {
    server.expect(
      textReply(
        SSE,
        created(),
        sseEvent("response.output_item.added", { item: { type: "message" } }),
        sseEvent("response.reasoning_summary_text.delta", { delta: "thinking A" }),
        sseEvent("response.reasoning_text.delta", { delta: "thinking B" }),
        delta("Hel"),
        delta(""),
        delta("lo"),
        sseEvent("response.output_text.done", { text: "Hello" }),
        sseEvent("response.content_part.done", { part: { type: "output_text", text: "Hello" } }),
        completed("Hello", {
          service_tier: "default",
          usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        }),
      ),
    );
    const events = await collect(providerFor(server).provider.stream(baseRequest, signal()));
    assert.deepEqual(
      events.slice(0, -1),
      [
        { kind: "reasoning", text: "thinking A" },
        { kind: "reasoning", text: "thinking B" },
        { kind: "text", text: "Hel" },
        { kind: "text", text: "lo" },
      ],
    );
    const terminal = terminalOf(events);
    assert.ok(terminal.kind === "completed");
    assert.equal(terminal.result.text, "Hello");
    assert.equal(terminal.result.reasoning, undefined);
    assert.equal(terminal.result.serviceTier, "default");
    assert.deepEqual(terminal.result.usage, {
      inputTokens: 10n,
      outputTokens: 0n,
      totalTokens: 10n,
      cachedInputTokens: 0n,
      reasoningTokens: 0n,
    });
    assert.deepEqual(terminal.metadata, { model: "gpt-6-luna", responseId: "resp_1" });
  });

  void it("keeps missing usage fields absent and drops unsafe, negative and fractional counts instead of rounding", async () => {
    server.expect(
      textReply(
        SSE,
        delta("a"),
        // Written as text: 2^53+1 cannot be a JS number literal.
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completedBody("a", { usage: "@@" }) }).replace('"@@"', '{"input_tokens":9007199254740993,"output_tokens":-1,"total_tokens":1.5}')}\n\n`,
      ),
    );
    const terminal = terminalOf(await collect(providerFor(server).provider.stream(baseRequest, signal())));
    assert.ok(terminal.kind === "completed");
    assert.deepEqual(terminal.result.usage, {});
  });

  void it("emits the answer of a valid completed body once when no delta arrived", async () => {
    server.expect(textReply(SSE, created(), completed("Whole answer")));
    const events = await collect(providerFor(server).provider.stream(baseRequest, signal()));
    assert.deepEqual(events.map((e) => e.kind), ["text", "completed"]);
    assert.equal(answerOf(events), "Whole answer");
    assert.ok(events[1]?.kind === "completed" && events[1].result.text === "Whole answer");
  });

  void it("fails a completed stream without any answer, naming a refusal when there is one", async () => {
    server.expect(textReply(SSE, completed("")));
    const empty = failedOf(await collect(providerFor(server).provider.stream(baseRequest, signal())));
    assert.match(empty.error.message, /no answer text/);
    server.expect(
      textReply(
        SSE,
        sseEvent("response.completed", {
          response: { ...completedBody(""), output: [{ type: "message", content: [{ type: "refusal", refusal: "No can do" }] }] },
        }),
      ),
    );
    const refused = failedOf(await collect(providerFor(server).provider.stream(baseRequest, signal())));
    assert.equal(refused.error.message, "OpenAI refused the request: No can do");
  });

  void it("maps response.incomplete with the readable reasons, partial text, usage and tier", async () => {
    const cases: readonly [string, string][] = [
      ["max_output_tokens", "the max output token limit was reached"],
      ["content_filter", "the content filter stopped the response"],
      ["other_reason", "other_reason"],
    ];
    for (const [raw, readable] of cases) {
      server.expect(
        textReply(
          SSE,
          delta("par"),
          delta("tial"),
          sseEvent("response.incomplete", {
            response: { id: "r", model: "m", status: "incomplete", incomplete_details: { reason: raw }, usage: { input_tokens: 3, output_tokens: 4 }, service_tier: "flex" },
          }),
        ),
      );
      const events = await collect(providerFor(server).provider.stream(baseRequest, signal()));
      const terminal = terminalOf(events);
      assert.ok(terminal.kind === "incomplete");
      assert.equal(terminal.reason, readable);
      assert.equal(terminal.partialText, "partial");
      assert.deepEqual(terminal.usage, { inputTokens: 3n, outputTokens: 4n });
      assert.equal(terminal.serviceTier, "flex");
    }
  });

  void it("fails safely on response.failed, error events and SSE error frames, redacting the key", async () => {
    const cases: readonly { name: string; body: string; message: RegExp }[] = [
      {
        name: "failed",
        body: sseEvent("response.failed", { response: { error: { message: `bad ${KEY}\u001b[31m thing` } } }),
        message: /^OpenAI response failed: bad \[redacted\] thing$/,
      },
      { name: "error event", body: sseEvent("error", { message: "server\nbroke" }), message: /^OpenAI stream error: server broke$/ },
      {
        name: "SSE error frame",
        body: `event: error\ndata: ${JSON.stringify({ error: { message: `oops ${KEY}` } })}\n\n`,
        message: /^OpenAI stream error: oops \[redacted\]$/,
      },
    ];
    for (const { name, body, message } of cases) {
      server.expect(textReply(SSE, delta("seen "), body));
      const events = await collect(providerFor(server).provider.stream(baseRequest, signal()));
      const failed = failedOf(events);
      assert.equal(failed.error.kind, "api", name);
      assert.match(failed.error.message, message, name);
      assert.equal(failed.partialText, "seen ", name);
      assert.ok(!JSON.stringify(failed.error.message).includes(KEY), name);
    }
  });

  void it("fails, not coerces, a recognized event with a malformed delta", async () => {
    server.expect(textReply(SSE, delta("ok "), sseEvent("response.output_text.delta", { delta: 42 }), completed("never")));
    const failed = failedOf(await collect(providerFor(server).provider.stream(baseRequest, signal())));
    assert.equal(failed.error.message, "Invalid stream event from OpenAI: text delta is not a string.");
    assert.equal(failed.partialText, "ok ");
  });

  void it("treats EOF without a terminal event as an API failure", async () => {
    server.expect(textReply(SSE, created(), delta("half")));
    const failed = failedOf(await collect(providerFor(server).provider.stream(baseRequest, signal())));
    assert.equal(failed.error.message, "OpenAI stream ended before the response was complete.");
    assert.equal(failed.partialText, "half");
  });

  void it("reassembles events split across arbitrary byte chunks", async () => {
    const whole = Buffer.from(created() + delta("héllo ✓") + completed("héllo ✓"), "utf8");
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < whole.length; at += 7) pieces.push(whole.subarray(at, at + 7));
    server.expect(textReply(SSE, ...pieces));
    const events = await collect(providerFor(server).provider.stream(baseRequest, signal()));
    assert.equal(answerOf(events), "héllo ✓");
    assert.equal(terminalOf(events).kind, "completed");
  });

  void it("maps HTTP status failures to failed events with the usual kinds and does not retry", async () => {
    const cases: readonly [number, ProviderErrorKind][] = [
      [401, "authentication"],
      [403, "authentication"],
      [429, "rate_limit"],
      [408, "timeout"],
      [500, "api"],
      [503, "api"],
    ];
    for (const [status, kind] of cases) {
      server.requests.length = 0;
      server.expect(json(status, { error: { message: `nope ${KEY}`, type: "x" } }));
      const failed = failedOf(await collect(providerFor(server).provider.stream(baseRequest, signal())));
      assert.equal(failed.error.kind, kind, String(status));
      assert.ok(!failed.error.message.includes(KEY));
      assert.equal(server.requests.length, 1, `no retry for ${String(status)}`);
    }
  });

  void it("reports a missing key as a failed event, with no request", async () => {
    const { provider } = providerFor(server, {}, null);
    const failed = failedOf(await collect(provider.stream(baseRequest, signal())));
    assert.equal(failed.error.kind, "missing_api_key");
    assert.equal(server.requests.length, 0);
  });

  void it("reports a refused connection as kind connection", async () => {
    const dead = await Loopback.start();
    const url = dead.url;
    await dead.close();
    const { provider } = providerFor(server, {}, KEY, url);
    const failed = failedOf(await collect(provider.stream(baseRequest, signal())));
    assert.equal(failed.error.kind, "connection");
  });

  void it("reports a dropped connection mid-stream as a failed event with the partial text", async () => {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const pending = collect(providerFor(server).provider.stream(baseRequest, signal()));
    const remote = await live.opened();
    await remote.write(delta("part"));
    remote.destroy();
    const failed = failedOf(await pending);
    assert.equal(failed.partialText, "part");
    assert.ok(failed.error.kind === "connection" || failed.error.kind === "api");
  });
});

void describe("OpenAI streaming: reasoning fallback", { timeout: 30_000 }, () => {
  const reject400 = (param: string | null, message = "Unsupported value"): ReturnType<typeof json> =>
    json(400, { error: { message, type: "invalid_request_error", param, code: "unsupported_value" } });
  const builtin: GenerationRequest = { ...baseRequest, reasoning: { effort: "none", explicit: false, source: "builtin" } };

  void it("retries exactly once without reasoning on a structured reasoning 400, and remembers it", async () => {
    server.expect(reject400("reasoning.effort"), textReply(SSE, delta("ok"), completed("ok")));
    const { provider } = providerFor(server);
    const events = await collect(provider.stream(builtin, signal()));
    assert.equal(answerOf(events), "ok");
    assert.equal(terminalOf(events).kind, "completed");
    assert.equal(server.requests.length, 2);
    assert.deepEqual(bodyOf(server.requests[0] ?? assert.fail("first")).reasoning, { effort: "none" });
    assert.equal("reasoning" in bodyOf(server.requests[1] ?? assert.fail("second")), false);
    server.expect(textReply(SSE, delta("again"), completed("again")));
    await collect(provider.stream(builtin, signal()));
    assert.equal(server.requests.length, 3);
    assert.equal("reasoning" in bodyOf(server.requests[2] ?? assert.fail("third")), false);
  });

  void it("never drops an explicit choice, including a saved or model-default one", async () => {
    for (const source of ["cli", "saved"] as const) {
      server.requests.length = 0;
      server.expect(reject400("reasoning.effort"));
      const request: GenerationRequest = { ...baseRequest, reasoning: { effort: "high", explicit: true, source } };
      const failed = failedOf(await collect(providerFor(server).provider.stream(request, signal())));
      assert.match(failed.error.message, /does not accept reasoning effort 'high'.*--reasoning-effort/);
      assert.equal(server.requests.length, 1, source);
    }
  });

  void it("does not retry other parameters, message-only mentions, generic errors or other statuses", async () => {
    const cases: readonly { name: string; reply: ReturnType<typeof json> }[] = [
      { name: "other param", reply: reject400("max_output_tokens") },
      { name: "no param", reply: reject400(null, "reasoning is not supported") },
      { name: "429", reply: json(429, { error: { message: "reasoning", param: "reasoning.effort" } }) },
      { name: "500", reply: json(500, { error: { message: "reasoning", param: "reasoning.effort" } }) },
    ];
    for (const { name, reply } of cases) {
      server.requests.length = 0;
      server.expect(reply);
      const failed = failedOf(await collect(providerFor(server).provider.stream(builtin, signal())));
      assert.equal(failed.error.kind === "api" || failed.error.kind === "rate_limit", true, name);
      assert.equal(server.requests.length, 1, name);
    }
  });

  void it("does not retry after a stream error event, a disconnect, or output was published", async () => {
    server.expect(textReply(SSE, delta("text"), sseEvent("error", { message: "reasoning.effort rejected", param: "reasoning.effort" })));
    const afterText = failedOf(await collect(providerFor(server).provider.stream(builtin, signal())));
    assert.equal(afterText.partialText, "text");
    assert.equal(server.requests.length, 1);
    server.requests.length = 0;
    server.expect(textReply(SSE, sseEvent("response.reasoning_text.delta", { delta: "hm" })));
    failedOf(await collect(providerFor(server).provider.stream(builtin, signal())));
    assert.equal(server.requests.length, 1);
  });

  void it("does not retry a cancelled request", async () => {
    const controller = new AbortController();
    const arrived = deferred();
    const release = deferred();
    server.expect((request, response, raw) => {
      arrived.resolve();
      void release.promise.then(() => {
        reject400("reasoning.effort")(request, response, raw);
      });
    });
    const pending = collect(providerFor(server).provider.stream(builtin, controller.signal));
    await arrived.promise;
    controller.abort();
    release.resolve();
    await assert.rejects(pending, isAbortError);
    assert.equal(server.requests.length, 1);
  });
});

void describe("OpenAI streaming: lifecycle and cleanup", { timeout: 30_000 }, () => {
  async function openStream(): Promise<{ iterator: AsyncIterator<StreamEvent>; remote: ServerStream; controller: AbortController; first: StreamEvent }> {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const controller = new AbortController();
    const iterator = providerFor(server).provider.stream(baseRequest, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    const remote = await live.opened();
    await remote.write(delta("one"));
    const event = eventOf(await first);
    assert.ok(event !== undefined);
    return { iterator, remote, controller, first: event };
  }

  void it("aborts mid-stream with AbortError (not an event), closes the connection and removes listeners", async () => {
    const { iterator, remote, controller } = await openStream();
    const pending = iterator.next();
    controller.abort(new Error("custom reason"));
    await assert.rejects(pending, (e: unknown) => isAbortError(e) && !(e instanceof ProviderError));
    await remote.closed;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal((await iterator.next()).done, true);
  });

  void it("return() unblocks a pending network pull and closes the connection", async () => {
    const { iterator, remote } = await openStream();
    const pending = iterator.next();
    const settled = pending.then(
      () => "ended",
      (error: unknown) => (isAbortError(error) ? "aborted" : "other"),
    );
    await new Promise((resolve) => setImmediate(resolve)); // the pull is now blocked in the network read
    assert.ok(iterator.return !== undefined);
    const result = await iterator.return();
    assert.equal(result.done, true);
    await remote.closed;
    assert.equal(await settled, "aborted");
    assert.equal((await iterator.return()).done, true, "idempotent");
  });

  void it("an early break closes the connection", async () => {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const stream = providerFor(server).provider.stream(baseRequest, signal());
    const consumer = (async () => {
      for await (const event of stream) {
        assert.equal(event.kind, "text");
        break;
      }
    })();
    const remote = await live.opened();
    await remote.write(delta("a"));
    await consumer;
    await remote.closed;
  });

  void it("ends with the terminal event, closes the response and ignores anything after it", async () => {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const iterator = providerFor(server).provider.stream(baseRequest, signal())[Symbol.asyncIterator]();
    const pending = iterator.next();
    const remote = await live.opened();
    await remote.write(completed("x") + delta("late") + completed("late"));
    assert.ok(eventOf(await pending)?.kind === "text");
    const terminal = await nextEvent(iterator);
    assert.ok(terminal?.kind === "completed");
    assert.equal((await iterator.next()).done, true);
    await remote.closed;
  });

  void it("a signal already aborted yields AbortError without touching key or network", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, keyReads } = providerFor(server);
    await assert.rejects(collect(provider.stream(baseRequest, controller.signal)), isAbortError);
    assert.equal(keyReads(), 0);
  });

  void it("leaves no timer or abort listener behind after completion, failure, abort and early return", async () => {
    const timeouts = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    await new Promise((resolve) => setImmediate(resolve));
    const before = timeouts();
    server.expect(textReply(SSE, delta("a"), completed("a")), textReply(SSE, delta("a"), sseEvent("error", { message: "x" })));
    const controller = new AbortController();
    await collect(providerFor(server).provider.stream(baseRequest, controller.signal));
    await collect(providerFor(server).provider.stream(baseRequest, controller.signal));
    const aborted = await openStream();
    const pending = aborted.iterator.next();
    aborted.controller.abort();
    await pending.catch(() => undefined);
    const returned = await openStream();
    await returned.iterator.return?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timeouts(), before);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(getEventListeners(returned.controller.signal, "abort").length, 0);
  });

  void it("raises no unhandled rejection through abort, return and failure paths", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const { iterator, controller } = await openStream();
      const pending = iterator.next();
      controller.abort();
      await pending.catch(() => undefined);
      const second = await openStream();
      void second.iterator.next().catch(() => undefined);
      await second.iterator.return?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", record);
    }
    assert.deepEqual(unhandled, []);
  });
});

void describe("OpenAI streaming: idle deadline", { timeout: 30_000 }, () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  void it("times out (kind timeout) when nothing arrives before the headers", async () => {
    server.expect(() => undefined); // never answers
    const failed = failedOf(await collect(providerFor(server, { generationTimeoutMs: 80 }).provider.stream(baseRequest, signal())));
    assert.equal(failed.error.kind, "timeout");
  });

  void it("times out between events and keeps the partial text", async () => {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const pending = collect(providerFor(server, { generationTimeoutMs: 120 }).provider.stream(baseRequest, signal()));
    const remote = await live.opened();
    await remote.write(delta("so far"));
    const failed = failedOf(await pending);
    assert.equal(failed.error.kind, "timeout");
    assert.equal(failed.partialText, "so far");
    await remote.closed;
  });

  void it("an external abort wins over the deadline", async () => {
    const arrived = deferred();
    server.expect(() => {
      arrived.resolve();
    });
    const controller = new AbortController();
    const pending = collect(providerFor(server, { generationTimeoutMs: 100 }).provider.stream(baseRequest, controller.signal));
    await arrived.promise;
    controller.abort();
    await assert.rejects(pending, isAbortError);
  });

  void it("a healthy stream may last much longer than the idle period while data keeps arriving", async () => {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const pending = collect(providerFor(server, { generationTimeoutMs: 150 }).provider.stream(baseRequest, signal()));
    const remote = await live.opened();
    const started = Date.now();
    for (let i = 0; i < 8; i += 1) {
      await remote.write(delta(String(i)));
      await sleep(60);
    }
    await remote.write(completed("01234567"));
    const events = await pending;
    assert.ok(Date.now() - started > 150 * 2.5, "the stream outlived the idle period");
    assert.equal(answerOf(events), "01234567");
    assert.equal(terminalOf(events).kind, "completed");
  });

  void it("does not run while the consumer is busy", async () => {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const iterator = providerFor(server, { generationTimeoutMs: 100 }).provider.stream(baseRequest, signal())[Symbol.asyncIterator]();
    const first = iterator.next();
    const remote = await live.opened();
    await remote.write(delta("a"));
    await first;
    await sleep(300); // a slow output writer: three idle periods without a pull
    const next = iterator.next();
    await remote.write(delta("b") + completed("ab"));
    assert.deepEqual((await next).value, { kind: "text", text: "b" });
    assert.ok((await nextEvent(iterator))?.kind === "completed");
  });

  void it("pulls on demand: a stalled consumer leaves later events unread in the transport", async () => {
    const live = liveStream(SSE);
    server.expect(live.responder);
    const iterator = providerFor(server).provider.stream(baseRequest, signal())[Symbol.asyncIterator]();
    const first = iterator.next();
    const remote = await live.opened();
    await remote.write(delta("1"));
    await first;
    for (let i = 0; i < 200; i += 1) await remote.write(delta("x".repeat(1000)));
    // Nothing is read ahead without a pull: the next pull still yields exactly the next event.
    assert.deepEqual((await iterator.next()).value, { kind: "text", text: "x".repeat(1000) });
    await iterator.return?.();
    await remote.closed;
  });
});
