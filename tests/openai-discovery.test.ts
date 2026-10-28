import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { after, before, beforeEach, describe, it } from "node:test";

import { ProviderError, isAbortError } from "../src/domain/errors.js";
import type { StreamEvent } from "../src/domain/generation.js";
import type { Provider } from "../src/domain/provider.js";
import { OpenAIProvider } from "../src/providers/openai/provider.js";
import { deferred } from "./helpers/deferred.js";
import { Loopback, json } from "./helpers/loopback.js";
import { KEY, baseRequest, providerFor } from "./helpers/openai.js";

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

async function drain(events: AsyncIterable<StreamEvent>): Promise<number> {
  const seen: StreamEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen.length;
}

void describe("listModels", () => {
  void it("lists text-capable IDs: validated, deduplicated, sorted, from a single GET", async () => {
    server.expect(
      json(200, {
        object: "list",
        has_more: true, // ignored: the endpoint is not paginated
        data: [
          { id: "gpt-5" },
          { id: "text-embedding-3-small" },
          { id: "gpt-4o" },
          { id: "gpt-5" },
          { id: "whisper-1" },
          { id: "gpt-4o-mini-tts" },
          { id: "dall-e-3" },
          { id: "gpt-4o-audio-preview" },
          { id: "gpt-image-1" },
          { id: "omni-moderation-latest" },
          { id: "gpt-4o-transcribe" },
          { id: "gpt-realtime" },
          { id: "" },
          { id: 5 },
          { nope: true },
          null,
          "str",
          { id: "o3" },
        ],
      }),
    );
    const { provider } = providerFor(server);
    const models = await provider.listModels(signal());
    assert.deepEqual(
      models.map((m) => m.id),
      ["gpt-4o", "gpt-5", "o3"],
    );
    assert.ok(models.every((m) => !m.remote));
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests.at(0)?.method, "GET");
    assert.equal(server.requests.at(0)?.path, "/v1/models");
    assert.equal(server.requests.at(0)?.headers.authorization, `Bearer ${KEY}`);
  });

  void it("caches only successful results per provider instance", async () => {
    server.expect(json(500, { error: { message: "down" } }), json(200, { data: [{ id: "a" }] }));
    const { provider } = providerFor(server);
    await assert.rejects(provider.listModels(signal()), ProviderError);
    assert.equal((await provider.listModels(signal())).length, 1);
    assert.equal((await provider.listModels(signal())).length, 1);
    assert.equal(server.requests.length, 2, "the third call used the cache");
    // A different instance has its own cache.
    server.expect(json(200, { data: [] }));
    assert.equal((await providerFor(server).provider.listModels(signal())).length, 0);
  });

  void it("rejects a non-array data field with a safe API error", async () => {
    for (const body of [{ data: "x" }, { data: { id: "a" } }, { data: 5 }]) {
      server.expect(json(200, body));
      await assert.rejects(
        providerFor(server).provider.listModels(signal()),
        (error: unknown) => error instanceof ProviderError && error.kind === "api",
      );
    }
  });

  void it("treats a null body as an invalid response and other shapeless bodies as an empty list (SDK Page behavior)", async () => {
    server.expect(json(200, null));
    await assert.rejects(
      providerFor(server).provider.listModels(signal()),
      (error: unknown) => error instanceof ProviderError && error.kind === "api",
    );
    for (const body of [[], { items: [] }, {}]) {
      server.expect(json(200, body));
      assert.deepEqual(await providerFor(server).provider.listModels(signal()), []);
    }
  });

  void it("maps errors with the shared rules and never retries", async () => {
    server.expect(json(401, { error: { message: "no" } }));
    await assert.rejects(providerFor(server).provider.listModels(signal()), (error: unknown) => {
      return error instanceof ProviderError && error.kind === "authentication";
    });
    server.expect(json(503, { error: { message: "busy" } }));
    await assert.rejects(providerFor(server).provider.listModels(signal()), ProviderError);
    assert.equal(server.requests.length, 2);
  });

  void it("uses its own short timeout", async () => {
    const reached = deferred();
    server.expect(() => {
      reached.resolve();
    });
    await assert.rejects(
      providerFor(server, { modelListTimeoutMs: 80 }).provider.listModels(signal()),
      (error: unknown) => error instanceof ProviderError && error.kind === "timeout",
    );
    await reached.promise;
  });

  void it("needs a key and is never an implicit prerequisite of generation", async () => {
    const { provider, keyReads } = providerFor(server, {}, null);
    await assert.rejects(provider.listModels(signal()), (error: unknown) => {
      return error instanceof ProviderError && error.kind === "missing_api_key";
    });
    assert.equal(keyReads(), 1);
    server.expect(json(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }] }));
    await providerFor(server).provider.generate(baseRequest, signal());
    assert.deepEqual(server.requests.map((r) => r.path), ["/v1/responses"]);
  });
});

void describe("checkAvailability", () => {
  void it("reports available after a successful listing", async () => {
    server.expect(json(200, { data: [{ id: "gpt-5" }] }));
    assert.deepEqual(await providerFor(server).provider.checkAvailability(signal()), { available: true, message: "" });
  });

  void it("turns provider failures into unavailable plus a safe message", async () => {
    const missing = await providerFor(server, {}, null).provider.checkAvailability(signal());
    assert.equal(missing.available, false);
    assert.match(missing.message, /OPENAI_API_KEY is not set/);
    server.expect(json(401, { error: { message: `leak ${KEY}` } }));
    const rejected = await providerFor(server).provider.checkAvailability(signal());
    assert.equal(rejected.available, false);
    assert.ok(!rejected.message.includes(KEY));
  });

  void it("keeps caller cancellation as AbortError", async () => {
    const controller = new AbortController();
    controller.abort(new Error("custom"));
    await assert.rejects(providerFor(server).provider.checkAvailability(controller.signal), isAbortError);
    const reached = deferred();
    server.expect(() => {
      reached.resolve();
    });
    const live = new AbortController();
    const pending = providerFor(server).provider.checkAvailability(live.signal);
    await reached.promise;
    live.abort("text");
    await assert.rejects(pending, isAbortError);
    assert.equal(getEventListeners(live.signal, "abort").length, 0);
  });
});

void describe("capabilities and default model", () => {
  const provider = new OpenAIProvider({
    getApiKey: () => assert.fail("capabilities must not read the key"),
    createApi: () => assert.fail("capabilities must not create the SDK client"),
  });

  void it("returns the project default model without key or network", async () => {
    assert.equal(await provider.defaultModel(signal()), "gpt-6-luna");
  });

  void it("derives application defaults and limits only from the dated table", async () => {
    const luna = await provider.getCapabilities("gpt-6-luna", signal());
    assert.deepEqual(luna, {
      reasoning: {
        known: true,
        values: ["none", "low", "medium", "high", "xhigh", "max"],
        allowsModelDefault: true,
        defaultValue: "none",
        modelDefault: "medium",
      },
    });
    assert.ok(!("maxOutputTokensLimit" in luna));
    const five = await provider.getCapabilities("gpt-5", signal());
    assert.deepEqual(five.reasoning.values, ["minimal", "low", "medium", "high"]);
    assert.ok(!("defaultValue" in five.reasoning), "no confirmed none");
    assert.equal(five.maxOutputTokensLimit, 128_000);
    const o3 = await provider.getCapabilities("o3", signal());
    assert.equal(o3.maxOutputTokensLimit, 100_000);
  });

  void it("resolves dated snapshots through their base model", async () => {
    const snap = await provider.getCapabilities("gpt-5.1-2025-11-13", signal());
    assert.deepEqual(snap.reasoning.values, ["none", "low", "medium", "high"]);
    assert.equal(snap.reasoning.defaultValue, "none");
    assert.equal((await provider.getCapabilities("gpt-6-luna-2026-01-01", signal())).reasoning.modelDefault, "medium");
  });

  void it("keeps known non-reasoning models distinct from unknown ones", async () => {
    const known = await provider.getCapabilities("gpt-4o", signal());
    assert.deepEqual(known.reasoning, { known: true, values: [], allowsModelDefault: true });
    assert.equal(known.maxOutputTokensLimit, 16_384);
    const unknown = await provider.getCapabilities("mystery-model", signal());
    assert.deepEqual(unknown, { reasoning: { known: false, values: [], allowsModelDefault: true } });
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal((await provider.getCapabilities(name, signal())).reasoning.known, false, name);
    }
  });
});

void describe("stream (not implemented)", () => {
  void it("is lazy: creating the iterator touches neither key nor network", async () => {
    const { provider, keyReads, apiCreations } = providerFor(server);
    const iterator = provider.stream(baseRequest, signal());
    assert.equal(keyReads() + apiCreations(), 0);
    const events: StreamEvent[] = [];
    for await (const event of iterator) {
      events.push(event);
    }
    assert.equal(events.length, 1);
    const [event] = events;
    assert.ok(event?.kind === "failed");
    assert.ok(event.error instanceof ProviderError && event.error.kind === "api");
    assert.equal(event.error.message, "OpenAI streaming is not implemented yet.");
    assert.equal(event.partialText, "");
    assert.equal(keyReads() + apiCreations(), 0);
    assert.equal(server.requests.length, 0);
  });

  void it("throws AbortError when cancelled, before or between work", async () => {
    const controller = new AbortController();
    controller.abort("reason");
    await assert.rejects(drain(providerFor(server).provider.stream(baseRequest, controller.signal)), isAbortError);
    const live = new AbortController();
    const iterator = providerFor(server).provider.stream(baseRequest, live.signal);
    const pending = iterator.next();
    live.abort(new Error("x"));
    await assert.rejects(pending, isAbortError);
  });
});

void describe("every Provider method honors cancellation", () => {
  const calls: readonly { name: string; call: (provider: Provider, signal: AbortSignal) => Promise<unknown> }[] = [
    { name: "generate", call: async (p, s) => p.generate(baseRequest, s) },
    { name: "listModels", call: async (p, s) => p.listModels(s) },
    { name: "checkAvailability", call: async (p, s) => p.checkAvailability(s) },
    { name: "defaultModel", call: async (p, s) => p.defaultModel(s) },
    { name: "getCapabilities", call: async (p, s) => p.getCapabilities("gpt-5", s) },
    {
      name: "stream",
      call: async (p, s) => drain(p.stream(baseRequest, s)),
    },
  ];
  const reasons: readonly unknown[] = [undefined, new Error("custom"), "text", new ProviderError("x", "rate_limit")];

  void it("rejects with AbortError for pre-aborted and immediately aborted signals, whatever the reason", async () => {
    for (const { name, call } of calls) {
      for (const reason of reasons) {
        const unusable = new OpenAIProvider({
          getApiKey: () => assert.fail("must not read the key after a pre-abort"),
          createApi: () => assert.fail("must not create the client after a pre-abort"),
        });
        const pre = new AbortController();
        pre.abort(reason);
        await assert.rejects(call(unusable, pre.signal), (e: unknown) => isAbortError(e) && !(e instanceof ProviderError) && e !== reason, `${name} pre-aborted`);

        const immediate = new AbortController();
        const pending = call(providerFor(server).provider, immediate.signal);
        immediate.abort(reason);
        await assert.rejects(pending, (e: unknown) => isAbortError(e) && !(e instanceof ProviderError) && e !== reason, `${name} immediately aborted`);
        assert.equal(getEventListeners(immediate.signal, "abort").length, 0, name);
      }
    }
  });
});
