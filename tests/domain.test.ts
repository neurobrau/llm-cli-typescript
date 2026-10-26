import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXIT_CANCELLED,
  EXIT_SETTINGS,
  ProviderError,
  createAbortError,
  exitCodeForKind,
  isAbortError,
} from "../src/domain/errors.js";
import type { ProviderErrorKind } from "../src/domain/errors.js";
import { isTerminalEvent, snapshotRequest } from "../src/domain/generation.js";
import type { GenerationRequest, GenerationResult, Message, StreamEvent, TokenUsage } from "../src/domain/generation.js";

void describe("provider errors", () => {
  void it("maps every kind to its exit code", () => {
    const expected: Record<ProviderErrorKind, number> = {
      api: 1,
      missing_api_key: 3,
      authentication: 4,
      rate_limit: 5,
      timeout: 6,
      connection: 7,
    };
    for (const [kind, code] of Object.entries(expected)) {
      assert.equal(exitCodeForKind(kind as ProviderErrorKind), code, kind);
    }
  });

  void it("defaults to the api kind and carries the safe message", () => {
    const error = new ProviderError("boom");
    assert.equal(error.kind, "api");
    assert.equal(error.message, "boom");
    assert.ok(error instanceof Error);
  });

  void it("keeps cancellation distinct from every provider kind and settings exit code", () => {
    const abort = createAbortError();
    assert.ok(isAbortError(abort));
    assert.ok(!(abort instanceof ProviderError));
    assert.ok(!isAbortError(new ProviderError("x", "timeout")));
    const kinds: readonly ProviderErrorKind[] = ["api", "missing_api_key", "authentication", "rate_limit", "timeout", "connection"];
    const codes = kinds.map(exitCodeForKind);
    assert.ok(!codes.includes(EXIT_CANCELLED));
    assert.ok(!codes.includes(EXIT_SETTINGS));
    assert.equal(EXIT_CANCELLED, 130);
    assert.equal(EXIT_SETTINGS, 2);
  });
});

void describe("usage and result data", () => {
  void it("distinguishes absent from reported zero and keeps counts above 2^53 exact", () => {
    const big = 2n ** 53n + 1n;
    const usage: TokenUsage = { inputTokens: 0n, outputTokens: big };
    assert.equal(usage.inputTokens, 0n);
    assert.equal(usage.totalTokens, undefined);
    assert.ok("inputTokens" in usage && !("totalTokens" in usage));
    assert.equal(usage.outputTokens, big);
    assert.equal(Number(big), Number(2n ** 53n)); // a JS number would round
    assert.notEqual(usage.outputTokens, 2n ** 53n);
    assert.equal(String(usage.outputTokens), "9007199254740993");
  });

  void it("distinguishes an empty service tier from an absent one", () => {
    const empty: GenerationResult = { text: "a", serviceTier: "" };
    const absent: GenerationResult = { text: "a" };
    assert.equal(empty.serviceTier, "");
    assert.ok("serviceTier" in empty);
    assert.ok(!("serviceTier" in absent));
  });

  void it("identifies terminal stream events", () => {
    const events: readonly StreamEvent[] = [
      { kind: "text", text: "a" },
      { kind: "reasoning", text: "b" },
      { kind: "completed", result: { text: "a" } },
      { kind: "incomplete", reason: "max_tokens", partialText: "a" },
      { kind: "failed", error: new ProviderError("x"), partialText: "" },
    ];
    assert.deepEqual(events.map(isTerminalEvent), [false, false, true, true, true]);
  });
});

void describe("snapshotRequest", () => {
  void it("copies and freezes so caller mutation cannot change the snapshot", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const request: GenerationRequest = {
      model: "m",
      messages,
      reasoning: { effort: "low", explicit: true, source: "cli" },
      maxOutputTokens: 10,
    };
    const snap = snapshotRequest(request);
    messages.push({ role: "assistant", content: "later" });
    assert.equal(snap.messages.length, 1);
    assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.messages) && Object.isFrozen(snap.reasoning));
    assert.ok(snap.messages.every((message) => Object.isFrozen(message)));
    assert.equal(snap.maxOutputTokens, 10);
    assert.ok(!("instructions" in snap));
  });
});
