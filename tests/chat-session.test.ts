import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChatSession, describeStorageFailure } from "../src/application/session.js";
import type { SessionOptions } from "../src/application/session.js";
import { usageReport } from "../src/application/usage-report.js";
import type { StoredConversation, StoredUsageRecord } from "../src/storage/types.js";
import { MemoryHistory, ioError, sequentialIds, stepClock } from "./helpers/chat.js";
import { deferred } from "./helpers/deferred.js";

const SELECTION = { provider: "ollama", model: "q" } as const;

function make(extra: Partial<SessionOptions> = {}): { session: ChatSession; history: MemoryHistory } {
  const history = new MemoryHistory();
  const session = new ChatSession({ selection: SELECTION, clock: stepClock(), newId: sequentialIds(), history, ...extra });
  return { session, history };
}

const stored = (extra: Partial<StoredConversation> = {}): StoredConversation => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  provider: "ollama",
  model: "q",
  messages: [
    { role: "user", content: "old" },
    { role: "assistant", content: "older" },
  ],
  requests: [],
  ...extra,
});

void describe("ChatSession: committing exchanges", () => {
  void it("builds the request from committed messages plus exactly the pending message, committing nothing", () => {
    const { session } = make({ restored: stored() });
    assert.deepEqual(session.messagesFor("new"), [
      { role: "user", content: "old" },
      { role: "assistant", content: "older" },
      { role: "user", content: "new" },
    ]);
    assert.equal(session.snapshot().messages.length, 2);
  });

  void it("commits the pair and one usage record atomically with exact bigint counts, tier and clock time", async () => {
    const { session, history } = make();
    session.applyCompleted("q", {
      text: "a",
      usage: { inputTokens: 2n ** 70n, outputTokens: 0n, cachedInputTokens: 5n },
      serviceTier: "",
    });
    const snap = session.snapshot();
    assert.deepEqual(snap.messages, [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    assert.equal(snap.requests.length, 1);
    const [record] = snap.requests;
    assert.equal(record?.status, "completed");
    assert.equal(record.serviceTier, "");
    assert.equal(record.provider, "ollama");
    assert.equal(record.usage.inputTokens, 2n ** 70n);
    assert.equal(record.usage.outputTokens, 0n);
    assert.equal(record.usage.totalTokens, undefined); // never inferred
    assert.deepEqual(await session.persist(), []);
    assert.equal(history.saved[0]?.requests[0]?.usage.inputTokens, 2n ** 70n);
  });

  void it("an explicitly present but empty usage object is reported usage; absent usage is no record", () => {
    const { session } = make();
    session.applyCompleted("a", { text: "x", usage: {} });
    session.applyCompleted("b", { text: "y" });
    assert.equal(session.snapshot().requests.length, 1);
    assert.deepEqual(session.snapshot().requests[0]?.usage, {});
  });

  void it("snapshots are independent copies, including dates, records and nested usage", () => {
    const { session } = make();
    session.applyCompleted("q", { text: "a", usage: { inputTokens: 1n } });
    const first = session.snapshot();
    first.createdAt.setTime(0);
    first.updatedAt.setTime(0);
    first.requests[0]?.at.setTime(0);
    const usage = first.requests[0]?.usage;
    assert.ok(usage);
    assert.ok(Object.isFrozen(first.messages) && Object.isFrozen(first.messages[0]) && Object.isFrozen(first.requests));
    const second = session.snapshot();
    assert.notEqual(second.createdAt.getTime(), 0);
    assert.notEqual(second.requests[0]?.at.getTime(), 0);
    assert.notEqual(second.requests[0]?.usage, usage);
    assert.equal(second.messages.length, 2);
  });

  void it("adoption copies the restored conversation (later mutation of the original changes nothing)", () => {
    const original = stored({ requests: [record("completed", { inputTokens: 1n })] });
    const { session } = make({ restored: original });
    original.updatedAt.setTime(0);
    original.requests[0]?.at.setTime(0);
    assert.notEqual(session.snapshot().updatedAt.getTime(), 0);
    assert.notEqual(session.snapshot().requests[0]?.at.getTime(), 0);
    assert.equal(session.restoredNotice?.messageCount, 2);
  });

  void it("an empty restored conversation is adopted but has no restored notice", () => {
    const { session } = make({ restored: stored({ messages: [] }) });
    assert.equal(session.restoredNotice, undefined);
    assert.equal(session.snapshot().id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(session.snapshot().onDisk, true);
  });
});

function record(status: "completed" | "incomplete", usage: StoredUsageRecord["usage"]): StoredUsageRecord {
  return { at: new Date("2026-01-01T00:00:00.000Z"), provider: "ollama", model: "q", status, usage };
}

void describe("ChatSession: incomplete outcomes", () => {
  void it("records incomplete usage in memory and saves only when messages or a file exist", () => {
    const fresh = make();
    assert.equal(fresh.session.applyIncomplete({ reason: "r", partialText: "p", usage: { inputTokens: 1n }, serviceTier: "flex" }), false);
    assert.equal(fresh.session.snapshot().requests[0]?.status, "incomplete");
    assert.equal(fresh.session.snapshot().requests[0]?.serviceTier, "flex");
    assert.deepEqual(fresh.session.snapshot().messages, []);
    assert.deepEqual(fresh.history.calls, []);

    const withFile = make({ restored: stored({ messages: [] }) });
    assert.equal(withFile.session.applyIncomplete({ reason: "r", partialText: "", usage: { outputTokens: 2n } }), true);

    const withMessages = make();
    withMessages.session.applyCompleted("q", { text: "a" });
    assert.equal(withMessages.session.applyIncomplete({ reason: "r", partialText: "", usage: { outputTokens: 2n } }), true);
  });

  void it("no usage means no record and no save", () => {
    const { session } = make({ restored: stored() });
    assert.equal(session.applyIncomplete({ reason: "r", partialText: "x" }), false);
    assert.equal(session.snapshot().requests.length, 0);
  });
});

void describe("ChatSession: persistence", () => {
  void it("a failed save keeps memory, and a later save writes the whole accumulated state", async () => {
    const { session, history } = make();
    history.saveError = ioError();
    session.applyCompleted("a", { text: "1" });
    assert.match((await session.persist())[0] ?? "", /Could not save conversation history at /);
    assert.equal(session.snapshot().onDisk, false);
    history.saveError = undefined;
    session.applyCompleted("b", { text: "2" });
    assert.deepEqual(await session.persist(), []);
    assert.deepEqual(history.saved[0]?.messages.map((m) => m.content), ["a", "1", "b", "2"]);
    assert.equal(session.snapshot().onDisk, true);
  });

  void it("saves the conversation first and active.json only afterwards and only once per selection", async () => {
    const { session, history } = make();
    session.applyCompleted("a", { text: "1" });
    await session.persist();
    await session.persist();
    assert.deepEqual(history.calls, ["save", "saveActive", "save"]);
  });

  void it("does not attempt active.json when the conversation save failed", async () => {
    const { session, history } = make();
    history.saveError = ioError();
    session.applyCompleted("a", { text: "1" });
    await session.persist();
    assert.deepEqual(history.calls, ["save"]);
  });

  void it("uses the clock for updatedAt on each save and keeps id and createdAt", async () => {
    const { session, history } = make();
    const created = session.snapshot().createdAt.getTime();
    session.applyCompleted("a", { text: "1" });
    await session.persist();
    session.applyCompleted("b", { text: "2" });
    await session.persist();
    const [first, second] = history.saved;
    assert.ok(first && second);
    assert.equal(first.id, second.id);
    assert.equal(first.createdAt.getTime(), created);
    assert.ok(second.updatedAt.getTime() > first.updatedAt.getTime());
    assert.equal(first.provider, "ollama");
    assert.equal(first.model, "q");
  });

  void it("a memory-only session never touches storage", async () => {
    const { session } = make({ history: undefined });
    session.applyCompleted("a", { text: "1" });
    assert.deepEqual(await session.persist(), []);
    assert.deepEqual((await session.reset()).warnings, []);
    assert.equal(await session.countSaved(), 0);
    assert.deepEqual(await session.cleanup(), { kind: "disabled" });
    assert.equal(session.persistent, false);
  });

  void it("refuses to apply a new exchange while persistence is pending, and serializes storage operations", async () => {
    const { session, history } = make();
    const release = deferred();
    history.saveGate = release.promise;
    session.applyCompleted("a", { text: "1" });
    const saving = session.persist();
    const resetting = session.reset();
    assert.throws(() => { session.applyCompleted("b", { text: "2" }); }, /busy/);
    release.resolve();
    await saving;
    await resetting;
    assert.deepEqual(history.calls, ["save", "saveActive", "save"]); // the reset's save came strictly after
  });

  void it("rethrows failures that are not storage failures", async () => {
    const { session, history } = make();
    history.saveError = new TypeError("bug");
    session.applyCompleted("a", { text: "1" });
    await assert.rejects(session.persist(), TypeError);
    assert.equal(describeStorageFailure(new TypeError("x")), undefined);
  });
});

void describe("ChatSession: reset and cleanup", () => {
  void it("reset starts a fresh identity with empty state, saves it at once, and keeps the old file", async () => {
    const { session, history } = make();
    session.applyCompleted("a", { text: "1", usage: { inputTokens: 1n } });
    await session.persist();
    const oldId = session.snapshot().id;
    const outcome = await session.reset();
    assert.equal(outcome.started, true);
    const snap = session.snapshot();
    assert.notEqual(snap.id, oldId);
    assert.deepEqual([snap.messages.length, snap.requests.length], [0, 0]);
    assert.equal(history.saved.at(-1)?.id, snap.id);
    assert.equal(history.saved.at(-1)?.messages.length, 0);
    assert.equal(history.saved[0]?.id, oldId);
    session.applyCompleted("b", { text: "2" });
    assert.deepEqual(session.messagesFor("c").map((m) => m.content), ["b", "2", "c"]);
  });

  void it("reset reuses a truly empty conversation, but not one that only has usage", async () => {
    const { session, history } = make();
    const id = session.snapshot().id;
    assert.equal((await session.reset()).started, false);
    assert.equal(session.snapshot().id, id);
    assert.deepEqual(history.calls, []);
    session.applyIncomplete({ reason: "r", partialText: "", usage: { inputTokens: 1n } });
    assert.equal((await session.reset()).started, true);
    assert.notEqual(session.snapshot().id, id);
  });

  void it("a failed save after reset warns, but the new empty conversation stays usable", async () => {
    const { session, history } = make({ restored: stored() });
    history.saveError = ioError();
    const outcome = await session.reset();
    assert.equal(outcome.started, true);
    assert.equal(outcome.warnings.length, 1);
    assert.equal(session.snapshot().messages.length, 0);
    assert.equal(session.snapshot().onDisk, false);
  });

  void it("cleanup success starts a new empty unsaved conversation; failure preserves the session", async () => {
    const { session, history } = make({ restored: stored() });
    history.files = 3;
    assert.equal(await session.countSaved(), 3);
    history.deleteResult = { deleted: 1, error: { message: "Could not delete conversation history at /x: Permission denied." } };
    const failed = await session.cleanup();
    assert.deepEqual(failed, { kind: "failed", deleted: 1, warning: "Could not delete conversation history at /x: Permission denied." });
    assert.equal(session.snapshot().messages.length, 2);
    history.deleteResult = undefined;
    const done = await session.cleanup();
    assert.deepEqual(done, { kind: "deleted", deleted: 3 });
    assert.equal(session.snapshot().messages.length, 0);
    assert.equal(session.snapshot().onDisk, false);
    assert.equal(session.restoredNotice, undefined);
  });
});

void describe("usageReport", () => {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const rec = (status: "completed" | "incomplete", usage: StoredUsageRecord["usage"]): StoredUsageRecord => ({ at, provider: "ollama", model: "q", status, usage });

  void it("says so when there are no requests, and that costs are not estimated", () => {
    assert.match(usageReport([]), /no API requests in this conversation yet\.\nCost estimates are not implemented yet\./);
  });

  void it("sums each field independently with exact bigints and labels partial coverage", () => {
    const text = usageReport([
      rec("completed", { inputTokens: 2n ** 70n, outputTokens: 4n }),
      rec("completed", { inputTokens: 5n }),
      rec("incomplete", { outputTokens: 0n, cachedInputTokens: 3n }),
    ]);
    assert.match(text, /3 request\(s\): 2 completed, 1 incomplete/);
    assert.match(text, /Input tokens: 1,180,591,620,717,411,303,429 \(reported subtotal: 2 of 3 requests reported this\)/);
    assert.match(text, /Output tokens: 4 \(reported subtotal: 2 of 3/);
    assert.match(text, /Total tokens: not reported/);
    assert.match(text, /Cached input tokens \(part of input\): 3 \(reported subtotal: 1 of 3/);
    assert.match(text, /Latest completed request input: 5 tokens/); // not the incomplete request's input
    assert.match(text, /Includes 1 incomplete answer/);
    assert.match(text, /Cost estimates are not implemented yet\./);
    assert.ok(!text.includes("$"));
  });

  void it("complete coverage has no subtotal label and zero is a reported count", () => {
    const text = usageReport([rec("completed", { totalTokens: 0n }), rec("completed", { totalTokens: 0n })]);
    assert.match(text, /Total tokens: 0\n/);
    assert.match(text, /Latest completed request input: not reported/);
  });
});
