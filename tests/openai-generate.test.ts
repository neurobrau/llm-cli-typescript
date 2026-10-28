import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { after, before, beforeEach, describe, it } from "node:test";

import { ProviderError, isAbortError } from "../src/domain/errors.js";
import type { ProviderErrorKind } from "../src/domain/errors.js";
import type { GenerationOutcome, GenerationRequest } from "../src/domain/generation.js";
import { deferred } from "./helpers/deferred.js";
import { Loopback, completedBody, json } from "./helpers/loopback.js";
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

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected a rejection");
}

function completedText(outcome: GenerationOutcome): string {
  assert.ok(outcome.kind === "completed");
  return outcome.result.text;
}

void describe("request construction", () => {
  void it("sends a text-only Responses request with store:false and bearer auth", async () => {
    server.expect(json(200, completedBody("ok")));
    const { provider } = providerFor(server);
    const request: GenerationRequest = {
      model: "gpt-5",
      messages: [
        { role: "user", content: "  first  " },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
      reasoning: { effort: "high", explicit: true, source: "cli" },
      maxOutputTokens: 321,
      instructions: "Be brief.",
    };
    assert.equal(completedText(await provider.generate(request, signal())), "ok");
    assert.equal(server.requests.length, 1);
    const [sent] = server.requests;
    assert.ok(sent);
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, "/v1/responses");
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(bodyOf(sent), {
      model: "gpt-5",
      input: [
        { role: "user", content: "  first  " },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
      store: false,
      instructions: "Be brief.",
      reasoning: { effort: "high" },
      max_output_tokens: 321,
    });
  });

  void it("omits reasoning, limits and instructions unless chosen, and never serializes provenance", async () => {
    server.expect(json(200, completedBody("ok")));
    const { provider } = providerFor(server);
    await provider.generate(
      { ...baseRequest, reasoning: { explicit: true, source: "cli" } }, // explicit model-default
      signal(),
    );
    const body = bodyOf(server.requests[0] ?? { body: "{}" });
    assert.deepEqual(Object.keys(body).sort(), ["input", "model", "store"]);
    assert.equal(body.store, false);
  });

  void it("sends the built-in default effort when one is resolved", async () => {
    server.expect(json(200, completedBody("ok")));
    const { provider } = providerFor(server);
    await provider.generate({ ...baseRequest, reasoning: { effort: "none", explicit: false, source: "builtin" } }, signal());
    assert.deepEqual(bodyOf(server.requests[0] ?? { body: "{}" }).reasoning, { effort: "none" });
  });

  void it("snapshots the request before the first await", async () => {
    server.expect(json(200, completedBody("ok")));
    const { provider } = providerFor(server);
    const messages = [{ role: "user" as const, content: "original" }];
    const pending = provider.generate({ ...baseRequest, messages }, signal());
    messages[0] = { role: "user", content: "mutated" };
    messages.push({ role: "user", content: "extra" });
    await pending;
    assert.deepEqual(bodyOf(server.requests[0] ?? { body: "{}" }).input, [{ role: "user", content: "original" }]);
  });

  void it("disables SDK retries: a single request per attempt for 429 and 5xx", async () => {
    for (const status of [429, 500, 503]) {
      server.requests.length = 0;
      server.expect(json(status, { error: { message: "x" } }));
      const { provider } = providerFor(server);
      await failureOf(provider.generate(baseRequest, signal()));
      assert.equal(server.requests.length, 1, `status ${String(status)}`);
    }
    assert.equal(server.unexpected.length, 0);
  });

  void it("ignores ambient SDK settings (base URL, organization, custom headers)", async () => {
    const saved = { ...process.env };
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/unused";
    process.env.OPENAI_ORG_ID = "org-synthetic";
    process.env.OPENAI_PROJECT_ID = "proj-synthetic";
    process.env.OPENAI_CUSTOM_HEADERS = "X-Ambient: 1\nX-Other: 2";
    try {
      server.expect(json(200, completedBody("ok")));
      const { provider } = providerFor(server);
      await provider.generate(baseRequest, signal());
    } finally {
      for (const name of ["OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_CUSTOM_HEADERS"]) {
        if (saved[name] === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = saved[name];
        }
      }
    }
    const [sent] = server.requests;
    assert.ok(sent);
    for (const header of ["x-ambient", "x-other", "openai-organization", "openai-project"]) {
      assert.equal(sent.headers[header], undefined, header);
    }
  });
});

void describe("credentials", () => {
  void it("reads the key only when an operation runs, trims it, and fails with kind 3 when blank", async () => {
    for (const key of [null, "", "   \t"]) {
      const { provider, keyReads, apiCreations } = providerFor(server, {}, key);
      assert.equal(keyReads(), 0, "no read at construction");
      const error = await failureOf(provider.generate(baseRequest, signal()));
      assert.equal(error.kind, "missing_api_key");
      assert.equal(error.message, "OPENAI_API_KEY is not set. Export it in your environment and try again.");
      assert.equal(keyReads(), 1);
      assert.equal(apiCreations(), 0);
    }
    assert.equal(server.requests.length, 0);
    server.expect(json(200, completedBody("ok")));
    const padded = providerFor(server, {}, `  ${KEY}\n`);
    await padded.provider.generate(baseRequest, signal());
    assert.equal(server.requests[0]?.headers.authorization, `Bearer ${KEY}`);
  });
});

void describe("response conversion", () => {
  void it("joins output_text parts in order, ignores other items, and preserves text exactly", async () => {
    server.expect(
      json(200, {
        ...completedBody("unused"),
        output: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "SECRET THOUGHT" }] },
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "  Hello", annotations: [] },
              { type: "refusal", refusal: "ignored when text exists" },
              { type: "output_text", text: ", world \n", annotations: [] },
            ],
          },
          { type: "function_call", name: "x", arguments: "{}" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "!", annotations: [] }] },
        ],
      }),
    );
    const outcome = await providerFor(server).provider.generate(baseRequest, signal());
    assert.equal(completedText(outcome), "  Hello, world \n!");
    assert.ok(outcome.kind === "completed" && outcome.result.reasoning === undefined);
  });

  void it("converts reported usage to exact bigints and keeps absence distinct from zero", async () => {
    server.expect(
      json(
        200,
        completedBody("ok", {
          usage: {
            input_tokens: 12,
            output_tokens: 0,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
          service_tier: "default",
        }),
      ),
    );
    const outcome = await providerFor(server).provider.generate(baseRequest, signal());
    assert.ok(outcome.kind === "completed");
    assert.deepEqual(outcome.result.usage, {
      inputTokens: 12n,
      outputTokens: 0n,
      cachedInputTokens: 5n,
      cacheWriteTokens: 0n,
      reasoningTokens: 3n,
    });
    assert.ok(!("totalTokens" in (outcome.result.usage ?? {})), "total is never synthesized");
    assert.equal(outcome.result.serviceTier, "default");
  });

  void it("skips malformed or unsafe counts instead of rounding them", async () => {
    server.expect(
      json(
        200,
        completedBody("ok", {
          usage: {
            input_tokens: -1,
            output_tokens: 1.5,
            total_tokens: "7",
            input_tokens_details: { cached_tokens: null },
            output_tokens_details: { reasoning_tokens: 9 },
          },
        }),
      ),
    );
    const outcome = await providerFor(server).provider.generate(baseRequest, signal());
    assert.ok(outcome.kind === "completed");
    assert.deepEqual(outcome.result.usage, { reasoningTokens: 9n });
  });

  void it("rejects counts beyond the safe integer range as not reported", async () => {
    // Raw JSON so the digits are not rounded on the way out of the test server.
    server.expect((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        '{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],' +
          '"usage":{"input_tokens":9007199254740993,"output_tokens":9007199254740991}}',
      );
    });
    const outcome = await providerFor(server).provider.generate(baseRequest, signal());
    assert.ok(outcome.kind === "completed");
    assert.deepEqual(outcome.result.usage, { outputTokens: 9007199254740991n });
  });

  void it("treats null or missing usage as absent and preserves an empty service tier", async () => {
    server.expect(json(200, completedBody("a", { usage: null, service_tier: "" })), json(200, completedBody("b", { service_tier: null })));
    const { provider } = providerFor(server);
    const first = await provider.generate(baseRequest, signal());
    assert.ok(first.kind === "completed");
    assert.ok(!("usage" in first.result));
    assert.equal(first.result.serviceTier, "");
    const second = await provider.generate(baseRequest, signal());
    assert.ok(second.kind === "completed");
    assert.ok(!("serviceTier" in second.result));
  });

  void it("returns an incomplete outcome with partial text, usage and tier", async () => {
    const cases: readonly { reason: unknown; expected: string }[] = [
      { reason: "max_output_tokens", expected: "the max output token limit was reached" },
      { reason: "content_filter", expected: "the content filter stopped the response" },
      { reason: "something_new", expected: "something_new" },
      { reason: "bad\u001b[31m\nreason sk-abcdef123456", expected: "bad reason [redacted]" },
      { reason: undefined, expected: "unknown reason" },
    ];
    for (const { reason, expected } of cases) {
      server.expect(
        json(200, {
          ...completedBody("partial answer", {
            status: "incomplete",
            incomplete_details: reason === undefined ? null : { reason },
            usage: { input_tokens: 4, output_tokens: 2 },
            service_tier: "",
          }),
        }),
      );
      const outcome = await providerFor(server).provider.generate(baseRequest, signal());
      assert.deepEqual(outcome, {
        kind: "incomplete",
        reason: expected,
        partialText: "partial answer",
        usage: { inputTokens: 4n, outputTokens: 2n },
        serviceTier: "",
      });
    }
  });

  void it("normalizes refusals, empty answers, failed and unfinished statuses to API errors", async () => {
    const refusal = { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No\ncan do sk-abcdef123456" }] };
    const cases: readonly { body: unknown; pattern: RegExp }[] = [
      { body: { ...completedBody(""), output: [refusal] }, pattern: /^OpenAI refused the request: No can do \[redacted\]$/ },
      { body: completedBody(""), pattern: /completed response with no answer text/ },
      { body: { ...completedBody("x"), output: [] }, pattern: /no answer text/ },
      { body: { status: "failed", error: { message: "boom\u001b[1m" } }, pattern: /^OpenAI response failed: boom$/ },
      { body: { status: "failed" }, pattern: /failed: no details$/ },
      { body: completedBody("x", { status: "cancelled" }), pattern: /status 'cancelled'/ },
      { body: completedBody("x", { status: "queued" }), pattern: /status 'queued'/ },
      { body: completedBody("x", { status: "in_progress" }), pattern: /status 'in_progress'/ },
      { body: { output: [] }, pattern: /status 'missing'/ },
      { body: completedBody("x", { status: 5 }), pattern: /status 'missing'/ },
      { body: { status: "completed" }, pattern: /no output/ },
      { body: { status: "completed", output: "text" }, pattern: /no output/ },
      { body: null, pattern: /Invalid response from OpenAI/ },
      { body: [], pattern: /empty reply/ },
      { body: "just text", pattern: /Invalid response from OpenAI/ },
    ];
    for (const { body, pattern } of cases) {
      server.expect(json(200, body));
      const error = await failureOf(providerFor(server).provider.generate(baseRequest, signal()));
      assert.equal(error.kind, "api");
      assert.match(error.message, pattern, JSON.stringify(body));
    }
  });

  void it("reports a malformed JSON body as a safe API error", async () => {
    server.expect((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end("{not json");
    });
    const error = await failureOf(providerFor(server).provider.generate(baseRequest, signal()));
    assert.equal(error.kind, "api");
    assert.ok(!error.message.includes("not json"));
  });
});

void describe("error mapping and redaction", () => {
  void it("maps HTTP statuses to kinds with fixed or sanitized messages", async () => {
    const cases: readonly { status: number; kind: ProviderErrorKind; pattern: RegExp }[] = [
      { status: 401, kind: "authentication", pattern: /^OpenAI authentication failed\. Check that OPENAI_API_KEY is valid\.$/ },
      { status: 403, kind: "authentication", pattern: /^OpenAI denied access \(HTTP 403\)/ },
      { status: 429, kind: "rate_limit", pattern: /^OpenAI rate limit or quota exceeded/ },
      { status: 408, kind: "timeout", pattern: /^Request to OpenAI timed out\.$/ },
      { status: 400, kind: "api", pattern: /^OpenAI API error \(HTTP 400\): bad thing$/ },
      { status: 404, kind: "api", pattern: /^OpenAI API error \(HTTP 404\): bad thing$/ },
      { status: 500, kind: "api", pattern: /^OpenAI API error \(HTTP 500\): bad thing$/ },
    ];
    for (const { status, kind, pattern } of cases) {
      server.expect(json(status, { error: { message: "bad thing", type: "x", param: null, code: null } }));
      const error = await failureOf(providerFor(server).provider.generate(baseRequest, signal()));
      assert.equal(error.kind, kind, String(status));
      assert.match(error.message, pattern, String(status));
    }
  });

  void it("does not echo server text for authentication, rate limit or timeout", async () => {
    for (const status of [401, 403, 429, 408]) {
      server.expect(json(status, { error: { message: `echo ${KEY} and PROMPT-TEXT` } }));
      const error = await failureOf(providerFor(server).provider.generate(baseRequest, signal()));
      assert.ok(!error.message.includes(KEY) && !error.message.includes("PROMPT-TEXT"), String(status));
    }
  });

  void it("redacts the configured key and key-like strings, strips controls and caps length", async () => {
    const noisy = `line1\nline2 ${KEY} \u001b[31mred\u001b[0m \u001b]0;title\u0007 sk-proj-AbCdEf_123456 ${"x".repeat(400)}`;
    server.expect(json(500, { error: { message: noisy } }));
    const error = await failureOf(providerFor(server).provider.generate(baseRequest, signal()));
    assert.ok(!error.message.includes(KEY));
    assert.ok(!error.message.includes("sk-proj"));
    assert.ok(Array.from(error.message).every((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f), "no control characters or newlines");
    assert.match(error.message, /^OpenAI API error \(HTTP 500\): line1 line2 \[redacted\] red /);
    assert.ok(error.message.endsWith("…"));
    assert.ok(error.message.length < 400);
  });

  void it("redacts a key split by control characters", async () => {
    const split = `${KEY.slice(0, 12)}\u0001${KEY.slice(12)}`;
    server.expect(json(500, { error: { message: `see ${split}` } }));
    const error = await failureOf(providerFor(server).provider.generate(baseRequest, signal()));
    assert.ok(!error.message.includes(KEY.slice(12)));
  });

  void it("maps a refused connection to kind 7 without SDK text", async () => {
    const dead = await Loopback.start();
    const { url } = dead;
    await dead.close();
    const { provider } = providerFor(dead, {}, KEY, url);
    const error = await failureOf(provider.generate(baseRequest, signal()));
    assert.equal(error.kind, "connection");
    assert.equal(error.message, "Could not connect to OpenAI. Check your network connection.");
    assert.ok(!error.message.includes("127.0.0.1"));
  });

  void it("maps a stalled response to kind 6 (timeout), not to cancellation", async () => {
    const reached = deferred();
    server.expect(() => {
      reached.resolve(); // never answers
    });
    const { provider } = providerFor(server, { generationTimeoutMs: 80 });
    const controller = new AbortController();
    const error = await failureOf(provider.generate(baseRequest, controller.signal));
    await reached.promise;
    assert.equal(error.kind, "timeout");
    assert.equal(controller.signal.aborted, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  void it("covers the body read with the timeout", async () => {
    server.expect((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"status":"completed",'); // headers sent, body never finished
    });
    const { provider } = providerFor(server, { generationTimeoutMs: 80 });
    const error = await failureOf(provider.generate(baseRequest, signal()));
    assert.equal(error.kind, "timeout");
  });
});

void describe("implicit reasoning fallback", () => {
  const builtIn: GenerationRequest = { ...baseRequest, reasoning: { effort: "none", explicit: false, source: "builtin" } };
  const rejection = (param: string | null, message = "Unsupported parameter") =>
    json(400, { error: { message, type: "invalid_request_error", param, code: "unsupported_parameter" } });

  void it("retries once without reasoning when a built-in default is rejected, then remembers the model", async () => {
    server.expect(rejection("reasoning.effort"), json(200, completedBody("fallback ok")), json(200, completedBody("third")));
    const { provider } = providerFor(server);
    const request: GenerationRequest = { ...builtIn, maxOutputTokens: 50, instructions: "Be brief." };
    assert.equal(completedText(await provider.generate(request, signal())), "fallback ok");
    assert.equal(server.requests.length, 2);
    const [first, second] = server.requests.map((r) => bodyOf(r));
    assert.ok(first && second);
    assert.deepEqual(first.reasoning, { effort: "none" });
    assert.ok(!("reasoning" in second));
    const expectedSecond = { ...first };
    Reflect.deleteProperty(expectedSecond, "reasoning");
    assert.deepEqual(second, expectedSecond, "all other fields are identical");

    assert.equal(completedText(await provider.generate(request, signal())), "third");
    assert.equal(server.requests.length, 3);
    assert.ok(!("reasoning" in bodyOf(server.requests[2] ?? { body: "{}" })));

    const caps = await provider.getCapabilities("gpt-6-luna", signal());
    assert.deepEqual(caps.reasoning, { known: true, values: [], allowsModelDefault: true });
  });

  void it("accepts the bare 'reasoning' parameter name", async () => {
    server.expect(rejection("reasoning"), json(200, completedBody("ok")));
    await providerFor(server).provider.generate(builtIn, signal());
    assert.equal(server.requests.length, 2);
  });

  void it("never suppresses a later explicit choice and never retries it", async () => {
    server.expect(rejection("reasoning.effort"), json(200, completedBody("ok")), rejection("reasoning.effort", "nope"));
    const { provider } = providerFor(server);
    await provider.generate(builtIn, signal()); // marks the model
    const explicit: GenerationRequest = { ...baseRequest, reasoning: { effort: "high", explicit: true, source: "cli" } };
    const error = await failureOf(provider.generate(explicit, signal()));
    assert.equal(server.requests.length, 3, "explicit request was sent with reasoning and not retried");
    assert.deepEqual(bodyOf(server.requests[2] ?? { body: "{}" }).reasoning, { effort: "high" });
    assert.equal(error.kind, "api");
    assert.match(error.message, /^gpt-6-luna does not accept reasoning effort 'high' \(OpenAI API error \(HTTP 400\): nope\)\./);
  });

  void it("marks rejection per exact model", async () => {
    server.expect(rejection("reasoning.effort"), json(200, completedBody("a")), json(200, completedBody("b")));
    const { provider } = providerFor(server);
    await provider.generate(builtIn, signal());
    await provider.generate({ ...builtIn, model: "gpt-5.1" }, signal());
    assert.deepEqual(bodyOf(server.requests[2] ?? { body: "{}" }).reasoning, { effort: "none" });
  });

  void it("does not retry on generic 400s, other parameters, or messages that merely mention reasoning", async () => {
    const cases = [
      rejection(null, "reasoning is not supported"),
      rejection("model", "reasoning model missing"),
      rejection("reasoning_effort"),
      json(400, { error: { message: "reasoning" } }),
    ];
    for (const responder of cases) {
      server.requests.length = 0;
      server.expect(responder);
      const error = await failureOf(providerFor(server).provider.generate(builtIn, signal()));
      assert.equal(server.requests.length, 1);
      assert.equal(error.kind, "api");
    }
  });

  void it("does not retry 401, 429, 5xx, or a refused connection", async () => {
    for (const status of [401, 429, 500]) {
      server.requests.length = 0;
      server.expect(json(status, { error: { message: "x", param: "reasoning.effort" } }));
      await failureOf(providerFor(server).provider.generate(builtIn, signal()));
      assert.equal(server.requests.length, 1, String(status));
    }
  });

  void it("does not retry when the request had no effort", async () => {
    server.expect(rejection("reasoning.effort"));
    await failureOf(providerFor(server).provider.generate(baseRequest, signal()));
    assert.equal(server.requests.length, 1);
  });

  void it("checks cancellation before falling back", async () => {
    const controller = new AbortController();
    server.expect((request, response, raw) => {
      controller.abort(); // the caller cancels while the rejection is in flight
      rejection("reasoning.effort")(request, response, raw);
    });
    await assert.rejects(providerFor(server).provider.generate(builtIn, controller.signal), isAbortError);
    assert.equal(server.requests.length, 1);
  });

  void it("reports a rejection that persists after the fallback", async () => {
    server.expect(rejection("reasoning.effort"), json(500, { error: { message: "down" } }));
    const error = await failureOf(providerFor(server).provider.generate(builtIn, signal()));
    assert.equal(server.requests.length, 2);
    assert.match(error.message, /HTTP 500/);
  });
});

void describe("cancellation", () => {
  void it("rejects before any work when the signal is already aborted, whatever the reason", async () => {
    const reasons: readonly unknown[] = [undefined, new Error("custom"), "text", 7, new ProviderError("x", "timeout")];
    for (const reason of reasons) {
      const controller = new AbortController();
      controller.abort(reason);
      const { provider, keyReads, apiCreations } = providerFor(server);
      await assert.rejects(provider.generate(baseRequest, controller.signal), (error: unknown) => {
        return isAbortError(error) && !(error instanceof ProviderError) && error !== reason;
      });
      assert.equal(keyReads(), 0);
      assert.equal(apiCreations(), 0);
    }
    assert.equal(server.requests.length, 0);
  });

  void it("rejects when aborted immediately after the call, and cleans up its listener", async () => {
    // No responder is queued: whether the request reaches the server before the abort is not asserted.
    const controller = new AbortController();
    const { provider } = providerFor(server);
    const pending = provider.generate(baseRequest, controller.signal);
    controller.abort();
    await assert.rejects(pending, isAbortError);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  void it("aborts a request in flight, closes the server-side request, and normalizes the reason", async () => {
    const reasons: readonly unknown[] = [new Error("custom"), "text", undefined];
    for (const reason of reasons) {
      const reached = deferred();
      const closed = deferred();
      server.expect((_request, _response, raw) => {
        raw.socket.once("close", () => {
          closed.resolve();
        });
        reached.resolve();
      });
      const controller = new AbortController();
      const pending = providerFor(server).provider.generate(baseRequest, controller.signal);
      await reached.promise;
      controller.abort(reason);
      await assert.rejects(pending, (error: unknown) => isAbortError(error) && error !== reason);
      await closed.promise; // the connection was torn down
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  });

  void it("aborts while the response body is being read", async () => {
    const reached = deferred();
    server.expect((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"status":"comp');
      reached.resolve();
    });
    const controller = new AbortController();
    const pending = providerFor(server).provider.generate(baseRequest, controller.signal);
    await reached.promise;
    controller.abort(new Error("while reading"));
    await assert.rejects(pending, (error: unknown) => isAbortError(error) && !(error instanceof ProviderError));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  void it("lets abort win over a simultaneous timeout", async () => {
    const reached = deferred();
    server.expect(() => {
      reached.resolve();
    });
    const controller = new AbortController();
    const pending = providerFor(server, { generationTimeoutMs: 60_000 }).provider.generate(baseRequest, controller.signal);
    await reached.promise;
    controller.abort();
    await assert.rejects(pending, isAbortError);
  });

  void it("removes listeners after success and after a provider error", async () => {
    server.expect(json(200, completedBody("ok")), json(500, { error: { message: "x" } }));
    const controller = new AbortController();
    const { provider } = providerFor(server);
    await provider.generate(baseRequest, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await failureOf(provider.generate(baseRequest, controller.signal));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});
