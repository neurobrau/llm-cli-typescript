import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { after, before, beforeEach, describe, it } from "node:test";

import { ProviderError, isAbortError } from "../src/domain/errors.js";
import type { GenerationRequest, StreamEvent, TerminalStreamEvent } from "../src/domain/generation.js";
import { isTerminalEvent } from "../src/domain/generation.js";
import { NdjsonFramer, FrameTooLongError, ThinkFilter } from "../src/providers/ollama/stream.js";
import { nextEvent } from "./helpers/stream.js";
import { deferred } from "./helpers/deferred.js";
import { Loopback, NDJSON, json, liveStream, textReply } from "./helpers/loopback.js";
import type { ServerStream } from "./helpers/loopback.js";
import { baseRequest, bodyOf, providerFor, tag, tags, thinkingShowBody, show } from "./helpers/ollama.js";
import type { OllamaProviderOptions } from "../src/providers/ollama/provider.js";

let server: Loopback;

before(async () => {
  server = await Loopback.start();
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  assert.equal(server.pending, 0, "previous test left unconsumed responders");
  server.requests.length = 0;
  server.unexpected.length = 0;
});

const signal = (): AbortSignal => new AbortController().signal;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const piece = (content: string, extra: Record<string, unknown> = {}): string =>
  line({ model: "m1", message: { role: "assistant", content }, done: false, ...extra });
const done = (extra: Record<string, unknown> = {}): string =>
  line({ model: "m1", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", ...extra });
const plainTag = tag("m1", { capabilities: ["completion"] });

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
const reasoningOf = (events: readonly StreamEvent[]): string => events.flatMap((e) => (e.kind === "reasoning" ? [e.text] : [])).join("");
function failedOf(events: readonly StreamEvent[]): Extract<StreamEvent, { kind: "failed" }> {
  const terminal = terminalOf(events);
  assert.ok(terminal.kind === "failed", `expected failed, got ${terminal.kind}: ${JSON.stringify(terminal)}`);
  return terminal;
}

/** Runs one streamed chat against canned bytes, after the discovery request. */
async function run(chunks: readonly (string | Uint8Array)[], options: Partial<OllamaProviderOptions> = {}, request: GenerationRequest = baseRequest): Promise<StreamEvent[]> {
  server.expect(tags(plainTag), textReply(NDJSON, ...chunks));
  return collect(providerFor(server, options).stream(request, signal()));
}

void describe("NdjsonFramer", () => {
  const framesOf = (chunks: readonly Uint8Array[], max = 1000): string[] => {
    const framer = new NdjsonFramer(max);
    const out = chunks.flatMap((chunk) => {
      const pushed = framer.push(chunk);
      if (pushed.tooLong) throw new FrameTooLongError();
      return pushed.frames;
    });
    const tail = framer.finish();
    return [...out, ...(tail === undefined ? [] : [tail])].map((frame) => Buffer.from(frame).toString("utf8"));
  };

  void it("gives the same frames for every chunking, with LF, CRLF-less bytes and a final unterminated line", () => {
    const whole = Buffer.from('{"a":"é✓"}\n\n{"b":2}\r\n{"c":3}', "utf8");
    const expected = ['{"a":"é✓"}', "", '{"b":2}\r', '{"c":3}'];
    assert.deepEqual(framesOf([whole]), expected);
    for (let at = 1; at < whole.length; at += 1) {
      assert.deepEqual(framesOf([whole.subarray(0, at), whole.subarray(at)]), expected, `split at ${String(at)}`);
    }
    assert.deepEqual(framesOf([...whole].map((byte) => Uint8Array.of(byte))), expected);
  });

  void it("enforces the limit on complete lines in one chunk, on split lines and on unfinished tails", () => {
    const max = 8;
    const check = (chunks: readonly string[]): void => {
      assert.throws(() => framesOf(chunks.map((c) => Buffer.from(c)), max), FrameTooLongError, JSON.stringify(chunks));
    };
    check(["123456789\n"]); // complete, same chunk as its LF
    check(["ok\n123456789\nnever\n"]);
    check(["1234", "56789\n"]); // split
    check(["1234", "56789"]); // unfinished tail
    check(["123456789\r\n"]);
    check(["1234", "56789\r", "\n"]);
    const kept = new NdjsonFramer(max).push(Buffer.from("ok\n123456789\nnever\n"));
    assert.equal(kept.tooLong, true);
    assert.deepEqual(kept.frames.map((frame) => Buffer.from(frame).toString()), ["ok"]);
    assert.deepEqual(framesOf([Buffer.from("12345678\n12345678\r\n12345678\r"), Buffer.from("\n12345678")], max), [
      "12345678",
      "12345678\r",
      "12345678\r",
      "12345678",
    ]);
  });
});

void describe("ThinkFilter", () => {
  /** Feeds `pieces` and returns what was emitted. */
  function filter(pieces: readonly string[]): { answer: string; reasoning: string; unclosed: boolean } {
    const f = new ThinkFilter();
    let answer = "";
    let reasoning = "";
    for (const text of pieces) {
      const out = f.feed(text);
      answer += out.answer;
      reasoning += out.reasoning;
    }
    const rest = f.flush();
    return { answer: answer + rest.answer, reasoning: reasoning + rest.reasoning, unclosed: rest.unclosed };
  }
  /** Every way of splitting the text into two pieces, and the one-character split, give the same result. */
  function assertAtEveryBoundary(text: string, expected: { answer: string; reasoning: string; unclosed?: boolean }): void {
    const want = { unclosed: false, ...expected };
    assert.deepEqual(filter([text]), want, `whole ${JSON.stringify(text)}`);
    for (let at = 1; at < text.length; at += 1) {
      assert.deepEqual(filter([text.slice(0, at), text.slice(at)]), want, `${JSON.stringify(text)} split at ${String(at)}`);
    }
    assert.deepEqual(filter(Array.from(text)), want, `${JSON.stringify(text)} one by one`);
  }

  void it("separates a leading block with any boundary", () => {
    assertAtEveryBoundary("<think>plan</think>\n\nanswer", { answer: "answer", reasoning: "plan" });
    assertAtEveryBoundary("  \n<think>é ✓</think> \t Ünï", { answer: "Ünï", reasoning: "é ✓" });
    assertAtEveryBoundary("<think></think>x", { answer: "x", reasoning: "" });
    assertAtEveryBoundary("<think>a</thin</think>b", { answer: "b", reasoning: "a</thin" });
  });

  void it("keeps later and look-alike tags as answer text", () => {
    assertAtEveryBoundary("plain <think>x</think> text", { answer: "plain <think>x</think> text", reasoning: "" });
    assertAtEveryBoundary("<thinking>x</thinking>", { answer: "<thinking>x</thinking>", reasoning: "" });
    assertAtEveryBoundary("<think>r</think>a <think>b</think>", { answer: "a <think>b</think>", reasoning: "r" });
    assertAtEveryBoundary("<th", { answer: "<th", reasoning: "" });
    assertAtEveryBoundary("  ", { answer: "  ", reasoning: "" });
    assertAtEveryBoundary("  \n<thi", { answer: "  \n<thi", reasoning: "" });
  });

  void it("flags an unclosed block and never turns it into an answer", () => {
    assertAtEveryBoundary("<think>still thinking", { answer: "", reasoning: "still thinking", unclosed: true });
    assertAtEveryBoundary("<think>half </thi", { answer: "", reasoning: "half </thi", unclosed: true });
  });

  void it("passes reasoning on while the block is open, holding only a possible closing tag", () => {
    const f = new ThinkFilter();
    assert.deepEqual(f.feed("<think>abc"), { answer: "", reasoning: "abc" });
    assert.deepEqual(f.feed("def</th"), { answer: "", reasoning: "def" });
    assert.deepEqual(f.feed("ink>  hi"), { answer: "hi", reasoning: "" });
  });
});

void describe("Ollama streaming: request", { timeout: 30_000 }, () => {
  void it("sends stream:true with the non-streaming body (messages, instructions, think, num_predict)", async () => {
    const reasoningTag = tag("m1", { capabilities: ["completion", "thinking"] });
    server.expect(tags(reasoningTag), show(thinkingShowBody([false, true])), textReply(NDJSON, piece("ok"), done()));
    const request: GenerationRequest = {
      model: "m1",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
      reasoning: { effort: "none", explicit: true, source: "cli" },
      maxOutputTokens: 77,
      instructions: "Be brief.",
    };
    await collect(providerFor(server).stream(request, signal()));
    const chatRequest = server.requests.find((r) => r.path === "/api/chat");
    assert.ok(chatRequest !== undefined);
    assert.deepEqual(bodyOf(chatRequest), {
      model: "m1",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
      stream: true,
      think: false,
      options: { num_predict: 77 },
    });
  });

  void it("is lazy and snapshots the request at invocation", async () => {
    const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: "original" }];
    const provider = providerFor(server);
    const stream = provider.stream({ ...baseRequest, messages }, signal());
    messages[0] = { role: "user", content: "mutated" };
    await sleep(10);
    assert.equal(server.requests.length, 0);
    server.expect(tags(plainTag), textReply(NDJSON, piece("x"), done()));
    await collect(stream);
    const sent = bodyOf(server.requests.find((r) => r.path === "/api/chat") ?? assert.fail("no chat"));
    assert.deepEqual(sent.messages, [{ role: "user", content: "original" }]);
  });

  void it("refuses cloud and unknown models before /api/chat, as failed events", async () => {
    const provider = providerFor(server);
    const cloud = failedOf(await collect(provider.stream({ ...baseRequest, model: "glm-4.7:cloud" }, signal())));
    assert.match(cloud.error.message, /cloud model/);
    assert.equal(server.requests.length, 0);
    server.expect(tags(plainTag), tags(plainTag));
    const unknown = failedOf(await collect(provider.stream({ ...baseRequest, model: "nope" }, signal())));
    assert.match(unknown.error.message, /not installed locally.*ollama pull nope/);
    assert.ok(!server.requests.some((r) => r.path === "/api/chat"));
  });

  void it("maps HTTP failures with the install hint for 404 and never retries", async () => {
    server.expect(tags(plainTag), json(404, { error: "model 'm1' not found" }));
    const missing = failedOf(await collect(providerFor(server).stream(baseRequest, signal())));
    assert.match(missing.error.message, /was not found: model 'm1' not found\. Install it yourself with: ollama pull m1/);
    server.requests.length = 0;
    server.expect(tags(plainTag), json(500, { error: "boom\u001b[31m" }));
    const failed = failedOf(await collect(providerFor(server).stream(baseRequest, signal())));
    assert.equal(failed.error.message, "Ollama API error (HTTP 500): boom");
    assert.equal(server.requests.filter((r) => r.path === "/api/chat").length, 1);
  });

  void it("reports a connection that refuses, as kind connection", async () => {
    const dead = await Loopback.start();
    const origin = dead.origin;
    await dead.close();
    const provider = providerFor(server, { baseUrl: origin });
    const failed = failedOf(await collect(provider.stream(baseRequest, signal())));
    assert.equal(failed.error.kind, "connection");
  });
});

void describe("Ollama streaming: records", { timeout: 30_000 }, () => {
  void it("delivers the first delta before the server sends the rest", async () => {
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const iterator = providerFor(server).stream(baseRequest, signal())[Symbol.asyncIterator]();
    const first = iterator.next();
    const remote = await live.opened();
    await remote.write(piece("Hel"));
    assert.deepEqual((await first).value, { kind: "text", text: "Hel" });
    const second = iterator.next();
    await remote.write(piece("lo"));
    assert.deepEqual((await second).value, { kind: "text", text: "lo" });
    await remote.write(done());
    assert.ok((await nextEvent(iterator))?.kind === "completed");
    assert.equal((await iterator.next()).done, true);
    await remote.closed;
  });

  void it("handles several records per chunk, blank lines, CRLF and a final record without newline", async () => {
    const text = piece("a") + "\n" + piece("b").replace("\n", "\r\n") + "   \n" + piece("c") + done().trimEnd();
    const events = await run([text]);
    assert.equal(answerOf(events), "abc");
    assert.deepEqual(events.map((e) => e.kind), ["text", "text", "text", "completed"]);
  });

  void it("decodes characters and records split at every byte boundary", async () => {
    const whole = Buffer.from(piece("héllo ✓ 🙂") + piece("é") + done(), "utf8");
    const events = await run([...whole].map((byte) => Uint8Array.of(byte)));
    assert.equal(answerOf(events), "héllo ✓ 🙂é");
    assert.equal(terminalOf(events).kind, "completed");
  });

  void it("takes the terminal record's content before the terminal event, and ignores bytes after it", async () => {
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const pending = collect(providerFor(server).stream(baseRequest, signal()));
    const remote = await live.opened();
    await remote.write(line({ model: "m1", message: { role: "assistant", content: "end" }, done: true, done_reason: "stop" }) + "not json at all\n" + piece("late"));
    const events = await pending;
    assert.equal(answerOf(events), "end");
    assert.equal(terminalOf(events).kind, "completed");
    await remote.closed; // closed at once, without waiting for the server to finish
  });

  void it("maps explicit thinking and inline think blocks to reasoning only", async () => {
    const events = await run([
      piece("", { message: { role: "assistant", content: "", thinking: "plan " } }),
      piece("<think>inl"),
      piece("ine</th"),
      piece("ink>\n\nAnswer"),
      done(),
    ]);
    assert.equal(answerOf(events), "Answer");
    assert.equal(reasoningOf(events), "plan inline");
    const terminal = terminalOf(events);
    assert.ok(terminal.kind === "completed");
    assert.equal(terminal.result.text, "Answer");
    assert.equal(terminal.result.reasoning, "plan");
  });

  void it("treats a partial tag prefix at the end as ordinary text and later tags as answer", async () => {
    assert.equal(answerOf(await run([piece("<th"), done()])), "<th");
    assert.equal(answerOf(await run([piece("a <think>b</think>"), done()])), "a <think>b</think>");
  });

  void it("an unclosed think block is incomplete with length, a failure when claimed complete", async () => {
    const incomplete = terminalOf(await run([piece("<think>unfinished"), done({ done_reason: "length", eval_count: 5 })]));
    assert.ok(incomplete.kind === "incomplete");
    assert.equal(incomplete.partialText, "");
    assert.deepEqual(incomplete.usage, { outputTokens: 5n });
    const failed = failedOf(await run([piece("<think>unfinished"), done()]));
    assert.match(failed.error.message, /reasoning block never ended/);
    assert.equal(failed.partialText, "");
  });

  void it("a reasoning-only or empty completed answer is allowed", async () => {
    const events = await run([piece("", { message: { role: "assistant", content: "", thinking: "hm" } }), done()]);
    const terminal = terminalOf(events);
    assert.ok(terminal.kind === "completed");
    assert.equal(terminal.result.text, "");
    assert.deepEqual(events.map((e) => e.kind), ["reasoning", "completed"]);
  });

  void it("reads counts and timing from the final record only, and keeps the count policy", async () => {
    const events = await run([
      piece("a", { prompt_eval_count: 999, eval_count: 999 }),
      done({ prompt_eval_count: 11, eval_count: 0, total_duration: 2_500_000_000, load_duration: 500_000_000, prompt_eval_duration: 1, eval_duration: 1_000_000_000 }),
    ]);
    const terminal = terminalOf(events);
    assert.ok(terminal.kind === "completed");
    assert.deepEqual(terminal.result.usage, { inputTokens: 11n, outputTokens: 0n, totalTokens: 11n });
    assert.deepEqual(terminal.metadata, {
      model: "m1",
      doneReason: "stop",
      timing: { totalSeconds: 2.5, loadSeconds: 0.5, promptEvalSeconds: 1e-9, evalSeconds: 1 },
    });
    const partial = terminalOf(await run([piece("a"), done({ eval_count: 7 })]));
    assert.ok(partial.kind === "completed");
    assert.deepEqual(partial.result.usage, { outputTokens: 7n });
    const unsafe = terminalOf(await run([piece("a"), done({ prompt_eval_count: "@@", eval_count: -1, total_duration: -5 }).replace('"@@"', "9007199254740993")]));
    assert.ok(unsafe.kind === "completed");
    assert.equal(unsafe.result.usage, undefined);
    assert.equal(unsafe.metadata?.timing, undefined);
    const bare = terminalOf(await run([piece("a"), done()]));
    assert.ok(bare.kind === "completed");
    assert.equal(bare.result.usage, undefined);
  });

  void it("a length stop is incomplete with the answer so far and its usage", async () => {
    const terminal = terminalOf(await run([piece("par"), piece("tial"), done({ done_reason: "length", prompt_eval_count: 3, eval_count: 4 })]));
    assert.ok(terminal.kind === "incomplete");
    assert.equal(terminal.reason, "the max output token limit was reached");
    assert.equal(terminal.partialText, "partial");
    assert.deepEqual(terminal.usage, { inputTokens: 3n, outputTokens: 4n, totalTokens: 7n });
  });

  void it("maps error records to a failed event with the partial text", async () => {
    const failed = failedOf(await run([piece("so far "), line({ error: "model\u0007 crashed" })]));
    assert.equal(failed.error.message, "Ollama error: model crashed");
    assert.equal(failed.error.kind, "api");
    assert.equal(failed.partialText, "so far ");
  });

  void it("rejects malformed records safely, without coercion", async () => {
    const cases: readonly { name: string; chunks: readonly (string | Uint8Array)[]; message: RegExp }[] = [
      { name: "not JSON", chunks: ["{nope\n"], message: /not valid JSON/ },
      { name: "array", chunks: ["[1]\n"], message: /not a JSON object/ },
      { name: "string", chunks: ['"x"\n'], message: /not a JSON object/ },
      { name: "invalid UTF-8", chunks: [Uint8Array.of(0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d, 0x0a)], message: /not valid UTF-8/ },
      { name: "content number", chunks: [line({ message: { content: 5 }, done: false })], message: /message\.content/ },
      { name: "content null", chunks: [line({ message: { content: null }, done: false })], message: /message\.content/ },
      { name: "message string", chunks: [line({ message: "hi", done: false })], message: /invalid 'message'/ },
      { name: "thinking number", chunks: [line({ message: { content: "", thinking: 1 }, done: false })], message: /thinking/ },
      { name: "done string", chunks: [line({ message: { content: "x" }, done: "true" })], message: /invalid 'done'/ },
      { name: "done null", chunks: [line({ message: { content: "x" }, done: null })], message: /invalid 'done'/ },
    ];
    for (const { name, chunks, message } of cases) {
      const failed = failedOf(await run([piece("seen "), ...chunks]));
      assert.equal(failed.error.kind, "api", name);
      assert.match(failed.error.message, message, name);
      assert.equal(failed.partialText, "seen ", name);
    }
  });

  void it("allows a final or metadata-only record without a message", async () => {
    const events = await run([piece("a"), line({ model: "m1", done: true, done_reason: "stop", eval_count: 2 })]);
    const terminal = terminalOf(events);
    assert.ok(terminal.kind === "completed");
    assert.deepEqual(terminal.result.usage, { outputTokens: 2n });
  });

  void it("treats EOF before done:true as a connection failure, cleanly closed or not", async () => {
    const clean = failedOf(await run([piece("half")]));
    assert.equal(clean.error.kind, "connection");
    assert.equal(clean.error.message, "Ollama stream ended before the response was complete.");
    assert.equal(clean.partialText, "half");
    const noDone = failedOf(await run([piece("a"), line({ model: "m1", message: { content: "" } })]));
    assert.equal(noDone.error.kind, "connection");
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const pending = collect(providerFor(server).stream(baseRequest, signal()));
    const remote = await live.opened();
    await remote.write(piece("cut"));
    remote.destroy();
    const dropped = failedOf(await pending);
    assert.equal(dropped.error.kind, "connection");
    assert.equal(dropped.partialText, "cut");
  });

  void it("enforces the frame limit for complete lines in one chunk, split lines and tails", async () => {
    const options = { maxFrameBytes: 120 };
    const big = piece("x".repeat(300));
    for (const chunks of [[big], [big.slice(0, 50), big.slice(50, 200), big.slice(200)], [big.trimEnd()]]) {
      const failed = failedOf(await run([piece("ok"), ...chunks, done()], options));
      assert.equal(failed.error.message, "Invalid response from Ollama: stream line is too long.");
      assert.equal(failed.partialText, "ok");
    }
    const fine = await run([piece("x".repeat(20)), done()], options);
    assert.equal(terminalOf(fine).kind, "completed");
  });
});

void describe("Ollama streaming: lifecycle and idle deadline", { timeout: 30_000 }, () => {
  async function opened(options: Partial<OllamaProviderOptions> = {}): Promise<{ iterator: AsyncIterator<StreamEvent>; remote: ServerStream; controller: AbortController }> {
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const controller = new AbortController();
    const iterator = providerFor(server, options).stream(baseRequest, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    const remote = await live.opened();
    await remote.write(piece("one"));
    assert.deepEqual((await first).value, { kind: "text", text: "one" });
    return { iterator, remote, controller };
  }

  void it("aborts mid-stream with AbortError (no event), closes the connection and removes listeners", async () => {
    const { iterator, remote, controller } = await opened();
    const pending = iterator.next();
    controller.abort(new Error("custom"));
    await assert.rejects(pending, (e: unknown) => isAbortError(e) && !(e instanceof ProviderError));
    await remote.closed;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal((await iterator.next()).done, true);
  });

  void it("return() unblocks a pending network pull and closes the connection", async () => {
    const { iterator, remote } = await opened();
    const settled = iterator.next().then(
      () => "ended",
      (e: unknown) => (isAbortError(e) ? "aborted" : "other"),
    );
    await sleep(20);
    assert.ok(iterator.return !== undefined);
    assert.equal((await iterator.return()).done, true);
    await remote.closed;
    assert.equal(await settled, "aborted");
    assert.equal((await iterator.return()).done, true);
  });

  void it("an early break closes the connection", async () => {
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const consumer = (async () => {
      for await (const event of providerFor(server).stream(baseRequest, signal())) {
        assert.equal(event.kind, "text");
        break;
      }
    })();
    const remote = await live.opened();
    await remote.write(piece("a"));
    await consumer;
    await remote.closed;
  });

  void it("a pre-aborted signal sends nothing; an abort during discovery rejects with AbortError", async () => {
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(collect(providerFor(server).stream(baseRequest, gone.signal)), isAbortError);
    assert.equal(server.requests.length, 0);
    const arrived = deferred();
    server.expect(() => {
      arrived.resolve();
    });
    const controller = new AbortController();
    const pending = collect(providerFor(server).stream(baseRequest, controller.signal));
    await arrived.promise;
    controller.abort();
    await assert.rejects(pending, isAbortError);
  });

  void it("times out before the headers (kind timeout), counted from sending /api/chat", async () => {
    server.expect(tags(plainTag), () => undefined);
    const failed = failedOf(await collect(providerFor(server, { chatTimeoutMs: 80 }).stream(baseRequest, signal())));
    assert.equal(failed.error.kind, "timeout");
    assert.equal(failed.error.message, "Request to Ollama timed out.");
  });

  void it("times out between reads and keeps the partial text", async () => {
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const pending = collect(providerFor(server, { chatTimeoutMs: 120 }).stream(baseRequest, signal()));
    const remote = await live.opened();
    await remote.write(piece("so far"));
    const failed = failedOf(await pending);
    assert.equal(failed.error.kind, "timeout");
    assert.equal(failed.partialText, "so far");
    await remote.closed;
  });

  void it("an external abort wins over the deadline", async () => {
    const arrived = deferred();
    server.expect(tags(plainTag), () => {
      arrived.resolve();
    });
    const controller = new AbortController();
    const pending = collect(providerFor(server, { chatTimeoutMs: 100 }).stream(baseRequest, controller.signal));
    await arrived.promise;
    controller.abort();
    await assert.rejects(pending, isAbortError);
  });

  void it("a healthy answer may outlast the idle period; bytes of an unfinished line count as progress", async () => {
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const pending = collect(providerFor(server, { chatTimeoutMs: 150 }).stream(baseRequest, signal()));
    const remote = await live.opened();
    const started = Date.now();
    for (let i = 0; i < 6; i += 1) {
      const text = piece(String(i));
      await remote.write(text.slice(0, 10));
      await sleep(50);
      await remote.write(text.slice(10));
      await sleep(50);
    }
    await remote.write(done());
    const events = await pending;
    assert.ok(Date.now() - started > 150 * 2.5);
    assert.equal(answerOf(events), "012345");
  });

  void it("does not run while the consumer is busy", async () => {
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const iterator = providerFor(server, { chatTimeoutMs: 100 }).stream(baseRequest, signal())[Symbol.asyncIterator]();
    const first = iterator.next();
    const remote = await live.opened();
    await remote.write(piece("a"));
    await first;
    await sleep(300);
    const next = iterator.next();
    await remote.write(piece("b") + done());
    assert.deepEqual((await next).value, { kind: "text", text: "b" });
    assert.ok((await nextEvent(iterator))?.kind === "completed");
  });

  void it("reads on demand: a stalled consumer does not drain the socket into memory", async () => {
    const live = liveStream(NDJSON);
    server.expect(tags(plainTag), live.responder);
    const iterator = providerFor(server).stream(baseRequest, signal())[Symbol.asyncIterator]();
    const first = iterator.next();
    const remote = await live.opened();
    await remote.write(piece("1"));
    await first;
    const filler = piece("x".repeat(60_000));
    let accepted = 0;
    const flag = { blocked: false };
    const writer = (async () => {
      for (let i = 0; i < 400; i += 1) {
        if (flag.blocked) break;
        await remote.write(filler);
        accepted += 1;
      }
    })();
    await Promise.race([writer, sleep(300).then(() => (flag.blocked = true))]);
    assert.ok(flag.blocked, `the sender was held back by backpressure (accepted ${String(accepted)} writes)`);
    assert.deepEqual((await iterator.next()).value, { kind: "text", text: "x".repeat(60_000) });
    await iterator.return?.();
    await remote.closed;
  });

  void it("leaves no timer or abort listener behind after completion, failure, abort and early return", async () => {
    const timeouts = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    await sleep(10);
    const before = timeouts();
    server.expect(tags(plainTag), textReply(NDJSON, piece("a"), done()), tags(plainTag), textReply(NDJSON, piece("a"), line({ error: "x" })));
    const controller = new AbortController();
    await collect(providerFor(server).stream(baseRequest, controller.signal));
    await collect(providerFor(server).stream(baseRequest, controller.signal));
    const aborted = await opened();
    const pending = aborted.iterator.next();
    aborted.controller.abort();
    await pending.catch(() => undefined);
    const returned = await opened();
    await returned.iterator.return?.();
    await sleep(10);
    assert.equal(timeouts(), before);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(getEventListeners(returned.controller.signal, "abort").length, 0);
  });

  void it("raises no unhandled rejection through abort and return paths", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const one = await opened();
      const pending = one.iterator.next();
      one.controller.abort();
      await pending.catch(() => undefined);
      const two = await opened();
      void two.iterator.next().catch(() => undefined);
      await two.iterator.return?.();
      await sleep(50);
    } finally {
      process.off("unhandledRejection", record);
    }
    assert.deepEqual(unhandled, []);
  });
});
