import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { NO_SETTINGS_LOCATION, PreferencesService } from "../src/application/preferences.js";
import type { StoredSettings } from "../src/storage/types.js";
import { encodeSettings } from "../src/storage/settings.js";
import { SettingsStore } from "../src/storage/fs/settings-store.js";
import { FakeSettingsStore, LEVELS, settingsDoc } from "./helpers/menus.js";
import { makeTree } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

let tree: Tree;
beforeEach(async () => {
  tree = await makeTree();
});
afterEach(async () => {
  await tree.cleanup();
});

const service = (store: FakeSettingsStore | undefined, overrides = {}): PreferencesService =>
  new PreferencesService({ stored: store?.stored, saver: store, overrides });

void describe("choices: what changes, what is written", () => {
  void it("an unchanged saved choice with no override changes nothing and writes nothing; provenance changes do write", async () => {
    const store = new FakeSettingsStore(settingsDoc("normal", { ollama: { m: { reasoning: "high", maxOutputTokens: null } } }));
    const prefs = service(store);
    assert.deepEqual(prefs.setReasoning("ollama", "m", "high"), { changed: false, save: undefined });
    assert.deepEqual(prefs.setMaxOutputTokens("ollama", "m", null), { changed: false, save: undefined });
    assert.deepEqual(prefs.setAnswerStyle("normal"), { changed: false, save: undefined });
    assert.equal(store.saves.length, 0);
    // "none" on a model with no entry is a new saved choice even if the effective value would not change
    const fresh = prefs.setReasoning("ollama", "other", "none");
    assert.equal(fresh.changed, true);
    assert.equal(await fresh.save, undefined);
    assert.equal(store.saves.length, 1);
    // explicit default and unset are different stored states
    const toDefault = prefs.setReasoning("ollama", "m", "default");
    assert.equal(toDefault.changed, true);
    await toDefault.save;
    assert.equal(store.stored.providers.get("ollama")?.get("m")?.reasoning, "default");
    assert.equal(store.stored.providers.get("ollama")?.get("m")?.maxOutputTokens, null, "the other field of the entry is kept");
  });

  void it("a command-line override is cleared by exactly its own field's confirmed choice, even when the file already agrees", async () => {
    const store = new FakeSettingsStore(settingsDoc("brief", { ollama: { m: { reasoning: "high", maxOutputTokens: 300n } } }));
    const prefs = service(store, { reasoning: "high", maxOutputTokens: 300, answerStyle: "brief" });
    assert.deepEqual(prefs.remainingOverrides, { reasoning: "high", maxOutputTokens: 300, answerStyle: "brief" });
    const same = prefs.setReasoning("ollama", "m", "high");
    assert.deepEqual({ changed: same.changed, save: same.save }, { changed: true, save: undefined }, "the override goes, the file needs no write");
    assert.deepEqual(prefs.remainingOverrides, { maxOutputTokens: 300, answerStyle: "brief" });
    const other = prefs.setMaxOutputTokens("ollama", "m", 512n);
    await other.save;
    assert.deepEqual(prefs.remainingOverrides, { answerStyle: "brief" });
    assert.equal(store.saves.length, 1);
    prefs.setAnswerStyle("normal");
    assert.deepEqual(prefs.remainingOverrides, {});
  });

  void it("nothing is written by resolving: the CLI values are never saved", () => {
    const store = new FakeSettingsStore();
    const prefs = service(store, { reasoning: "high", maxOutputTokens: 77, answerStyle: "detailed" });
    const resolution = prefs.resolveFor("ollama", "m", LEVELS);
    assert.deepEqual(resolution.settings.reasoning, { effort: "high", explicit: true, source: "cli" });
    assert.equal(resolution.settings.maxOutputTokens.value, 77);
    assert.equal(resolution.settings.answerStyle.value, "detailed");
    assert.equal(store.saves.length, 0);
  });

  void it("strict startup and lenient switching: unusable remaining values give the resolver's notices and fall through to saved", () => {
    const store = new FakeSettingsStore(settingsDoc("normal", { ollama: { "llama3.2:3b": { reasoning: "high", maxOutputTokens: 9000n } } }));
    const prefs = service(store, { reasoning: "model-default", maxOutputTokens: 9999 });
    const capabilities = { reasoning: { known: true, values: ["off", "on"], allowsModelDefault: false, defaultValue: "off" }, maxOutputTokensLimit: 4096 };
    const { settings, notices } = prefs.resolveFor("ollama", "llama3.2:3b", capabilities);
    assert.deepEqual(notices, [
      "llama3.2:3b has no model-default reasoning choice (llama3.2:3b supports reasoning: Off, On); ignoring the command-line value.",
      "Saved reasoning 'High' is not available for llama3.2:3b (llama3.2:3b supports reasoning: Off, On); using Off.",
      "9999 exceeds the limit of 4096 output tokens for llama3.2:3b. Using the default.",
      "Saved setting ignored: 9000 exceeds the limit of 4096 output tokens for llama3.2:3b. Using the default.",
    ]);
    assert.deepEqual(settings.reasoning, { effort: "off", explicit: false, source: "builtin" });
    assert.equal(settings.maxOutputTokens.value, undefined);
    assert.equal(store.saves.length, 0, "the file is not rewritten for unusable saved values");
    assert.deepEqual(prefs.resolveFor("ollama", "m", LEVELS).settings.reasoning.source, "cli");
  });
});

void describe("saving", () => {
  void it("writes are encoded in order from snapshots and a failure keeps the choice for a later retry", async () => {
    const store = new FakeSettingsStore();
    store.results = [{ saved: false, warning: "disk full" }];
    const prefs = service(store);
    const first = prefs.setAnswerStyle("brief");
    const second = prefs.setReasoning("ollama", "m", "low");
    assert.equal(await first.save, "disk full");
    assert.equal(await second.save, undefined);
    const [one, two] = store.saves;
    assert.ok(one !== undefined && two !== undefined);
    assert.equal(one.answerStyle, "brief");
    assert.equal(one.providers.size, 0, "the first snapshot does not contain the later change");
    assert.equal(two.answerStyle, "brief", "the retry carries the failed change");
    assert.equal(two.providers.get("ollama")?.get("m")?.reasoning, "low");
    assert.equal(prefs.document.answerStyle, "brief");
  });

  void it("without a settings location the change stays in memory with a fixed warning", async () => {
    const prefs = new PreferencesService({ stored: undefined, saver: undefined, overrides: {} });
    const choice = prefs.setAnswerStyle("detailed");
    assert.equal(choice.changed, true);
    assert.equal(await choice.save, NO_SETTINGS_LOCATION);
    assert.equal(prefs.resolveFor("openai", "m", LEVELS).settings.answerStyle.value, "detailed");
  });

  void it("a value the codec cannot encode is a warning, not an exception", async () => {
    const store = new SettingsStore(tree.settings);
    const loaded = await store.load();
    const prefs = new PreferencesService({ stored: loaded.settings, saver: store, overrides: {} });
    const warning = await prefs.setReasoning("ollama", "lone-surrogate-\uD800", "low").save;
    assert.match(warning ?? "", /^Settings not saved: /u);
    await assert.rejects(stat(tree.settings), /ENOENT/u);
  });
});

void describe("the original SettingsStore", () => {
  void it("a missing file is normal: the first confirmed change creates directory and file with private modes, canonically", async () => {
    const store = new SettingsStore(tree.settings);
    const loaded = await store.load();
    assert.deepEqual(loaded.warnings, []);
    const prefs = new PreferencesService({ stored: loaded.settings, saver: store, overrides: {} });
    await assert.rejects(stat(dirname(tree.settings)), /ENOENT/u, "loading creates nothing");
    const choice = prefs.setMaxOutputTokens("ollama", "a/b:c", 2n ** 70n);
    assert.equal(await choice.save, undefined);
    assert.equal(await readFile(tree.settings, "utf8"), encodeSettings(prefs.document));
    assert.equal((await stat(tree.settings)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(tree.settings))).mode & 0o777, 0o700);
    assert.ok((await readFile(tree.settings, "utf8")).includes("1180591620717411303429") || (await readFile(tree.settings, "utf8")).includes("1180591620717411303424"));
  });

  void it("a corrupt settings file is never overwritten in this run, even after it is repaired externally", async () => {
    await mkdir(dirname(tree.settings), { recursive: true });
    await writeFile(tree.settings, "{ not json");
    const store = new SettingsStore(tree.settings);
    const loaded = await store.load();
    assert.equal(loaded.saveEnabled, false);
    const prefs = new PreferencesService({ stored: loaded.settings, saver: store, overrides: {} });
    const warning = await prefs.setAnswerStyle("brief").save;
    assert.match(warning ?? "", /could not be read at startup/u);
    assert.equal(await readFile(tree.settings, "utf8"), "{ not json");
    await writeFile(tree.settings, encodeSettings(settingsDoc("normal", {})));
    const repaired = await readFile(tree.settings, "utf8");
    assert.match((await prefs.setReasoning("ollama", "m", "low").save) ?? "", /could not be read at startup/u);
    assert.equal(await readFile(tree.settings, "utf8"), repaired, "the instance stays disabled");
    assert.equal(prefs.resolveFor("ollama", "m", LEVELS).settings.answerStyle.value, "brief", "the choice still applies in memory");
  });

  void it("a symlinked settings file is never written through", async () => {
    await mkdir(dirname(tree.settings), { recursive: true });
    const target = join(tree.root, "elsewhere.json");
    await writeFile(target, "keep");
    await symlink(target, tree.settings);
    const store = new SettingsStore(tree.settings);
    const loaded = await store.load();
    const prefs = new PreferencesService({ stored: loaded.settings, saver: store, overrides: {} });
    assert.ok((await prefs.setAnswerStyle("brief").save) !== undefined);
    assert.equal(await readFile(target, "utf8"), "keep");
  });

  void it("a write failure is a visible warning, the old bytes stay and the choice stays effective", async () => {
    const store = new SettingsStore(tree.settings);
    const loaded = await store.load(); // missing file: writable
    const prefs = new PreferencesService({ stored: loaded.settings, saver: store, overrides: {} });
    await mkdir(dirname(dirname(tree.settings)), { recursive: true });
    await writeFile(dirname(tree.settings), "i am a file where the directory should be");
    const warning = await prefs.setAnswerStyle("brief").save;
    assert.ok(warning !== undefined, "the failure is reported");
    assert.equal(await readFile(dirname(tree.settings), "utf8"), "i am a file where the directory should be");
    assert.equal(prefs.document.answerStyle, "brief", "memory keeps the choice");
  });
});

void it("settingsDoc builds documents the codec accepts", () => {
  const doc: StoredSettings = settingsDoc("detailed", { ollama: { m: { reasoning: "low", maxOutputTokens: 5n } } });
  assert.ok(encodeSettings(doc).includes('"detailed"'));
});
