import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PreferencesService } from "../src/application/preferences.js";
import { ProviderHub } from "../src/application/provider-hub.js";
import { ActiveTracker, ChatSession } from "../src/application/session.js";
import { SwitchRefusal, Workspace, selectionKey } from "../src/application/workspace.js";
import type { PreparedSwitch } from "../src/application/workspace.js";
import { createAbortError } from "../src/domain/errors.js";
import type { ProviderId } from "../src/domain/generation.js";
import type { ResolvedSettings } from "../src/domain/settings.js";
import type { StoredConversation } from "../src/storage/types.js";
import { MemoryHistory, ioError, sequentialIds, stepClock } from "./helpers/chat.js";
import { CatalogProvider, FakeSettingsStore, LEVELS, model } from "./helpers/menus.js";

const NO_ABORT = new AbortController().signal;
const progress = (): void => undefined;

interface Rig {
  readonly workspace: Workspace;
  readonly openai: CatalogProvider;
  readonly ollama: CatalogProvider;
  /** The history double; with `noHistory` it exists but the workspace never receives it. */
  readonly history: MemoryHistory;
  readonly store: FakeSettingsStore;
  readonly created: ProviderId[];
}

function rig(options: { history?: MemoryHistory | undefined; start?: "ollama" | "openai"; model?: string; restored?: StoredConversation; noHistory?: boolean; clock?: () => Date; newId?: () => string } = {}): Rig {
  const openai = new CatalogProvider("openai", [model("gpt-6-luna"), model("shared")], "gpt-6-luna");
  const ollama = new CatalogProvider("ollama", [model("qwen3.5:4b"), model("llama3.2:3b"), model("shared"), model("__proto__"), model("a/b:c")], "qwen3.5:4b");
  const memory = options.history ?? new MemoryHistory();
  const history = options.noHistory === true ? undefined : memory;
  const clock = options.clock ?? stepClock();
  const newId = options.newId ?? sequentialIds();
  const tracker = new ActiveTracker();
  const startId = options.start ?? "ollama";
  const provider = startId === "openai" ? openai : ollama;
  const name = options.model ?? (startId === "openai" ? "gpt-6-luna" : "qwen3.5:4b");
  const session = new ChatSession({ selection: { provider: startId, model: name }, clock, newId, history, restored: options.restored, activeTracker: tracker });
  const store = new FakeSettingsStore();
  const created: ProviderId[] = [];
  const settings: ResolvedSettings = {
    provider: startId,
    model: name,
    reasoning: { explicit: false, source: "builtin" },
    maxOutputTokens: { explicit: false, source: "builtin" },
    answerStyle: { value: "normal", source: "builtin" },
  };
  const workspace = new Workspace({
    hub: new ProviderHub({
      initial: provider,
      createProvider: (id) => {
        created.push(id);
        return id === "openai" ? openai : ollama;
      },
    }),
    preferences: new PreferencesService({ stored: undefined, saver: store, overrides: {} }),
    session,
    provider,
    settings,
    history,
    clock,
    newId,
    activeTracker: tracker,
  });
  return { workspace, openai, ollama, history: memory, store, created };
}

async function switchTo(r: Rig, provider: ProviderId, name?: string): Promise<{ prepared: PreparedSwitch; warnings: readonly string[]; notice: string }> {
  const prepared = await r.workspace.prepareSwitch({ provider, model: name }, NO_ABORT, progress);
  const result = r.workspace.accept(prepared);
  return { prepared, warnings: await result.writes, notice: result.notice };
}

/** Commits one exchange the way the controller does. */
async function exchange(r: Rig, prompt: string, answer: string, usage = { inputTokens: 10n, outputTokens: 5n }): Promise<void> {
  r.workspace.session.applyCompleted(prompt, { text: answer, usage });
  await r.workspace.session.persist();
}

const texts = (r: Rig): string[] => r.workspace.session.snapshot().messages.map((m) => m.content);

void describe("selection keys", () => {
  void it("keep provider and exact model identity apart for any characters", () => {
    const keys = new Set([
      selectionKey({ provider: "ollama", model: "a/b:c" }),
      selectionKey({ provider: "openai", model: "a/b:c" }),
      selectionKey({ provider: "ollama", model: "__proto__" }),
      selectionKey({ provider: "openai", model: "__proto__" }),
      selectionKey({ provider: "ollama", model: "Ünï😀" }),
      selectionKey({ provider: "ollama", model: "qwen3.5:4b" }),
      selectionKey({ provider: "ollama", model: "Qwen3.5:4b" }),
      selectionKey({ provider: "ollama", model: "qwen3.5:4b:latest" }),
    ]);
    assert.equal(keys.size, 8);
  });
});

void describe("independent conversations per exact selection", () => {
  void it("A -> B -> A keeps messages, usage and the exact request context of each selection apart", async () => {
    const r = rig();
    await exchange(r, "qa1", "aa1", { inputTokens: 10n, outputTokens: 5n });
    await switchTo(r, "ollama", "llama3.2:3b");
    assert.deepEqual(texts(r), []);
    assert.equal(r.workspace.session.snapshot().requests.length, 0, "no usage of the other selection");
    await exchange(r, "qb1", "ab1", { inputTokens: 7n, outputTokens: 3n });
    assert.deepEqual(r.workspace.session.messagesFor("qb2").map((m) => m.content), ["qb1", "ab1", "qb2"]);
    const back = await switchTo(r, "ollama", "qwen3.5:4b");
    assert.equal(back.prepared.source.kind, "parked");
    assert.deepEqual(texts(r), ["qa1", "aa1"]);
    assert.deepEqual(r.workspace.session.snapshot().requests.map((q) => q.usage.inputTokens), [10n]);
    assert.deepEqual(r.workspace.session.messagesFor("qa2").map((m) => m.content), ["qa1", "aa1", "qa2"]);
    assert.equal(back.notice, "Now using Ollama / qwen3.5:4b. Restored its conversation (2 messages).");
  });

  void it("the same model ID on two providers (and special IDs) are different selections", async () => {
    const r = rig();
    await switchTo(r, "ollama", "shared");
    await exchange(r, "ollama-shared", "x");
    await switchTo(r, "openai", "shared");
    assert.deepEqual(texts(r), []);
    await exchange(r, "openai-shared", "y");
    await switchTo(r, "ollama", "__proto__");
    assert.deepEqual(texts(r), []);
    await exchange(r, "proto", "z");
    await switchTo(r, "ollama", "shared");
    assert.deepEqual(texts(r), ["ollama-shared", "x"]);
    await switchTo(r, "openai", "shared");
    assert.deepEqual(texts(r), ["openai-shared", "y"]);
    await switchTo(r, "ollama", "__proto__");
    assert.deepEqual(texts(r), ["proto", "z"]);
    assert.deepEqual(new Set(r.history.saved.map((c) => c.id)).size, 3);
  });

  void it("a conversation remembered in memory wins over an older file, also after a save failure", async () => {
    const r = rig();
    r.history.disk.set("stale", {
      id: "stale",
      createdAt: new Date(0),
      updatedAt: new Date(1),
      provider: "ollama",
      model: "qwen3.5:4b",
      messages: [{ role: "user", content: "OLD" }],
      requests: [],
    });
    r.workspace.session.applyCompleted("q1", { text: "a1" });
    r.history.saveError = ioError();
    const warnings = await r.workspace.session.persist();
    assert.equal(warnings.length, 1, "the save failed visibly");
    await switchTo(r, "ollama", "llama3.2:3b");
    r.history.saveError = undefined;
    const back = await switchTo(r, "ollama", "qwen3.5:4b");
    assert.equal(back.prepared.source.kind, "parked");
    assert.deepEqual(texts(r), ["q1", "a1"], "the unsaved memory, not the stale disk content");
  });
});

void describe("saving at a switch", () => {
  void it("a fresh target is saved empty at once with its active selection; a restored one is not rewritten", async () => {
    const r = rig();
    const fresh = await switchTo(r, "ollama", "llama3.2:3b");
    assert.equal(fresh.prepared.source.kind, "new");
    assert.deepEqual(r.history.saved.map((c) => [c.model, c.messages.length]), [["llama3.2:3b", 0]]);
    assert.deepEqual(r.history.activeSaved, [{ provider: "ollama", model: "llama3.2:3b" }]);

    const stored: StoredConversation = {
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date("2026-10-21T07:00:00.000Z"),
      updatedAt: new Date("2026-10-21T08:00:00.000Z"),
      provider: "ollama",
      model: "gemma-restored",
      messages: [{ role: "user", content: "old" }, { role: "assistant", content: "older" }],
      requests: [{ at: new Date(0), provider: "ollama", model: "gemma-restored", status: "completed", usage: { inputTokens: 42n } }],
    };
    r.history.disk.set(stored.id, stored);
    const savedBefore = r.history.saved.length;
    const restored = await switchTo(r, "ollama", "gemma-restored");
    assert.equal(restored.prepared.source.kind, "restored");
    assert.equal(r.history.saved.length, savedBefore, "the restored file was not rewritten");
    assert.equal(r.history.disk.get(stored.id)?.updatedAt.getTime(), stored.updatedAt.getTime());
    assert.deepEqual(r.history.activeSaved.at(-1), { provider: "ollama", model: "gemma-restored" });
    assert.deepEqual(r.workspace.session.snapshot().requests.map((q) => q.usage.inputTokens), [42n]);
    assert.equal(r.workspace.session.snapshot().requests.at(-1)?.status, "completed");
  });

  void it("returning to a remembered conversation rewrites nothing but may update active.json", async () => {
    const r = rig();
    await exchange(r, "q", "a");
    await switchTo(r, "ollama", "llama3.2:3b");
    const saves = r.history.saved.length;
    const active = r.history.activeSaved.length;
    const back = await switchTo(r, "ollama", "qwen3.5:4b");
    assert.equal(r.history.saved.length, saves);
    assert.equal(r.history.activeSaved.length, active + 1);
    assert.deepEqual(back.warnings, []);
    // switching to where active.json already points writes nothing at all
    const again = r.history.activeSaved.length;
    await switchTo(r, "ollama", "llama3.2:3b");
    await switchTo(r, "ollama", "qwen3.5:4b");
    assert.equal(r.history.activeSaved.length, again + 2);
  });

  void it("a storage failure after an accepted switch warns and leaves the new selection coherent", async () => {
    const r = rig();
    r.history.saveError = ioError();
    const result = await switchTo(r, "ollama", "llama3.2:3b");
    assert.equal(result.warnings.length, 1);
    assert.equal(r.workspace.selection.model, "llama3.2:3b");
    assert.equal(r.workspace.settings.model, "llama3.2:3b");
    assert.equal(r.workspace.provider.id, "ollama");
    assert.deepEqual(texts(r), []);
  });

  void it("an empty conversation that is not on disk is dropped, so two remembered selections never share an id or file", async () => {
    const r = rig();
    const firstId = r.workspace.session.snapshot().id;
    await switchTo(r, "ollama", "llama3.2:3b");
    const secondId = r.workspace.session.snapshot().id;
    await switchTo(r, "ollama", "qwen3.5:4b"); // the first one never had a file or content
    const thirdId = r.workspace.session.snapshot().id;
    assert.notEqual(secondId, thirdId);
    assert.ok(new Set([secondId, thirdId]).size === 2 && firstId !== thirdId);
    assert.deepEqual(r.history.saved.map((c) => c.model), ["llama3.2:3b", "qwen3.5:4b"]);
  });

  void it("/reset replaces only the active selection's conversation; A -> reset -> B -> A returns A's empty post-reset conversation", async () => {
    const r = rig();
    await exchange(r, "q", "a");
    const archived = r.workspace.session.snapshot().id;
    await switchTo(r, "ollama", "llama3.2:3b");
    await exchange(r, "qb", "ab");
    const bId = r.workspace.session.snapshot().id;
    await switchTo(r, "ollama", "qwen3.5:4b");
    await r.workspace.session.reset();
    const resetId = r.workspace.session.snapshot().id;
    assert.notEqual(resetId, archived);
    await switchTo(r, "ollama", "llama3.2:3b");
    assert.equal(r.workspace.session.snapshot().id, bId, "the other selection is untouched by the reset");
    assert.deepEqual(texts(r), ["qb", "ab"]);
    const back = await switchTo(r, "ollama", "qwen3.5:4b");
    assert.equal(back.prepared.source.kind, "parked");
    assert.equal(r.workspace.session.snapshot().id, resetId);
    assert.deepEqual(texts(r), []);
    assert.equal(back.notice, "Now using Ollama / qwen3.5:4b. Started a new conversation; the previous one stays saved.");
  });

  void it("in a new process the empty post-reset conversation is restored rather than the archived one", async () => {
    const history = new MemoryHistory();
    const clock = stepClock();
    const newId = sequentialIds(); // one id/clock source: a second process would not collide either
    const first = rig({ history, clock, newId });
    await exchange(first, "q", "a");
    await first.workspace.session.reset();
    const second = rig({ history, clock, newId });
    // a fresh run: nothing remembered in memory, so the disk decides (the newest matching file)
    const prepared = await second.workspace.prepareSwitch({ provider: "ollama", model: "llama3.2:3b" }, NO_ABORT, progress);
    second.workspace.accept(prepared);
    const back = await second.workspace.prepareSwitch({ provider: "ollama", model: "qwen3.5:4b" }, NO_ABORT, progress);
    assert.ok(back.source.kind === "restored" && back.source.conversation.messages.length === 0);
  });
});

void describe("notices", () => {
  void it("a new target says whether the previous conversation stays saved, is simply not sent, or was empty", async () => {
    const withHistory = rig();
    assert.equal((await switchTo(withHistory, "ollama", "llama3.2:3b")).notice, "Now using Ollama / llama3.2:3b. Started a new conversation.");
    await exchange(withHistory, "q", "a");
    assert.equal(
      (await switchTo(withHistory, "ollama", "gemma-new")).notice,
      "Now using Ollama / gemma-new. Started a new conversation; the previous one stays saved.",
    );
    const memory = rig({ noHistory: true });
    await exchange(memory, "q", "a");
    assert.equal(
      (await switchTo(memory, "ollama", "llama3.2:3b")).notice,
      "Now using Ollama / llama3.2:3b. Started a new conversation; the previous messages are not sent to the new model.",
    );
  });
});

void describe("--no-history", () => {
  void it("keeps the same registry in memory only and never touches history", async () => {
    const r = rig({ noHistory: true });
    r.workspace.session.applyCompleted("q", { text: "a", usage: { inputTokens: 3n } });
    await switchTo(r, "ollama", "llama3.2:3b");
    r.workspace.session.applyCompleted("qb", { text: "ab" });
    const back = await switchTo(r, "ollama", "qwen3.5:4b");
    assert.equal(back.prepared.source.kind, "parked");
    assert.deepEqual(texts(r), ["q", "a"]);
    assert.deepEqual(back.warnings, []);
    assert.equal(r.workspace.session.persistent, false);
  });
});

void describe("cleanup", () => {
  void it("forgetting the others means a deleted conversation never comes back from memory", async () => {
    const r = rig();
    await exchange(r, "q", "a");
    await switchTo(r, "ollama", "llama3.2:3b");
    await exchange(r, "qb", "ab");
    const outcome = await r.workspace.session.cleanup();
    assert.equal(outcome.kind, "deleted");
    r.workspace.forgetOthers();
    assert.deepEqual(texts(r), [], "the active conversation restarted");
    const back = await switchTo(r, "ollama", "qwen3.5:4b");
    assert.equal(back.prepared.source.kind, "new", "neither memory nor disk resurrects it");
    assert.deepEqual(texts(r), []);
  });
});

void describe("preparation changes nothing", () => {
  void it("a refused, failed or cancelled preparation leaves selection, settings, memory and files exactly as before", async () => {
    const r = rig();
    await exchange(r, "q", "a");
    const before = { key: selectionKey(r.workspace.selection), settings: r.workspace.settings, saved: r.history.saved.length, active: r.history.activeSaved.length, id: r.workspace.session.snapshot().id };
    r.openai.availability = { available: false, message: "down" };
    await assert.rejects(r.workspace.prepareSwitch({ provider: "openai" }, NO_ABORT, progress), (error: unknown) => error instanceof SwitchRefusal && error.message === "OpenAI is not available: down");
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(r.workspace.prepareSwitch({ provider: "ollama", model: "llama3.2:3b" }, aborted.signal, progress), (error: unknown) => (error as Error).name === "AbortError");
    const gate = new AbortController();
    r.ollama.caps.set("llama3.2:3b", LEVELS);
    r.ollama.gates.capabilities = new Promise<void>(() => undefined);
    const pending = r.workspace.prepareSwitch({ provider: "ollama", model: "llama3.2:3b" }, gate.signal, progress);
    gate.abort();
    await assert.rejects(pending, (error: unknown) => (error as Error).name === createAbortError().name);
    assert.deepEqual(
      { key: selectionKey(r.workspace.selection), settings: r.workspace.settings, saved: r.history.saved.length, active: r.history.activeSaved.length, id: r.workspace.session.snapshot().id },
      before,
    );
    assert.deepEqual(texts(r), ["q", "a"]);
  });

  void it("a prepared switch is refused by accept when the workspace changed meanwhile", async () => {
    const r = rig();
    const prepared = await r.workspace.prepareSwitch({ provider: "ollama", model: "llama3.2:3b" }, NO_ABORT, progress);
    r.workspace.chooseAnswerStyle("brief");
    assert.throws(() => r.workspace.accept(prepared), /changed while it was being prepared/u);
  });

  void it("the other provider is built only when selected, once, and its instance is reused", async () => {
    const r = rig();
    assert.deepEqual(r.created, []);
    await switchTo(r, "openai");
    assert.deepEqual(r.created, ["openai"]);
    await switchTo(r, "ollama");
    await switchTo(r, "openai");
    assert.deepEqual(r.created, ["openai"]);
    assert.equal(r.openai.availabilityCalls, 2, "availability is checked at every provider switch");
  });
});
