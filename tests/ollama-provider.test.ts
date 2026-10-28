import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { ProviderError, isAbortError } from "../src/domain/errors.js";
import type { GenerationRequest } from "../src/domain/generation.js";
import type { ModelCapabilities } from "../src/domain/settings.js";
import { deferred } from "./helpers/deferred.js";
import { Loopback, json } from "./helpers/loopback.js";
import type { Responder } from "./helpers/loopback.js";
import { baseRequest, bodyOf, chat, paths, providerFor, show, tag, tags } from "./helpers/ollama.js";

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
const aborted = (reason?: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};
const request = (extra: Partial<GenerationRequest> = {}): GenerationRequest => ({ ...baseRequest, ...extra });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  return assert.fail("expected a rejection");
}

function providerError(error: unknown, kind: string): ProviderError {
  assert.ok(error instanceof ProviderError, String(error));
  assert.equal(error.kind, kind, error.message);
  return error;
}

function noPull(): void {
  assert.deepEqual(
    paths(server).filter((line) => /pull|create|delete|copy|push/.test(line)),
    [],
  );
  assert.deepEqual(server.unexpected, []);
}

const thinkingShow = (values: unknown[], extra: Record<string, unknown> = {}): Responder =>
  show({ capabilities: ["completion", "thinking"], thinking: { values, ...extra } });

void describe("discovery", () => {
  void it("keeps Ollama's order, defaults to the first selectable model, and caches", async () => {
    server.expect(tags(tag("zeta:latest"), tag("alpha:latest"), tag("emb", { capabilities: ["embedding"] })));
    const provider = providerFor(server);
    assert.equal(server.requests.length, 0, "constructor does no I/O");
    assert.deepEqual((await provider.listModels(signal())).map((model) => model.id), ["zeta:latest", "alpha:latest"]);
    assert.equal(await provider.defaultModel(signal()), "zeta:latest");
    await provider.listModels(signal());
    assert.deepEqual(paths(server), ["GET /api/tags"]);
    const [first] = server.requests;
    assert.equal(first?.body, "");
  });

  void it("parses entries: details summary, context length, capabilities, model/name fallback", async () => {
    server.expect(
      tags(
        tag("a", { model: "", name: "a-name", capabilities: ["completion", 7, "tools"], details: { parameter_size: "4B", quantization_level: "Q4_K_M", context_length: 8192 } }),
        { model: "b" },
        tag("c", { capabilities: [], details: { context_length: 0 } }),
        tag("d", { details: { context_length: 1.5 } }),
      ),
    );
    const models = await providerFor(server).listModels(signal());
    assert.deepEqual(models, [
      { id: "a-name", remote: false, capabilities: ["completion", "tools"], details: "4B Q4_K_M", contextLength: 8192 },
      { id: "b", remote: false },
      // capabilities: [] is confirmed-empty, so "c" lacks completion and is hidden
      { id: "d", remote: false },
    ]);
  });

  void it("hides cloud and non-chat models, and reports no usable models", async () => {
    server.expect(
      tags(
        tag("glm-4.7:cloud"),
        tag("x:31b-cloud"),
        tag("plain", { remote_host: "https://ollama.com" }),
        tag("plain2", { remote_model: "up" }),
        tag("emb", { capabilities: ["embedding"] }),
      ),
    );
    const provider = providerFor(server);
    assert.deepEqual(await provider.listModels(signal()), []);
    providerError(await rejection(provider.defaultModel(signal())), "api");
    server.expect(tags());
    const availability = await provider.checkAvailability(signal());
    assert.equal(availability.available, false);
    assert.match(availability.message, /No local Ollama models are installed .* ollama pull <model>/);
    noPull();
  });

  void it("treats an empty remote marker as local", async () => {
    server.expect(tags(tag("local", { remote_host: "", remote_model: null })));
    assert.deepEqual((await providerFor(server).listModels(signal())).map((model) => model.id), ["local"]);
  });

  void it("rejects malformed tags replies with safe API errors and never caches them", async () => {
    const provider = providerFor(server);
    const bad: unknown[] = [[], "x", null, { models: "x" }, { models: [1] }, { models: [{}] }, { models: [{ name: "" }] }, {}];
    for (const body of bad) {
      server.expect(json(200, body));
      providerError(await rejection(provider.listModels(signal())), "api");
    }
    server.expect(tags(tag("ok")));
    assert.deepEqual((await provider.listModels(signal())).map((model) => model.id), ["ok"]);
  });

  void it("checkAvailability always refreshes, reports provider errors, and propagates cancellation", async () => {
    const provider = providerFor(server);
    server.expect(tags(tag("a")), tags(tag("a")), json(500, { error: "boom" }));
    assert.deepEqual(await provider.checkAvailability(signal()), { available: true, message: "" });
    assert.deepEqual(await provider.checkAvailability(signal()), { available: true, message: "" });
    const failed = await provider.checkAvailability(signal());
    assert.equal(failed.available, false);
    assert.equal(failed.message, "Ollama API error (HTTP 500): boom");
    assert.ok(isAbortError(await rejection(provider.checkAvailability(aborted()))));
  });
});

void describe("model checks", () => {
  void it("refuses cloud-like IDs before any request", async () => {
    const provider = providerFor(server);
    for (const model of ["glm-4.7:cloud", "gemma4:31b-cloud", "a/b:cloud"]) {
      providerError(await rejection(provider.getCapabilities(model, signal())), "api");
      providerError(await rejection(provider.generate(request({ model }), signal())), "api");
    }
    assert.equal(server.requests.length, 0);
  });

  void it("refuses a remote tags entry without show or chat", async () => {
    server.expect(tags(tag("sneaky", { remote_host: "https://x" })));
    const error = providerError(await rejection(providerFor(server).generate(request({ model: "sneaky" }), signal())), "api");
    assert.match(error.message, /cloud model that runs on a remote service/);
    assert.deepEqual(paths(server), ["GET /api/tags"]);
  });

  void it("refreshes tags once for a missing model, then gives the manual pull hint", async () => {
    server.expect(tags(tag("other")), tags(tag("other")));
    const error = providerError(await rejection(providerFor(server).generate(request({ model: "qwen3.5:4b" }), signal())), "api");
    assert.equal(error.message, "Ollama model 'qwen3.5:4b' is not installed locally. Install it yourself with: ollama pull qwen3.5:4b");
    assert.deepEqual(paths(server), ["GET /api/tags", "GET /api/tags"]);
    noPull();
  });

  void it("finds a model installed after the first discovery", async () => {
    server.expect(tags(tag("old")), tags(tag("old"), tag("new", { capabilities: ["completion"] })));
    const provider = providerFor(server);
    await provider.listModels(signal());
    const capabilities = await provider.getCapabilities("new", signal());
    assert.deepEqual(capabilities.reasoning, { known: true, values: [], allowsModelDefault: true });
    assert.deepEqual(paths(server), ["GET /api/tags", "GET /api/tags"]);
  });

  void it("does not alias IDs: no :latest, no case folding", async () => {
    server.expect(tags(tag("Llama3:latest")), tags(tag("Llama3:latest")));
    const provider = providerFor(server);
    providerError(await rejection(provider.getCapabilities("llama3", signal())), "api");
    server.expect(tags(tag("Llama3:latest")));
    providerError(await rejection(provider.getCapabilities("llama3:latest", signal())), "api");
  });

  void it("never chats or shows an embedding-only model, even when requested explicitly", async () => {
    server.expect(tags(tag("emb", { capabilities: ["embedding", "thinking"] })));
    const provider = providerFor(server);
    const error = providerError(await rejection(provider.generate(request({ model: "emb" }), signal())), "api");
    assert.match(error.message, /not a chat model/);
    providerError(await rejection(provider.getCapabilities("emb", signal())), "api");
    assert.deepEqual(paths(server), ["GET /api/tags"]);
  });

  void it("checks show capabilities when tags omit them, and refuses non-completion models", async () => {
    server.expect(tags(tag("legacy")), show({ capabilities: ["embedding"] }));
    const provider = providerFor(server);
    providerError(await rejection(provider.generate(request({ model: "legacy" }), signal())), "api");
    assert.deepEqual(paths(server), ["GET /api/tags", "POST /api/show"]);
    assert.deepEqual(bodyOf(server.requests[1] ?? never()), { model: "legacy" });
  });
});

function never(): never {
  throw new Error("missing request");
}

void describe("capabilities and thinking metadata", () => {
  async function capabilitiesFor(entry: Record<string, unknown>, shown?: Responder): Promise<ModelCapabilities> {
    server.expect(tags(entry));
    if (shown !== undefined) {
      server.expect(shown);
    }
    const result = await providerFor(server).getCapabilities("m1", signal());
    assert.equal(server.pending, 0);
    return result;
  }

  void it("tags capabilities without thinking: confirmed non-thinking, no show request", async () => {
    const result = await capabilitiesFor(tag("m1", { capabilities: ["completion"] }));
    assert.deepEqual(result, { reasoning: { known: true, values: [], allowsModelDefault: true } });
    assert.deepEqual(paths(server), ["GET /api/tags"]);
  });

  void it("off/on values: default off, no selectable model default; model default is metadata", async () => {
    const result = await capabilitiesFor(tag("m1", { capabilities: ["completion", "thinking"] }), thinkingShow([false, true, true], { default: true }));
    assert.deepEqual(result.reasoning, { known: true, values: ["off", "on"], allowsModelDefault: false, defaultValue: "off", modelDefault: "on" });
  });

  void it("named levels keep order, deduplicate, allow model default and have no application default", async () => {
    const result = await capabilitiesFor(tag("m1"), thinkingShow(["low", "medium", "low", "high", ""], { default: "medium" }));
    assert.deepEqual(result.reasoning, { known: true, values: ["low", "medium", "high"], allowsModelDefault: true, modelDefault: "medium" });
  });

  void it("named levels together with off make off the default", async () => {
    const result = await capabilitiesFor(tag("m1"), thinkingShow([false, "low", "high"]));
    assert.deepEqual(result.reasoning, { known: true, values: ["off", "low", "high"], allowsModelDefault: false, defaultValue: "off" });
  });

  void it("the thinking capability without values falls back to legacy off/on", async () => {
    const result = await capabilitiesFor(tag("m1", { capabilities: ["completion", "thinking"] }), show({ capabilities: ["completion", "thinking"] }));
    assert.deepEqual(result.reasoning, { known: true, values: ["off", "on"], allowsModelDefault: false, defaultValue: "off" });
  });

  void it("[false] means the model does not support thinking", async () => {
    const result = await capabilitiesFor(tag("m1"), show({ capabilities: ["completion"], thinking: { values: [false] } }));
    assert.deepEqual(result.reasoning, { known: true, values: [], allowsModelDefault: true });
  });

  void it("unknown metadata is distinct from a confirmed empty set", async () => {
    const result = await capabilitiesFor(tag("m1"), show({}));
    assert.deepEqual(result.reasoning, { known: false, values: [], allowsModelDefault: true });
    const confirmed = await capabilitiesFor(tag("m1"), show({ capabilities: ["completion"] }));
    assert.deepEqual(confirmed.reasoning, { known: true, values: [], allowsModelDefault: true });
  });

  void it("does not infer thinking from the model name", async () => {
    server.expect(tags(tag("deepseek-r1:latest", { capabilities: ["completion"] })));
    const result = await providerFor(server).getCapabilities("deepseek-r1:latest", signal());
    assert.equal(result.reasoning.values.length, 0);
  });

  void it("ignores malformed optional metadata", async () => {
    const result = await capabilitiesFor(tag("m1"), show({ capabilities: "x", thinking: { values: "high", default: 3 } }));
    assert.equal(result.reasoning.known, false);
  });

  void it("uses tags context_length as the project ceiling and leaves it unknown otherwise", async () => {
    const withLimit = await capabilitiesFor(tag("m1", { capabilities: ["completion"], details: { context_length: 4096 } }));
    assert.equal(withLimit.maxOutputTokensLimit, 4096);
    const without = await capabilitiesFor(tag("m1", { capabilities: ["completion"], details: { family: "llama", parameter_size: "4B" }, model_info: { "x.context_length": 99 } }));
    assert.equal(without.maxOutputTokensLimit, undefined);
    assert.ok(!("maxOutputTokensLimit" in without));
  });

  void it("rejects a malformed show reply", async () => {
    server.expect(tags(tag("m1")), json(200, []));
    providerError(await rejection(providerFor(server).getCapabilities("m1", signal())), "api");
  });
});

void describe("show caching and invalidation", () => {
  void it("requests show once per model for capabilities, thinking and chat", async () => {
    server.expect(tags(tag("m1")), thinkingShow(["low", "high"]), chat("a"), chat("b"));
    const provider = providerFor(server);
    await provider.getCapabilities("m1", signal());
    await provider.getCapabilities("m1", signal());
    await provider.generate(request(), signal());
    await provider.generate(request(), signal());
    assert.deepEqual(paths(server), ["GET /api/tags", "POST /api/show", "POST /api/chat", "POST /api/chat"]);
  });

  void it("drops cached show data for a model whose tags entry changed on refresh", async () => {
    server.expect(
      tags(tag("m1", { digest: "one" }), tag("m2", { digest: "x" })),
      thinkingShow(["low"]),
      tags(tag("m1", { digest: "two" }), tag("m2", { digest: "x" })),
      thinkingShow(["low", "high"]),
    );
    const provider = providerFor(server);
    const first = await provider.getCapabilities("m1", signal());
    assert.deepEqual(first.reasoning.values, ["low"]);
    await provider.checkAvailability(signal()); // refresh
    const second = await provider.getCapabilities("m1", signal());
    assert.deepEqual(second.reasoning.values, ["low", "high"]);
    assert.deepEqual(paths(server), ["GET /api/tags", "POST /api/show", "GET /api/tags", "POST /api/show"]);
  });
});

void describe("generate: request mapping", () => {
  async function sent(entry: Record<string, unknown>, shown: Responder | undefined, req: Partial<GenerationRequest>): Promise<Record<string, unknown>> {
    server.expect(tags(entry));
    if (shown !== undefined) {
      server.expect(shown);
    }
    server.expect(chat("ok"));
    await providerFor(server).generate(request(req), signal());
    const last = server.requests[server.requests.length - 1] ?? never();
    assert.equal(last.method, "POST");
    assert.equal(last.path, "/api/chat");
    assert.equal(last.headers["content-type"], "application/json");
    return bodyOf(last);
  }
  const plain = tag("m1", { capabilities: ["completion"] });
  const effort = (value: string | undefined, explicit = true): GenerationRequest["reasoning"] =>
    value === undefined ? { explicit, source: "cli" } : { effort: value, explicit, source: "cli" };

  void it("sends exactly model, messages and stream:false by default", async () => {
    const body = await sent(plain, undefined, {});
    assert.deepEqual(body, { model: "m1", messages: [{ role: "user", content: "hi" }], stream: false });
  });

  void it("sends instructions as a leading system message, keeps history order, and num_predict only", async () => {
    const body = await sent(plain, undefined, {
      instructions: "Be brief.",
      maxOutputTokens: 77,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });
    assert.deepEqual(body, {
      model: "m1",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
      stream: false,
      options: { num_predict: 77 },
    });
    assert.ok(!("keep_alive" in body));
  });

  void it("sends think:false for the application default off on off/on models", async () => {
    const body = await sent(tag("m1"), thinkingShow([false, true]), { reasoning: effort("off", false) });
    assert.equal(body.think, false);
  });

  void it("maps off/none to false, on to true and named levels to the exact string", async () => {
    const levels = thinkingShow(["low", "high", false]);
    for (const [value, expected] of [["off", false], ["none", false], ["low", "low"], ["high", "high"]] as const) {
      const body = await sent(tag("m1"), levels, { reasoning: effort(value) });
      assert.equal(body.think, expected, value);
    }
    const onOff = thinkingShow([false, true]);
    assert.equal((await sent(tag("m1"), onOff, { reasoning: effort("on") })).think, true);
  });

  void it("omits think for model-default and for no choice", async () => {
    const levels = thinkingShow(["low", "high"]);
    assert.ok(!("think" in (await sent(tag("m1"), levels, { reasoning: effort(undefined) }))));
    assert.ok(!("think" in (await sent(tag("m1"), levels, { reasoning: effort(undefined, false) }))));
  });

  void it("omits think for a confirmed non-thinking model", async () => {
    const body = await sent(plain, undefined, { reasoning: effort("off", false) });
    assert.ok(!("think" in body));
  });

  void it("passes unknown-support values through without guessing an off/on mapping", async () => {
    assert.equal((await sent(tag("m1"), show({}), { reasoning: effort("high") })).think, "high");
    assert.equal((await sent(tag("m1"), show({}), { reasoning: effort("on") })).think, true);
    assert.equal((await sent(tag("m1"), show({}), { reasoning: effort("off") })).think, false);
    assert.ok(!("think" in (await sent(tag("m1"), show({}), { reasoning: effort(undefined, false) }))));
  });

  void it("rejects an explicit level outside confirmed support before chatting", async () => {
    server.expect(tags(tag("m1")), thinkingShow(["low", "high"]));
    const error = providerError(await rejection(providerFor(server).generate(request({ reasoning: effort("max") }), signal())), "api");
    assert.match(error.message, /does not support thinking level 'max'. Supported: low, high\./);
    assert.deepEqual(paths(server), ["GET /api/tags", "POST /api/show"]);
  });

  void it("snapshots the request before the first await", async () => {
    server.expect(tags(plain), chat("ok"));
    const messages = [{ role: "user" as const, content: "original" }];
    const pending = providerFor(server).generate({ ...baseRequest, messages }, signal());
    messages[0] = { role: "user", content: "mutated" };
    messages.push({ role: "user", content: "extra" });
    await pending;
    assert.deepEqual(bodyOf(server.requests[1] ?? never()).messages, [{ role: "user", content: "original" }]);
  });
});

void describe("generate: responses", () => {
  const plain = tag("m1", { capabilities: ["completion"] });
  async function outcomeOf(reply: Responder) {
    server.expect(tags(plain), reply);
    return providerFor(server).generate(request(), signal());
  }

  void it("returns completed text with exact usage and a derived total", async () => {
    const outcome = await outcomeOf(chat("Hello", { prompt_eval_count: 12, eval_count: 30 }));
    assert.deepEqual(outcome, { kind: "completed", result: { text: "Hello", usage: { inputTokens: 12n, outputTokens: 30n, totalTokens: 42n } } });
  });

  void it("keeps reported zeros, absent counts and unsafe or invalid values apart", async () => {
    const zero = await outcomeOf(chat("a", { prompt_eval_count: 0, eval_count: 0 }));
    assert.deepEqual(zero.kind === "completed" && zero.result.usage, { inputTokens: 0n, outputTokens: 0n, totalTokens: 0n });
    const onlyInput = await outcomeOf(chat("a", { prompt_eval_count: 5 }));
    assert.deepEqual(onlyInput.kind === "completed" && onlyInput.result.usage, { inputTokens: 5n });
    const none = await outcomeOf(chat("a"));
    assert.equal(none.kind === "completed" && "usage" in none.result, false);
    for (const bad of [-1, 1.5, "7", null, 2 ** 53, 1e30]) {
      const outcome = await outcomeOf(chat("a", { prompt_eval_count: bad, eval_count: 3 }));
      assert.deepEqual(outcome.kind === "completed" && outcome.result.usage, { outputTokens: 3n }, String(bad));
    }
    const edge = await outcomeOf(chat("a", { prompt_eval_count: Number.MAX_SAFE_INTEGER, eval_count: Number.MAX_SAFE_INTEGER }));
    assert.deepEqual(edge.kind === "completed" && edge.result.usage?.totalTokens, 18014398509481982n);
  });

  void it("allows an empty completed answer", async () => {
    const outcome = await outcomeOf(chat("", { eval_count: 4 }));
    assert.equal(outcome.kind === "completed" && outcome.result.text, "");
  });

  void it("done_reason length is incomplete, even with no text, and keeps usage", async () => {
    const withText = await outcomeOf(chat("part", { done_reason: "length", prompt_eval_count: 1, eval_count: 2 }));
    assert.deepEqual(withText, {
      kind: "incomplete",
      reason: "the max output token limit was reached",
      partialText: "part",
      usage: { inputTokens: 1n, outputTokens: 2n, totalTokens: 3n },
    });
    const empty = await outcomeOf(chat("", { done_reason: "length" }));
    assert.deepEqual(empty, { kind: "incomplete", reason: "the max output token limit was reached", partialText: "" });
  });

  void it("treats other done reasons as completed", async () => {
    for (const reason of ["stop", "load", "unload", undefined]) {
      const outcome = await outcomeOf(chat("a", { done_reason: reason }));
      assert.equal(outcome.kind, "completed");
    }
  });

  void it("fails for missing or false done, malformed content, error replies and non-objects", async () => {
    const bad: unknown[] = [
      { message: { content: "x" } },
      { message: { content: "x" }, done: false },
      { message: { content: "x" }, done: "true" },
      { done: true },
      { message: "x", done: true },
      { message: { content: 5 }, done: true },
      { message: { content: null }, done: true },
      [],
      "text",
      7,
      null,
      { error: "model failed to load" },
      { error: { code: 1 } },
      { error: "x", message: { content: "ok" }, done: true },
    ];
    for (const body of bad) {
      server.expect(tags(plain), json(200, body));
      providerError(await rejection(providerFor(server).generate(request(), signal())), "api");
    }
  });

  void it("reports invalid JSON as an API error, distinct from a truncated body", async () => {
    server.expect(tags(plain), (_request, response) => {
      response.end("{not json");
    });
    const error = providerError(await rejection(providerFor(server).generate(request(), signal())), "api");
    assert.equal(error.message, "Invalid response from Ollama: reply is not valid JSON.");
    server.expect(tags(plain), (_request, response) => {
      response.end("");
    });
    providerError(await rejection(providerFor(server).generate(request(), signal())), "api");
  });
});

void describe("generate: thinking separation", () => {
  const plain = tag("m1", { capabilities: ["completion"] });
  async function result(content: string, extra: Record<string, unknown> = {}) {
    server.expect(tags(plain), chat(content, extra));
    return providerFor(server).generate(request(), signal());
  }
  function reply(content: string, thinking?: unknown, extra: Record<string, unknown> = {}): Responder {
    return json(200, { message: { role: "assistant", content, ...(thinking === undefined ? {} : { thinking }) }, done: true, ...extra });
  }

  void it("keeps message.thinking out of the answer", async () => {
    server.expect(tags(plain), reply("Answer", "private thoughts"));
    const outcome = await providerFor(server).generate(request(), signal());
    assert.deepEqual(outcome, { kind: "completed", result: { text: "Answer", reasoning: "private thoughts" } });
  });

  void it("splits a complete leading think block, with leading whitespace, and trims what follows", async () => {
    const outcome = await result("  \n<think>\n why \n</think>\n\nThe answer <think>literal</think> stays");
    assert.deepEqual(outcome, { kind: "completed", result: { text: "The answer <think>literal</think> stays", reasoning: "why" } });
  });

  void it("prefers a nonblank thinking field over the inline block without duplicating", async () => {
    server.expect(tags(plain), reply("<think>inline</think>Answer", "field"));
    const outcome = await providerFor(server).generate(request(), signal());
    assert.deepEqual(outcome, { kind: "completed", result: { text: "Answer", reasoning: "field" } });
    server.expect(tags(plain), reply("<think>inline</think>Answer", "   "));
    const blank = await providerFor(server).generate(request(), signal());
    assert.deepEqual(blank, { kind: "completed", result: { text: "Answer", reasoning: "inline" } });
  });

  void it("does not strip think tags that are not leading", async () => {
    const outcome = await result("Intro <think>x</think> tail");
    assert.equal(outcome.kind === "completed" && outcome.result.text, "Intro <think>x</think> tail");
    const upper = await result("<THINK>x</THINK>y");
    assert.equal(upper.kind === "completed" && upper.result.text, "<THINK>x</THINK>y");
  });

  void it("never returns an unterminated think block as a completed answer", async () => {
    server.expect(tags(plain), reply("<think>secret reasoning that never ends"));
    const error = providerError(await rejection(providerFor(server).generate(request(), signal())), "api");
    assert.match(error.message, /reasoning block never ended/);
    assert.ok(!error.message.includes("secret"));
  });

  void it("an unterminated block with length is incomplete with no answer text", async () => {
    server.expect(tags(plain), reply("<think>secret reasoning", undefined, { done_reason: "length" }));
    const outcome = await providerFor(server).generate(request(), signal());
    assert.deepEqual(outcome, { kind: "incomplete", reason: "the max output token limit was reached", partialText: "" });
  });
});

void describe("HTTP errors", () => {
  const plain = tag("m1", { capabilities: ["completion"] });

  void it("adds the manual install hint to a chat 404 without installing", async () => {
    server.expect(tags(plain), json(404, { error: "model 'm1' not found" }));
    const error = providerError(await rejection(providerFor(server).generate(request(), signal())), "api");
    assert.equal(error.message, "Ollama model 'm1' was not found: model 'm1' not found. Install it yourself with: ollama pull m1");
    noPull();
  });

  void it("maps other statuses to API errors with capped, control-free details", async () => {
    const noisy = `\u001b[31mred\u001b[0m\n${"x".repeat(500)}`;
    server.expect(tags(plain), json(500, { error: noisy }));
    const error = providerError(await rejection(providerFor(server).generate(request(), signal())), "api");
    assert.ok(error.message.startsWith("Ollama API error (HTTP 500): red xxx"));
    assert.ok(error.message.length < 360);
    assert.ok(Array.from(error.message).every((char) => char.charCodeAt(0) >= 0x20), "no control characters");
    server.expect(tags(plain), (_request, response) => {
      response.statusCode = 503;
      response.end("plain text failure\n");
    });
    assert.equal(providerError(await rejection(providerFor(server).generate(request(), signal())), "api").message, "Ollama API error (HTTP 503): plain text failure");
    server.expect(tags(plain), (_request, response) => {
      response.statusCode = 502;
      response.end();
    });
    assert.equal(providerError(await rejection(providerFor(server).generate(request(), signal())), "api").message, "Ollama API error (HTTP 502): no details");
  });

  void it("does not follow redirects", async () => {
    server.expect(tags(plain), (_request, response) => {
      response.statusCode = 307;
      response.setHeader("location", "/elsewhere");
      response.end();
    });
    const error = providerError(await rejection(providerFor(server).generate(request(), signal())), "api");
    assert.match(error.message, /HTTP 307/);
    assert.equal(server.requests.length, 2);
  });

  void it("does not retry a failed chat request", async () => {
    server.expect(tags(plain), json(500, { error: "x" }));
    await rejection(providerFor(server).generate(request(), signal()));
    assert.equal(paths(server).filter((line) => line === "POST /api/chat").length, 1);
  });

  void it("does not leak prompts or request bodies into errors", async () => {
    server.expect(tags(plain), json(500, { error: "oops" }));
    const secretPrompt = "my private prompt 12345";
    const error = providerError(
      await rejection(providerFor(server).generate(request({ messages: [{ role: "user", content: secretPrompt }] }), signal())),
      "api",
    );
    assert.ok(!error.message.includes(secretPrompt));
  });
});

void describe("connection failures and timeouts", () => {
  const plain = tag("m1", { capabilities: ["completion"] });

  void it("classifies a refused connection as kind connection without exposing more than the origin", async () => {
    const dead = await Loopback.start();
    const origin = dead.origin;
    await dead.close();
    const error = providerError(await rejection(providerFor(server, { baseUrl: `${origin}/prefix` }).listModels(signal())), "connection");
    assert.equal(error.message, `Could not connect to Ollama at ${origin}. Is the Ollama service running?`);
  });

  void it("classifies a reset connection as kind connection", async () => {
    server.expect((_request, _response, raw) => {
      raw.socket.destroy();
    });
    providerError(await rejection(providerFor(server).listModels(signal())), "connection");
  });

  void it("classifies a body cut off before content-length as kind connection, not an invalid reply", async () => {
    server.expect(tags(plain), (_request, response, raw) => {
      response.writeHead(200, { "content-length": "500", "content-type": "application/json" });
      response.write('{"message":{"content":"par', () => {
        raw.socket.destroy();
      });
    });
    const error = providerError(await rejection(providerFor(server).generate(request(), signal())), "connection");
    assert.match(error.message, /^Connection to Ollama at http:\/\/127\.0\.0\.1:\d+ (failed|ended)/);
  });

  void it("classifies a truncated chunked body as kind connection", async () => {
    server.expect((_request, response, raw) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"models":[', () => {
        raw.socket.destroy();
      });
    });
    providerError(await rejection(providerFor(server).listModels(signal())), "connection");
  });

  void it("times out discovery while waiting for headers and releases the socket", async () => {
    const closed = deferred();
    server.expect((_request, _response, raw) => {
      raw.socket.once("close", () => {
        closed.resolve();
      });
    });
    const error = providerError(await rejection(providerFor(server, { discoveryTimeoutMs: 40 }).listModels(signal())), "timeout");
    assert.equal(error.message, "Request to Ollama timed out.");
    await closed.promise;
  });

  void it("the deadline also covers reading the body", async () => {
    const closed = deferred();
    server.expect(tags(plain), (_request, response, raw) => {
      raw.socket.once("close", () => {
        closed.resolve();
      });
      response.writeHead(200, { "content-length": "100", "content-type": "application/json" });
      response.write("{");
    });
    providerError(await rejection(providerFor(server, { chatTimeoutMs: 60 }).generate(request(), signal())), "timeout");
    await closed.promise;
  });

  void it("uses separate chat and discovery timeouts (a slow chat is not cut by the short discovery deadline)", async () => {
    server.expect(tags(plain), (_request, response) => {
      setTimeout(() => {
        response.end(JSON.stringify({ message: { content: "slow" }, done: true }));
      }, 120);
    });
    const outcome = await providerFor(server, { discoveryTimeoutMs: 40, chatTimeoutMs: 5_000 }).generate(request(), signal());
    assert.equal(outcome.kind, "completed");
  });
});

void describe("cancellation", () => {
  const plain = tag("m1", { capabilities: ["completion"] });

  void it("pre-aborted signals reject with AbortError for every method, with any reason, and send nothing", async () => {
    const provider = providerFor(server);
    for (const reason of [undefined, "text", new Error("custom"), 42, new DOMException("t", "TimeoutError")]) {
      const gone = aborted(reason);
      assert.ok(isAbortError(await rejection(provider.generate(request(), gone))));
      assert.ok(isAbortError(await rejection(provider.listModels(gone))));
      assert.ok(isAbortError(await rejection(provider.checkAvailability(gone))));
      assert.ok(isAbortError(await rejection(provider.defaultModel(gone))));
      assert.ok(isAbortError(await rejection(provider.getCapabilities("m1", gone))));
      const iterator = provider.stream(request(), gone)[Symbol.asyncIterator]();
      assert.ok(isAbortError(await rejection(iterator.next())));
    }
    assert.equal(server.requests.length, 0);
  });

  void it("cached paths honor aborted signals and a signal aborted right after the call starts", async () => {
    server.expect(tags(plain));
    const provider = providerFor(server);
    await provider.listModels(signal());
    assert.ok(isAbortError(await rejection(provider.listModels(aborted("why")))));
    const controller = new AbortController();
    const pending = provider.listModels(controller.signal);
    controller.abort(new Error("custom"));
    assert.ok(isAbortError(await rejection(pending)));
    const again = new AbortController();
    const caps = provider.getCapabilities("m1", again.signal);
    again.abort("late");
    assert.ok(isAbortError(await rejection(caps)));
    assert.equal(server.requests.length, 1);
  });

  void it("cached show path honors cancellation", async () => {
    server.expect(tags(tag("m1")), show({}));
    const provider = providerFor(server);
    await provider.getCapabilities("m1", signal());
    const controller = new AbortController();
    const pending = provider.getCapabilities("m1", controller.signal);
    controller.abort();
    assert.ok(isAbortError(await rejection(pending)));
  });

  void it("abort while waiting for headers rejects with AbortError and closes the connection", async () => {
    const reached = deferred();
    const closed = deferred();
    server.expect(tags(plain), (_request, _response, raw) => {
      raw.socket.once("close", () => {
        closed.resolve();
      });
      reached.resolve();
    });
    const controller = new AbortController();
    const pending = providerFor(server).generate(request(), controller.signal);
    await reached.promise;
    controller.abort(new Error("custom reason"));
    const error = await rejection(pending);
    assert.ok(isAbortError(error));
    assert.ok(!(error instanceof ProviderError));
    await closed.promise;
  });

  void it("abort while reading the body rejects with AbortError and closes the connection", async () => {
    const flushed = deferred();
    const closed = deferred();
    server.expect(tags(plain), (_request, response, raw) => {
      raw.socket.once("close", () => {
        closed.resolve();
      });
      response.writeHead(200, { "content-length": "100", "content-type": "application/json" });
      response.write("{", () => {
        flushed.resolve();
      });
    });
    const controller = new AbortController();
    const pending = providerFor(server).generate(request(), controller.signal);
    await flushed.promise;
    controller.abort("anything");
    assert.ok(isAbortError(await rejection(pending)));
    await closed.promise;
  });

  void it("cancelled discovery does not populate the cache and chat does not follow", async () => {
    const reached = deferred();
    const closed = deferred();
    server.expect((_request, _response, raw) => {
      raw.socket.once("close", () => {
        closed.resolve();
      });
      reached.resolve();
    });
    const provider = providerFor(server);
    const controller = new AbortController();
    const pending = provider.generate(request(), controller.signal);
    await reached.promise;
    controller.abort();
    assert.ok(isAbortError(await rejection(pending)));
    await closed.promise;
    assert.deepEqual(paths(server), ["GET /api/tags"]);
    // A later call must discover again: nothing was cached by the cancelled one.
    server.expect(tags(plain), chat("ok"));
    await provider.generate(request(), signal());
    assert.deepEqual(paths(server), ["GET /api/tags", "GET /api/tags", "POST /api/chat"]);
  });

  void it("an abort before the connection is made sends nothing and leaves no cache", async () => {
    const provider = providerFor(server);
    const controller = new AbortController();
    const pending = provider.listModels(controller.signal);
    controller.abort();
    assert.ok(isAbortError(await rejection(pending)));
    server.expect(tags(plain));
    assert.equal((await provider.listModels(signal())).length, 1);
  });

  void it("a late successful reply is discarded when the signal aborts during transport", async () => {
    const replied = deferred();
    server.expect(tags(plain), (_request, response) => {
      response.end(JSON.stringify({ message: { content: "late" }, done: true }), () => {
        replied.resolve();
      });
    });
    const controller = new AbortController();
    const pending = providerFor(server).generate(request(), controller.signal);
    await replied.promise;
    controller.abort();
    // Either the abort wins or the reply had already settled; it must never be a ProviderError.
    const outcome = await pending.then(
      (value) => value,
      (error: unknown) => error,
    );
    assert.ok(!(outcome instanceof ProviderError));
  });

  void it("stream is a lazy single failed event that touches no network", async () => {
    const provider = providerFor(server);
    const stream = provider.stream(request(), signal());
    assert.equal(server.requests.length, 0);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "failed");
    assert.equal(server.requests.length, 0);
  });
});
