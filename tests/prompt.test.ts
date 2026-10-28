import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError, createAbortError, isAbortError } from "../src/domain/errors.js";
import type { GenerationOutcome } from "../src/domain/generation.js";
import type { Provider } from "../src/domain/provider.js";
import type { ModelCapabilities } from "../src/domain/settings.js";
import { run } from "../src/main.js";
import type { InterruptSource, Io, RunDependencies } from "../src/main.js";
import { deferred } from "./helpers/deferred.js";
import { FakeProvider } from "./helpers/fake-provider.js";

interface Captured {
  readonly io: Io;
  readonly out: string[];
  readonly err: string[];
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    },
  };
}

const completed = (text: string, extra: object = {}): GenerationOutcome => ({ kind: "completed", result: { text, ...extra } });

function interruptSource(): { source: InterruptSource; fire: () => void; registered: () => number; active: () => number } {
  const handlers = new Set<() => void>();
  let registered = 0;
  return {
    source: {
      register(handler) {
        registered += 1;
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    fire: () => {
      for (const handler of [...handlers]) {
        handler();
      }
    },
    registered: () => registered,
    active: () => handlers.size,
  };
}

async function runWith(argv: readonly string[], provider: Provider, extra: Partial<RunDependencies> = {}) {
  const captured = capture();
  const code = await run(argv, captured.io, { createProvider: () => provider, ...extra });
  return { code, out: captured.out.join(""), err: captured.err.join("") };
}

const reasoningModel: ModelCapabilities = {
  reasoning: { known: true, values: ["none", "low", "high"], allowsModelDefault: true, defaultValue: "none" },
  maxOutputTokensLimit: 1000,
};
const plainModel: ModelCapabilities = { reasoning: { known: true, values: [], allowsModelDefault: true } };

void describe("one-shot prompt", () => {
  void it("prints the answer with a final newline, exits 0, and sends a user message", async () => {
    const provider = new FakeProvider({ outcome: completed("The answer."), capabilities: reasoningModel });
    const result = await runWith(["What is it?"], provider);
    assert.deepEqual(result, { code: 0, out: "The answer.\n", err: "" });
    const [request] = provider.requests;
    assert.ok(request);
    assert.equal(request.model, "fake-model");
    assert.deepEqual(request.messages, [{ role: "user", content: "What is it?" }]);
    assert.deepEqual(request.reasoning, { effort: "none", explicit: false, source: "builtin" });
    assert.ok(!("maxOutputTokens" in request) && !("instructions" in request));
  });

  void it("preserves prompt and answer whitespace", async () => {
    const provider = new FakeProvider({ outcome: completed("  spaced \n") });
    const result = await runWith(["  keep\n  this  "], provider);
    assert.equal(result.out, "  spaced \n\n");
    assert.equal(provider.requests[0]?.messages[0]?.content, "  keep\n  this  ");
  });

  void it("applies flags through the strict resolver", async () => {
    const provider = new FakeProvider({ outcome: completed("ok"), capabilities: reasoningModel });
    const result = await runWith(
      ["--model", "gpt-x", "--reasoning-effort", "high", "--max-output-tokens", "1000", "--answer-style", "brief", "p"],
      provider,
    );
    assert.equal(result.code, 0);
    const [request] = provider.requests;
    assert.ok(request);
    assert.equal(request.model, "gpt-x");
    assert.deepEqual(request.reasoning, { effort: "high", explicit: true, source: "cli" });
    assert.equal(request.maxOutputTokens, 1000);
    assert.match(request.instructions ?? "", /^Answer briefly and concisely/);
  });

  void it("omits the reasoning effort for model-default and keeps the choice explicit", async () => {
    const provider = new FakeProvider({ outcome: completed("ok"), capabilities: reasoningModel });
    await runWith(["--reasoning-effort", "model-default", "p"], provider);
    assert.deepEqual(provider.requests[0]?.reasoning, { explicit: true, source: "cli" });
  });

  void it("passes explicit efforts through for unknown models", async () => {
    const provider = new FakeProvider({ outcome: completed("ok") });
    const result = await runWith(["--reasoning-effort", "xhigh", "p"], provider);
    assert.equal(result.code, 0);
    assert.equal(provider.requests[0]?.reasoning.effort, "xhigh");
  });

  void it("exits 2 for settings the model is known not to support, before any request", async () => {
    const cases: readonly { argv: readonly string[]; caps: ModelCapabilities; pattern: RegExp }[] = [
      { argv: ["--reasoning-effort", "high", "p"], caps: plainModel, pattern: /does not support reasoning; 'high' is not available\.\n$/ },
      { argv: ["--max-output-tokens", "2000", "p"], caps: reasoningModel, pattern: /2000 exceeds the limit of 1000 output tokens/ },
    ];
    for (const { argv, caps, pattern } of cases) {
      const provider = new FakeProvider({ capabilities: caps });
      const result = await runWith(argv, provider);
      assert.equal(result.code, 2);
      assert.equal(result.out, "");
      assert.match(result.err, pattern);
      assert.equal(provider.requests.length, 0);
    }
  });

  void it("shows usage on stderr only when asked, listing only reported counts", async () => {
    const outcome = completed("ok", { usage: { inputTokens: 9007199254740993n, outputTokens: 0n } });
    const without = await runWith(["p"], new FakeProvider({ outcome }));
    assert.equal(without.err, "");
    const withUsage = await runWith(["--usage", "p"], new FakeProvider({ outcome }));
    assert.equal(withUsage.err, "Token usage: input=9007199254740993, output=0\n");
    assert.equal(withUsage.out, "ok\n");
    const full = await runWith(["--usage", "p"], new FakeProvider({ outcome: completed("ok", { usage: { inputTokens: 1n, outputTokens: 2n, totalTokens: 3n } }) }));
    assert.equal(full.err, "Token usage: input=1, output=2, total=3\n");
    const none = await runWith(["--usage", "p"], new FakeProvider({ outcome: completed("ok") }));
    assert.equal(none.err, "Token usage: not reported\n");
    const empty = await runWith(["--usage", "p"], new FakeProvider({ outcome: completed("ok", { usage: {} }) }));
    assert.equal(empty.err, "Token usage: not reported\n");
  });

  void it("prints partial text, a warning and exit 8 for incomplete answers", async () => {
    const outcome: GenerationOutcome = {
      kind: "incomplete",
      reason: "the max output token limit was reached",
      partialText: "partial",
      usage: { inputTokens: 5n },
    };
    const result = await runWith(["--usage", "p"], new FakeProvider({ outcome }));
    assert.equal(result.code, 8);
    assert.equal(result.out, "partial\n");
    assert.equal(result.err, "neurobrau: warning: response incomplete: the max output token limit was reached.\nToken usage: input=5\n");
    const noText = await runWith(["p"], new FakeProvider({ outcome: { kind: "incomplete", reason: "r", partialText: "" } }));
    assert.deepEqual(noText, { code: 8, out: "", err: "neurobrau: warning: response incomplete: r.\n" });
  });

  void it("maps provider failures to safe messages and exit codes by kind", async () => {
    const kinds = { api: 1, missing_api_key: 3, authentication: 4, rate_limit: 5, timeout: 6, connection: 7 } as const;
    for (const [kind, code] of Object.entries(kinds)) {
      const error = new ProviderError(`message for ${kind}`, kind as keyof typeof kinds);
      const result = await runWith(["p"], new FakeProvider({ outcome: error }));
      assert.deepEqual(result, { code, out: "", err: `neurobrau: error: message for ${kind}\n` });
    }
  });

  void it("treats a quiet EPIPE on stdout as exit 141", async () => {
    const code = await run(["p"], {
      stdout: () => Promise.reject(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
      stderr: () => undefined,
    }, { createProvider: () => new FakeProvider({ outcome: completed("ok") }) });
    assert.equal(code, 141);
  });
});

void describe("provider creation", () => {
  void it("is never requested for help, version or invalid invocations", async () => {
    let created = 0;
    const deps: RunDependencies = {
      createProvider: () => {
        created += 1;
        return new FakeProvider();
      },
    };
    for (const argv of [[], ["--help"], ["--version"], ["--bogus"], ["--stream", "p"], ["--provider", "ollama", "p"], [""], ["--usage"], ["a", "b"], ["--max-output-tokens", "0", "p"]]) {
      await run(argv, capture().io, deps);
    }
    assert.equal(created, 0);
    await run(["p"], capture().io, deps);
    assert.equal(created, 1);
  });

  void it("without a factory, prompts fail with a missing-key error and no ambient lookup", async () => {
    const captured = capture();
    const code = await run(["p"], captured.io);
    assert.equal(code, 3);
    assert.match(captured.err.join(""), /OPENAI_API_KEY is not set/);
  });
});

void describe("interrupts", () => {
  void it("aborts the operation, prints 'interrupted', exits 130 and prints no answer", async () => {
    const gate = deferred();
    const provider = new FakeProvider({ gate, outcome: completed("must not appear") });
    const interrupt = interruptSource();
    const pending = runWith(["p"], provider, { interrupt: interrupt.source });
    await provider.reachedPending;
    assert.equal(interrupt.active(), 1);
    interrupt.fire();
    const result = await pending;
    assert.deepEqual(result, { code: 130, out: "", err: "neurobrau: interrupted\n" });
    assert.equal(interrupt.active(), 0, "the handler is unregistered afterwards");
    assert.equal(provider.activeAbortListeners, 0);
  });

  void it("suppresses an answer that arrives after the interrupt", async () => {
    // A provider that ignores the signal and answers anyway.
    const release = deferred();
    const reached = deferred();
    class Stubborn extends FakeProvider {
      override async generate(): Promise<GenerationOutcome> {
        reached.resolve();
        await release.promise;
        return completed("late answer");
      }
    }
    const stubborn = new Stubborn({ capabilities: plainModel });
    const interrupt = interruptSource();
    const pending = runWith(["p"], stubborn, { interrupt: interrupt.source });
    await reached.promise;
    interrupt.fire();
    release.resolve();
    const result = await pending;
    assert.equal(result.code, 130);
    assert.equal(result.out, "");
  });

  void it("stops waiting for a hung operation after the bounded cleanup time", async () => {
    const reached = deferred();
    class Hung extends FakeProvider {
      override async generate(): Promise<GenerationOutcome> {
        reached.resolve();
        return new Promise<GenerationOutcome>(() => undefined);
      }
    }
    const hung = new Hung({ capabilities: plainModel });
    const interrupt = interruptSource();
    const pending = runWith(["p"], hung, { interrupt: interrupt.source, cleanupTimeoutMs: 20 });
    await reached.promise;
    interrupt.fire();
    assert.deepEqual(await pending, { code: 130, out: "", err: "neurobrau: interrupted\n" });
  });

  void it("unregisters the handler after success and after errors", async () => {
    const interrupt = interruptSource();
    await runWith(["p"], new FakeProvider({ outcome: completed("ok") }), { interrupt: interrupt.source });
    await runWith(["p"], new FakeProvider({ outcome: new ProviderError("x") }), { interrupt: interrupt.source });
    await runWith(["--reasoning-effort", "high", "p"], new FakeProvider({ capabilities: plainModel }), { interrupt: interrupt.source });
    assert.equal(interrupt.registered(), 3);
    assert.equal(interrupt.active(), 0);
  });

  void it("registers no handler for help, version or invalid arguments", async () => {
    const interrupt = interruptSource();
    for (const argv of [[], ["--version"], ["--bogus"]]) {
      await run(argv, capture().io, { interrupt: interrupt.source });
    }
    assert.equal(interrupt.registered(), 0);
  });

  void it("exposes AbortError normalization to callers", () => {
    assert.ok(isAbortError(createAbortError()));
  });
});
