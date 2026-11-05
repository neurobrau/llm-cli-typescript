import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { decodeActiveSelection, decodeConversation, encodeConversation } from "../src/storage/index.js";
import type { StoredConversation } from "../src/storage/types.js";
import { HistoryStore } from "../src/storage/fs/history-store.js";
import { SettingsStore } from "../src/storage/fs/settings-store.js";
import { MemoryHistory, answer } from "./helpers/chat.js";
import { deferred } from "./helpers/deferred.js";
import { CatalogProvider, model, startMenuTui } from "./helpers/menus.js";
import type { MenuRig } from "./helpers/menus.js";
import { makeTree, without } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";
import { KEYS, eventually, finishWithClock, settleAll, until } from "./helpers/tui.js";

let tree: Tree;
beforeEach(async () => {
  tree = await makeTree();
});
afterEach(async () => {
  await tree.cleanup();
});

const term = (rig: MenuRig) => rig.session.term;
const press = (rig: MenuRig, sequence: string): Promise<void> => rig.session.key(sequence);
const submit = async (rig: MenuRig, line: string): Promise<void> => {
  await rig.session.type(line);
  await press(rig, KEYS.enter);
};
/** Ctrl+D on an empty draft, repeated: storage work may still be settling (Ctrl+D is ignored while busy). */
const quit = async (rig: MenuRig): Promise<number> => {
  const outcome: { code: number | undefined } = { code: undefined };
  void rig.session.result.then((done) => { outcome.code = done.code; });
  const exited = (): boolean => outcome.code !== undefined;
  for (let i = 0; i < 600 && !exited(); i += 1) {
    await press(rig, KEYS.ctrlU);
    await press(rig, KEYS.ctrlD);
    if (!exited()) await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  assert.ok(outcome.code !== undefined, "the program exited");
  return outcome.code;
};
/** F2, move to `index`, Enter - and wait for the switch notice. */
async function chooseModel(rig: MenuRig, index: number, name: string): Promise<void> {
  await press(rig, KEYS.f2);
  await until(() => term(rig).text().includes("SELECT "), "model menu");
  await press(rig, KEYS.home);
  for (let i = 0; i < index; i += 1) await press(rig, KEYS.down);
  await press(rig, KEYS.enter);
  await until(() => term(rig).flat().includes(`Now using Ollama / ${name}.`), `switch to ${name}`);
  await settleAll();
}

/** The saved active selection, or undefined while the file does not exist yet (writes are asynchronous). */
async function activeSelection(): Promise<ReturnType<typeof decodeActiveSelection> | undefined> {
  try {
    return decodeActiveSelection(await readFile(join(tree.app, "active.json")));
  } catch {
    return undefined;
  }
}

const fsDeps = {
  createHistoryStore: (directory: string) => new HistoryStore(directory),
  createSettingsStore: (path: string) => new SettingsStore(path),
};

const stored = (id: string, model: string, updatedAt: string, messages: readonly string[], inputTokens?: bigint): StoredConversation => ({
  id,
  createdAt: new Date("2026-10-20T07:00:00.000Z"),
  updatedAt: new Date(updatedAt),
  provider: "ollama",
  model,
  messages: messages.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content })),
  requests: inputTokens === undefined ? [] : [{ at: new Date("2026-10-20T07:01:00.000Z"), provider: "ollama", model, status: "completed", usage: { inputTokens, outputTokens: 2n } }],
});

async function seed(conversations: StoredConversation[]): Promise<Map<string, { bytes: string; mtime: number }>> {
  await mkdir(tree.conversations, { recursive: true, mode: 0o700 });
  const seen = new Map<string, { bytes: string; mtime: number }>();
  for (const [index, conversation] of conversations.entries()) {
    const path = join(tree.conversations, `${conversation.id}.json`);
    await writeFile(path, encodeConversation(conversation), { mode: 0o600 });
    const when = new Date(Date.UTC(2026, 9, 21, 12, index));
    await utimes(path, when, when);
    seen.set(conversation.id, { bytes: await readFile(path, "utf8"), mtime: (await stat(path)).mtimeMs });
  }
  return seen;
}

const ID_Q = "11111111-1111-4111-8111-111111111111";
const ID_L = "22222222-2222-4222-8222-222222222222";

void describe("switching with the real history store", () => {
  void it("a restored target is not rewritten (bytes and mtime), active.json follows, a new target is saved empty", async () => {
    const seen = await seed([
      stored(ID_Q, "qwen3.5:4b", "2026-10-21T09:00:00.000Z", ["qwen q", "qwen a"], 10n),
      stored(ID_L, "llama3.2:3b", "2026-10-21T08:00:00.000Z", ["llama q", "llama a"], 7n),
    ]);
    const rig = await startMenuTui({ tree, deps: fsDeps });
    assert.ok(term(rig).flat().includes("YOU > qwen q"), "the startup selection restored its own conversation");
    await chooseModel(rig, 1, "llama3.2:3b");
    assert.ok(term(rig).flat().includes("Now using Ollama / llama3.2:3b. Restored its conversation (2 messages)."));
    assert.ok(term(rig).flat().includes("YOU > llama q") && !term(rig).flat().includes("qwen q"));
    const panel = term(rig).lines().map((line) => line.slice(60, 78).trim());
    assert.ok(panel.includes("in 7 out 2"), "usage of the restored conversation only");
    for (const [id, before] of seen) {
      const path = join(tree.conversations, `${id}.json`);
      assert.equal(await readFile(path, "utf8"), before.bytes, "bytes unchanged");
      assert.equal((await stat(path)).mtimeMs, before.mtime, "mtime unchanged");
    }
    await eventually(async () => (await activeSelection())?.model === "llama3.2:3b", "active.json follows the switch");
    assert.deepEqual(await activeSelection(), { provider: "ollama", model: "llama3.2:3b" });
    await chooseModel(rig, 2, "gemma:2b");
    await eventually(async () => (await readdir(tree.conversations)).length === 3, "the new empty conversation file");
    const files = await readdir(tree.conversations);
    const created = files.filter((name) => !name.startsWith("1111") && !name.startsWith("2222"));
    const fresh = decodeConversation(await readFile(join(tree.conversations, created[0] ?? "")));
    assert.deepEqual([fresh.provider, fresh.model, fresh.messages.length, fresh.requests.length], ["ollama", "gemma:2b", 0, 0]);
    await eventually(async () => (await activeSelection())?.model === "gemma:2b", "active.json follows the second switch");
    assert.equal(await quit(rig), 0);
  });

  void it("equal updated_at ties go to the newer file modification time; unreadable files are skipped with the unchanged warning", async () => {
    await seed([
      stored(ID_Q, "qwen3.5:4b", "2026-10-21T09:00:00.000Z", ["qwen q", "qwen a"]),
      stored(ID_L, "llama3.2:3b", "2026-10-21T08:00:00.000Z", ["older llama", "x"]), // earlier mtime
      stored("33333333-3333-4333-8333-333333333333", "llama3.2:3b", "2026-10-21T08:00:00.000Z", ["newer llama", "y"]), // later mtime
    ]);
    await writeFile(join(tree.conversations, "44444444-4444-4444-8444-444444444444.json"), "{ not json", { mode: 0o600 });
    const rig = await startMenuTui({ tree, deps: fsDeps });
    await chooseModel(rig, 1, "llama3.2:3b");
    assert.ok(term(rig).flat().includes("YOU > newer llama"), "the file with the newer mtime wins the tie");
    assert.ok(term(rig).flat().includes("Warning: Ignoring unreadable conversation file"), "the unreadable file is reported");
    assert.equal(await readFile(join(tree.conversations, "44444444-4444-4444-8444-444444444444.json"), "utf8"), "{ not json", "and left unchanged");
    assert.equal(await quit(rig), 0);
  });

  void it("a file for the same model with a legacy provider matches only OpenAI, and is adopted without being rewritten", async () => {
    const legacy = without(stored(ID_L, "gpt-6-luna", "2026-10-21T08:00:00.000Z", ["old q", "old a"]), "provider", "model");
    await mkdir(tree.conversations, { recursive: true, mode: 0o700 });
    const bytes = encodeConversation(legacy);
    await writeFile(join(tree.conversations, `${ID_L}.json`), bytes, { mode: 0o600 });
    const rig = await startMenuTui({ tree, deps: fsDeps });
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Now using OpenAI / gpt-6-luna. Restored its conversation (2 messages)."), "restored legacy");
    assert.equal(await readFile(join(tree.conversations, `${ID_L}.json`), "utf8"), bytes);
    assert.equal(await quit(rig), 0);
  });

  void it("--no-history keeps the registry in memory: no state directory is created while settings are still saved", async () => {
    const rig = await startMenuTui({ tree, deps: fsDeps, argv: ["--provider", "ollama", "--model", "qwen3.5:4b", "--no-history"] });
    await submit(rig, "memory one");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await chooseModel(rig, 1, "llama3.2:3b");
    assert.ok(term(rig).flat().includes("Started a new conversation; the previous messages are not sent to the new model."));
    await submit(rig, "memory two");
    await until(() => rig.ollama.calls === 2, "second request");
    assert.deepEqual(rig.ollama.sent(1), ["user: memory two"]);
    await chooseModel(rig, 0, "qwen3.5:4b");
    assert.ok(term(rig).flat().includes("YOU > memory one") && term(rig).flat().includes("Restored its conversation (2 messages)."));
    await press(rig, KEYS.f6);
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await eventually(async () => (await readdir(dirname(tree.settings)).catch(() => [] as string[])).includes("settings.json"), "settings saved");
    assert.equal(await readdir(tree.state).catch(() => "missing"), "missing", "no state directory was created");
    assert.ok((await readdir(dirname(tree.settings))).includes("settings.json"), "preferences still persist");
    assert.equal(await quit(rig), 0);
  });
});

void describe("conversation lifecycle across selections", () => {
  void it("/reset archives only the active selection; A -> reset -> B -> A returns A's empty post-reset conversation", async () => {
    const history = new MemoryHistory();
    const rig = await startMenuTui({ history });
    await submit(rig, "a1");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await chooseModel(rig, 1, "llama3.2:3b");
    await submit(rig, "b1");
    await until(() => rig.ollama.calls === 2, "b");
    await until(() => term(rig).status().startsWith("DONE"), "DONE b");
    await chooseModel(rig, 0, "qwen3.5:4b");
    await submit(rig, "/reset");
    await until(() => term(rig).flat().includes("Started a new conversation. The previous one stays saved."), "reset");
    await chooseModel(rig, 1, "llama3.2:3b");
    assert.ok(term(rig).flat().includes("YOU > b1"), "the other selection was untouched by the reset");
    await chooseModel(rig, 0, "qwen3.5:4b");
    assert.ok(!term(rig).flat().includes("YOU > a1"), "the archived conversation does not come back");
    assert.ok(term(rig).flat().includes("Now using Ollama / qwen3.5:4b. Started a new conversation; the previous one stays saved."));
    await submit(rig, "a2");
    await until(() => rig.ollama.calls === 3, "a2");
    assert.deepEqual(rig.ollama.sent(2), ["user: a2"]);
    assert.equal(await quit(rig), 0);
  });

  void it("a confirmed /cleanup forgets every remembered selection; a failed one keeps them", async () => {
    const history = new MemoryHistory();
    history.files = 2;
    const rig = await startMenuTui({ history });
    await submit(rig, "keep me");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await chooseModel(rig, 1, "llama3.2:3b");
    // partial failure: the state is not reported as cleaned up and the remembered conversation survives
    history.deleteResult = { deleted: 1, error: { message: "cannot delete x.json" } };
    await submit(rig, "/cleanup");
    await until(() => term(rig).flat().includes("Delete 2 saved conversation(s)"), "question");
    await submit(rig, "yes");
    await until(() => term(rig).flat().includes("Error: cannot delete x.json Deleted 1 saved conversation(s) before the failure"), "failure shown");
    await chooseModel(rig, 0, "qwen3.5:4b");
    assert.ok(term(rig).flat().includes("YOU > keep me"), "memory kept after a partial failure");
    // success: everything goes
    history.deleteResult = undefined;
    await submit(rig, "/cleanup");
    await until(() => term(rig).status() === "WARNING | Type yes to delete saved conversations; anything else cancels", "question again");
    await submit(rig, "yes");
    await until(() => term(rig).flat().includes("Deleted 2 saved conversation(s). Started a new conversation."), "cleaned");
    await chooseModel(rig, 1, "llama3.2:3b");
    await chooseModel(rig, 0, "qwen3.5:4b");
    assert.ok(!term(rig).flat().includes("keep me"), "nothing resurrected");
    assert.equal(await quit(rig), 0);
  });

  void it("--transcript-on-exit prints only the current selection's committed messages", async () => {
    const rig = await startMenuTui({ argv: ["--provider", "ollama", "--model", "qwen3.5:4b", "--transcript-on-exit"] });
    await submit(rig, "first selection");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await chooseModel(rig, 1, "llama3.2:3b");
    await submit(rig, "second selection");
    await until(() => rig.ollama.calls === 2, "second");
    await until(() => term(rig).status().startsWith("DONE"), "DONE 2");
    assert.equal(await quit(rig), 0);
    const done = await rig.session.result;
    assert.equal(done.out, "YOU > second selection\n\nAI > reply 2\n");
  });
});

void describe("busy states and exits around switching", () => {
  void it("no switch or settings change while generating, cancelling or saving; the menu is never shown stale", async () => {
    const gate = deferred();
    const history = new MemoryHistory();
    const rig = await startMenuTui({ history });
    rig.ollama.push(async () => {
      await gate.promise;
      return { kind: "completed", result: { text: "late" } };
    });
    await submit(rig, "slow");
    await press(rig, KEYS.f2);
    assert.equal(term(rig).status(), "WARNING | Settings cannot change while a response is generated");
    await press(rig, KEYS.f6);
    assert.ok(!term(rig).text().includes("ANSWER STYLE ]"));
    gate.resolve();
    await until(() => history.saved.length === 1, "saved");
    rig.session.timers.advance(2100);
    await settleAll();
    await press(rig, KEYS.f6);
    assert.ok(term(rig).text().includes("ANSWER STYLE ]"));
    assert.equal(rig.ollama.listCalls, 0);
    await press(rig, KEYS.ctrlD);
    assert.equal(await quit(rig), 0);
  });

  void it("an exit during the accepted writes of a switch finishes them first", async () => {
    const history = new MemoryHistory();
    const rig = await startMenuTui({ history });
    const gate = deferred();
    history.saveGate = gate.promise;
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT "), "menu");
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => history.calls.includes("save"), "the empty target is being saved");
    rig.session.signals.fire("SIGTERM");
    await settleAll(10);
    assert.equal(history.saved.length, 0);
    assert.equal(term(rig).closeCount, 0, "still waiting for the accepted write");
    gate.resolve();
    const done = await finishWithClock(rig.session);
    assert.equal(done.code, 143);
    assert.deepEqual(history.saved.map((c) => c.model), ["llama3.2:3b"]);
    assert.equal(term(rig).closeCount, 1);
  });

  void it("a switch to another provider and back uses each provider for its own requests", async () => {
    const rig = await startMenuTui({ configure: ({ openai }) => { openai.push(answer("from openai")); } });
    await submit(rig, "to ollama");
    await until(() => rig.ollama.calls === 1, "ollama");
    await until(() => term(rig).status().startsWith("DONE"), "DONE");
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Now using OpenAI / gpt-6-luna."), "switched");
    await submit(rig, "to openai");
    await until(() => rig.openai.calls === 1, "openai");
    assert.deepEqual(rig.openai.sent(0), ["user: to openai"]);
    assert.equal(rig.openai.requests[0]?.model, "gpt-6-luna");
    await until(() => term(rig).status().startsWith("DONE"), "DONE 2");
    await press(rig, KEYS.f3);
    await press(rig, KEYS.enter); // Ollama is the second item and the highlight starts on the current provider (OpenAI): Down first
    await settleAll();
    await press(rig, KEYS.f3);
    await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Now using Ollama / qwen3.5:4b. Restored its conversation (2 messages)."), "back");
    assert.deepEqual(rig.created, ["ollama", "openai"]);
    assert.equal(rig.ollama.availabilityCalls, 1);
    assert.equal(await quit(rig), 0);
  });
});

void describe("settings location problems", () => {
  void it("a corrupt settings file is reported at startup and never overwritten through the menus", async () => {
    await mkdir(dirname(tree.settings), { recursive: true });
    await writeFile(tree.settings, "{ not json");
    const rig = await startMenuTui({ tree, deps: fsDeps });
    assert.ok(term(rig).flat().includes("Ignoring invalid settings file"));
    await press(rig, KEYS.f6);
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await until(() => term(rig).status() === "WARNING | Settings not saved", "warning");
    assert.ok(term(rig).flat().includes("could not be read at startup") || term(rig).flat().includes("Warning:"));
    assert.equal(await readFile(tree.settings, "utf8"), "{ not json");
    await submit(rig, "x");
    await until(() => rig.ollama.calls === 1, "request");
    assert.ok((rig.ollama.requests[0]?.instructions ?? "").length > 0, "the choice is effective in memory");
    assert.equal(await quit(rig), 0);
  });

  void it("without a usable configuration location a change stays in memory with a visible warning", async () => {
    const rig = await startMenuTui({ deps: { storageEnvironment: { env: {} } } });
    assert.ok(term(rig).flat().includes("Cannot determine the home directory; settings are not loaded or saved."));
    await press(rig, KEYS.f6);
    await press(rig, KEYS.home);
    await press(rig, KEYS.enter);
    await until(() => term(rig).status() === "WARNING | Settings not saved", "warning");
    assert.ok(term(rig).flat().includes("Warning: Settings not saved: the configuration location is not known."));
    assert.equal(rig.store.saves.length, 0);
    assert.equal(await quit(rig), 0);
  });

  void it("an exit while a settings write is in flight finishes that write", async () => {
    const rig = await startMenuTui();
    const gate = deferred();
    const original = rig.store.save.bind(rig.store);
    rig.store.save = async (settings) => {
      await gate.promise;
      return original(settings);
    };
    await press(rig, KEYS.f6);
    await press(rig, KEYS.end);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Answer style: Detailed."), "confirmed");
    rig.session.signals.fire("SIGHUP");
    await settleAll(10);
    assert.equal(term(rig).closeCount, 0);
    gate.resolve();
    const done = await finishWithClock(rig.session);
    assert.equal(done.code, 129);
    assert.equal(rig.store.stored.answerStyle, "detailed");
  });
});

void it("catalog providers keep the label of the real adapters", () => {
  assert.equal(new CatalogProvider("openai", []).label, "OpenAI");
  assert.equal(new CatalogProvider("ollama", []).label, "Ollama");
});

// A conversation file without provider/model matches any model of OpenAI; once a selection of this run adopted it,
// no other selection may adopt it too (they would share an id and overwrite each other's exchanges).
void describe("adopting a legacy (model-less) conversation file", () => {
  const legacyFile = (): StoredConversation =>
    without(stored(ID_L, "unused", "2026-10-21T08:00:00.000Z", ["legacy q", "legacy a"], 5n), "provider", "model");

  const openaiModels = ({ openai }: { openai: MenuRig["openai"] }): void => {
    openai.models = [model("model-a"), model("model-b")];
  };
  const argvA = ["--provider", "openai", "--model", "model-a"];

  async function chooseOpenAi(rig: MenuRig, index: number, name: string): Promise<void> {
    await press(rig, KEYS.f2);
    await until(() => term(rig).text().includes("SELECT OPENAI MODEL"), "menu");
    await press(rig, KEYS.home);
    for (let i = 0; i < index; i += 1) await press(rig, KEYS.down);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes(`Now using OpenAI / ${name}.`), `switch to ${name}`);
  }

  /** Types a line and presses Enter until `started()`: Enter is refused while a switch's storage writes settle. */
  async function send(rig: MenuRig, line: string, started: () => boolean): Promise<void> {
    await rig.session.type(line);
    for (let i = 0; i < 300 && !started(); i += 1) {
      await press(rig, KEYS.enter);
      if (!started()) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
    assert.ok(started(), `"${line}" was sent`);
    rig.session.timers.advance(2100); // the refusals' warning flash ends, so the DONE status shows
  }

  const files = async (): Promise<string[]> => (await readdir(tree.conversations)).sort();
  const load = async (name: string) => decodeConversation(await readFile(join(tree.conversations, name)));

  void it("A -> B -> A keeps distinct ids and files, independent contexts and usage; a restart restores both exchanges", async () => {
    await mkdir(tree.conversations, { recursive: true, mode: 0o700 });
    const original = encodeConversation(legacyFile());
    await writeFile(join(tree.conversations, `${ID_L}.json`), original, { mode: 0o600 });

    const rig = await startMenuTui({ tree, deps: fsDeps, argv: argvA, configure: (p) => { openaiModels(p); p.openai.push(answer("answer b", { inputTokens: 7n }), answer("answer a", { inputTokens: 11n })); } });
    assert.ok(term(rig).flat().includes("YOU > legacy q"), "startup adopted the legacy file as model-a");

    // B before A rewrote the file: B must not inherit it
    await chooseOpenAi(rig, 1, "model-b");
    assert.ok(term(rig).flat().includes("Started a new conversation"), term(rig).flat());
    assert.ok(!term(rig).flat().includes("legacy q"));
    assert.equal(await readFile(join(tree.conversations, `${ID_L}.json`), "utf8"), original, "the legacy file was not rewritten to claim it");
    await send(rig, "qb", () => rig.openai.calls === 1);
    await until(() => term(rig).status().startsWith("DONE"), `B answered (status: ${term(rig).status()}; ${term(rig).flat().slice(-300)})`);
    assert.deepEqual(rig.openai.sent(0), ["user: qb"], "no context of A");

    await chooseOpenAi(rig, 0, "model-a");
    assert.ok(term(rig).flat().includes("legacy q"), "A is back from memory");
    await send(rig, "qa2", () => rig.openai.calls === 2);
    await until(() => term(rig).status().startsWith("DONE"), "A answered");
    assert.deepEqual(rig.openai.sent(1), ["user: legacy q", "assistant: legacy a", "user: qa2"], "no context of B");
    assert.equal(await quit(rig), 0);

    const names = await files();
    assert.equal(names.length, 2, "two files, none overwritten");
    const [a, b] = await Promise.all([load(`${ID_L}.json`), load(names.find((n) => n !== `${ID_L}.json`) ?? "")]);
    assert.deepEqual([a.provider, a.model, a.messages.map((m) => m.content)], ["openai", "model-a", ["legacy q", "legacy a", "qa2", "answer a"]]);
    assert.deepEqual([b.provider, b.model, b.messages.map((m) => m.content)], ["openai", "model-b", ["qb", "answer b"]]);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(a.requests.map((q) => q.usage.inputTokens), [5n, 11n]);
    assert.deepEqual(b.requests.map((q) => q.usage.inputTokens), [7n]);

    // restart: both exchanges come back correctly
    const again = await startMenuTui({ tree, deps: fsDeps, argv: argvA, configure: (p) => { openaiModels(p); p.openai.push(answer("later b")); } });
    assert.ok(term(again).flat().includes("YOU > qa2") && term(again).flat().includes("AI > answer a"));
    await chooseOpenAi(again, 1, "model-b");
    assert.ok(term(again).flat().includes("Restored its conversation (2 messages)."));
    assert.ok(term(again).flat().includes("YOU > qb") && !term(again).flat().includes("qa2"));
    await send(again, "qb2", () => again.openai.calls === 1);
    assert.deepEqual(again.openai.sent(0), ["user: qb", "assistant: answer b", "user: qb2"]);
    assert.equal(await quit(again), 0);
  });

  void it("B receives another eligible unclaimed file, never the one A adopted", async () => {
    await mkdir(tree.conversations, { recursive: true, mode: 0o700 });
    const other = without(stored("33333333-3333-4333-8333-333333333333", "unused", "2026-10-21T07:00:00.000Z", ["other q", "other a"]), "provider", "model");
    await writeFile(join(tree.conversations, `${ID_L}.json`), encodeConversation(legacyFile()), { mode: 0o600 });
    await writeFile(join(tree.conversations, `${other.id}.json`), encodeConversation(other), { mode: 0o600 });
    const rig = await startMenuTui({ tree, deps: fsDeps, argv: argvA, configure: openaiModels });
    assert.ok(term(rig).flat().includes("legacy q"), "the newest file went to the startup selection");
    await chooseOpenAi(rig, 1, "model-b");
    assert.ok(term(rig).flat().includes("Restored its conversation (2 messages)."));
    assert.ok(term(rig).flat().includes("YOU > other q") && !term(rig).flat().includes("legacy q"));
    assert.equal(await quit(rig), 0);
  });

  void it("a cancelled preparation claims nothing and writes nothing", async () => {
    await mkdir(tree.conversations, { recursive: true, mode: 0o700 });
    const original = encodeConversation(legacyFile());
    await writeFile(join(tree.conversations, `${ID_L}.json`), original, { mode: 0o600 });
    const gate = deferred();
    const rig = await startMenuTui({ tree, deps: fsDeps, configure: ({ openai }) => { openai.gates.capabilities = gate.promise; } });
    assert.ok(!term(rig).flat().includes("legacy q"), "Ollama does not adopt a legacy (OpenAI) file");
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up);
    await press(rig, KEYS.enter);
    await until(() => rig.openai.capabilityCalls.length === 1, "preparation running");
    await press(rig, KEYS.ctrlC);
    await until(() => term(rig).status() === "CANCELLED", "cancelled");
    gate.resolve();
    await settleAll(10);
    assert.deepEqual(await files(), [`${ID_L}.json`], "nothing was written");
    assert.equal(await readFile(join(tree.conversations, `${ID_L}.json`), "utf8"), original);
    await assert.rejects(readFile(join(tree.app, "active.json")), /ENOENT/u);
    // a later, completed switch can still adopt the unclaimed file
    await press(rig, KEYS.f3);
    await press(rig, KEYS.up);
    await press(rig, KEYS.enter);
    await until(() => term(rig).flat().includes("Now using OpenAI / gpt-6-luna. Restored its conversation (2 messages)."), "adopted");
    assert.equal(await readFile(join(tree.conversations, `${ID_L}.json`), "utf8"), original, "adopting does not rewrite it");
    assert.equal(await quit(rig), 0);
  });
});
