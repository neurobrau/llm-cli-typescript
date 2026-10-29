import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { isAbortError } from "../src/domain/errors.js";
import { nodeFs, SettingsStore, StorageIoError } from "../src/storage/fs/index.js";
import { encodeSettings } from "../src/storage/index.js";
import type { StoredModelPreferences, StoredSettings } from "../src/storage/index.js";
import { settingsCases } from "./helpers/storage-cases.js";
import { errno, gate, makeTree, names, put, text, withFs } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

const POSIX = process.platform !== "win32";
let tree: Tree;

beforeEach(async () => {
  tree = await makeTree();
});
afterEach(async () => {
  await tree.cleanup();
});

const settingsWith = (models: Map<string, StoredModelPreferences>): StoredSettings => ({ answerStyle: "brief", providers: new Map([["openai", models]]) });

void describe("settings: loading", () => {
  void it("a missing file gives defaults, no warning, and creates nothing", async () => {
    const store = new SettingsStore(tree.settings);
    assert.equal(store.saveEnabled, false);
    const loaded = await store.load();
    assert.equal(loaded.settings.answerStyle, "normal");
    assert.equal(loaded.settings.providers.size, 0);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.saveEnabled, true);
    assert.equal(store.saveEnabled, true);
    await assert.rejects(stat(tree.root + "/config"), { code: "ENOENT" });
  });

  void it("round-trips the fixture settings byte for byte, with exact huge limits and null/absent distinctions", async () => {
    for (const { value } of settingsCases) {
      const store = new SettingsStore(tree.settings);
      await store.load();
      assert.deepEqual(await store.save(value), { saved: true, directorySynced: true });
      assert.equal(await text(tree.settings), encodeSettings(value));
      const again = new SettingsStore(tree.settings);
      const loaded = await again.load();
      assert.deepEqual(loaded.settings, value);
      assert.deepEqual(loaded.warnings, []);
    }
    const huge = 2n ** 70n + 5n;
    const store = new SettingsStore(tree.settings);
    await store.load();
    await store.save(settingsWith(new Map([["m", { maxOutputTokens: huge }], ["n", { maxOutputTokens: null }], ["o", { reasoning: "low" }]])));
    const models = (await new SettingsStore(tree.settings).load()).settings.providers.get("openai");
    assert.ok(models);
    assert.equal(models.get("m")?.maxOutputTokens, huge);
    assert.equal(models.get("n")?.maxOutputTokens, null);
    const reasoningOnly = models.get("o");
    assert.ok(reasoningOnly && !("maxOutputTokens" in reasoningOnly));
  });

  void it("keeps usable entries and returns notices without disabling saves", async () => {
    await put(tree.settings, '{"schema_version": 1, "answer_style": "chatty", "providers": {"openai": {"models": {"a": {"reasoning": ""}, "b": {"reasoning": "low"}}}}}');
    const store = new SettingsStore(tree.settings);
    const loaded = await store.load();
    assert.equal(loaded.warnings.length, 2);
    assert.equal(loaded.saveEnabled, true);
    assert.equal(loaded.settings.providers.get("openai")?.get("b")?.reasoning, "low");
    assert.deepEqual(await store.save(loaded.settings), { saved: true, directorySynced: true });
    assert.equal((await new SettingsStore(tree.settings).load()).warnings.length, 0, "the rewrite dropped the invalid entries");
  });

  void it("is deterministic about notice order for unknown provider/model keys", async () => {
    await put(tree.settings, '{"schema_version": 1, "providers": {"__proto__": {"models": {"constructor": {"reasoning": 5}}}}}');
    const loaded = await new SettingsStore(tree.settings).load();
    assert.equal(loaded.warnings.length, 1);
  });
});

void describe("settings: whole-file failures disable saving for the instance", () => {
  const broken: readonly [string, string | Uint8Array][] = [
    ["malformed JSON", '{"schema_version": 1, "answer_style": '],
    ["schema 2", '{"schema_version": 2}'],
    ["providers list", '{"schema_version": 1, "providers": []}'],
    ["providers null", '{"schema_version": 1, "providers": null}'],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
    ["empty file", ""],
  ];
  for (const [name, content] of broken) {
    void it(`${name}: defaults, one warning, refused saves, bytes untouched`, async () => {
      await put(tree.settings, content);
      const before = await readFile(tree.settings);
      const store = new SettingsStore(tree.settings);
      const loaded = await store.load();
      assert.equal(loaded.settings.providers.size, 0);
      assert.equal(loaded.saveEnabled, false);
      assert.equal(loaded.warnings.length, 1);
      assert.match(loaded.warnings[0] ?? "", new RegExp(`^Ignoring invalid settings file ${tree.settings.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .+\\. Using defaults; changes will not be saved until the file is fixed or removed\\.$`));
      const refused = await store.save({ answerStyle: "detailed", providers: new Map() });
      assert.deepEqual(refused, {
        saved: false,
        reason: "disabled",
        warning: `Settings not saved: ${tree.settings} could not be read at startup.`,
      });
      assert.deepEqual(await readFile(tree.settings), before);
      assert.deepEqual(await names(tree.config), ["settings.json"]);
    });
  }

  void it("a later load, even of a repaired file, cannot re-enable writes; a new instance can", async () => {
    await put(tree.settings, "{");
    const store = new SettingsStore(tree.settings);
    const first = await store.load();
    await writeFile(tree.settings, encodeSettings(settingsWith(new Map([["m", { reasoning: "low" }]]))));
    const again = await store.load();
    assert.equal(again.saveEnabled, false);
    assert.equal(again.settings.providers.size, 0);
    assert.deepEqual(again.warnings, first.warnings);
    assert.equal((await store.save(settingsWith(new Map()))).saved, false);
    assert.equal(store.saveEnabled, false);
    const repaired = new SettingsStore(tree.settings);
    assert.equal((await repaired.load()).settings.providers.size, 1);
    assert.equal((await repaired.save(settingsWith(new Map()))).saved, true);
  });

  void it("a file that breaks after a good load disables the instance at the next load", async () => {
    const store = new SettingsStore(tree.settings);
    await store.load();
    await store.save(settingsWith(new Map([["m", { reasoning: "low" }]])));
    await writeFile(tree.settings, "oops");
    assert.equal((await store.load()).saveEnabled, false);
    assert.equal((await store.save(settingsWith(new Map()))).saved, false);
    assert.equal(await text(tree.settings), "oops");
  });

  void it("read failures and non-regular entries disable saving with the reference wording", async () => {
    await mkdir(tree.config, { recursive: true });
    const unreadable = new SettingsStore(tree.settings, { fs: withFs({ lstat: () => Promise.reject(errno("EACCES")) }) });
    const failed = await unreadable.load();
    assert.deepEqual(failed.warnings, [`Could not read settings at ${tree.settings}: Permission denied. Using defaults; changes will not be saved.`]);
    assert.equal((await unreadable.save(settingsWith(new Map()))).saved, false);
    await writeFile(tree.settings, "{}");
    const readFails = new SettingsStore(tree.settings, { fs: withFs({ readFile: () => Promise.reject(errno("EIO")) }) });
    assert.match((await readFails.load()).warnings[0] ?? "", /Could not read settings at .*: Input\/output error\./);
    assert.equal(readFails.saveEnabled, false);
  });

  void it("refuses a directory or symlink at the settings path, preserving the entry", { skip: !POSIX }, async () => {
    await mkdir(tree.settings, { recursive: true });
    const asDirectory = new SettingsStore(tree.settings);
    const loaded = await asDirectory.load();
    assert.equal(loaded.warnings[0], `Could not read settings at ${tree.settings}: Not a regular file. Using defaults; changes will not be saved.`);
    assert.equal((await asDirectory.save(settingsWith(new Map()))).saved, false);
    assert.ok((await stat(tree.settings)).isDirectory());
    const second = await makeTree();
    try {
      await mkdir(second.config, { recursive: true });
      const real = join(second.root, "real.json");
      await writeFile(real, "{}");
      await symlink(real, second.settings);
      const store = new SettingsStore(second.settings);
      assert.match((await store.load()).warnings[0] ?? "", /Is a symbolic link/);
      assert.equal((await store.save(settingsWith(new Map()))).saved, false);
      assert.equal(await text(real), "{}");
    } finally {
      await second.cleanup();
    }
  });

  void it("does not block on a FIFO at the settings path", { skip: !POSIX }, async (t) => {
    await mkdir(tree.config, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("mkfifo", [tree.settings]);
    } catch {
      t.skip("mkfifo unavailable");
      return;
    }
    const store = new SettingsStore(tree.settings);
    assert.match((await store.load()).warnings[0] ?? "", /Not a regular file/);
  });
});

void describe("settings: save guard and ordering", () => {
  void it("rejects save-before-load without creating or touching anything", async () => {
    await put(tree.settings, "precious");
    const store = new SettingsStore(tree.settings);
    const outcome = await store.save(settingsWith(new Map()));
    assert.deepEqual(outcome, { saved: false, reason: "not-loaded", warning: `Settings not saved: ${tree.settings} has not been loaded yet.` });
    assert.equal(await text(tree.settings), "precious");
    const fresh = new SettingsStore(join(tree.root, "other", "neurobrau", "settings.json"));
    assert.equal((await fresh.save(settingsWith(new Map()))).saved, false);
    await assert.rejects(stat(join(tree.root, "other")), { code: "ENOENT" });
  });

  void it("an invalid load followed by an immediately queued save cannot overwrite the file", async () => {
    await put(tree.settings, "{broken");
    const before = await readFile(tree.settings);
    const store = new SettingsStore(tree.settings);
    const load = store.load();
    const save = store.save(settingsWith(new Map([["m", { reasoning: "low" }]]))); // not awaiting the load
    const [loaded, saved] = await Promise.all([load, save]);
    assert.equal(loaded.saveEnabled, false);
    assert.deepEqual(saved, { saved: false, reason: "disabled", warning: `Settings not saved: ${tree.settings} could not be read at startup.` });
    assert.deepEqual(await readFile(tree.settings), before);
  });

  void it("operations run in invocation order: save first is refused, load first permits the save", async () => {
    const early = new SettingsStore(tree.settings);
    const [saveFirst, , saveAfter] = await Promise.all([early.save(settingsWith(new Map())), early.load(), early.save(settingsWith(new Map()))]);
    assert.ok(!saveFirst.saved && saveFirst.reason === "not-loaded");
    assert.equal(saveAfter.saved, true);
    const ordered = new SettingsStore(join(tree.root, "ordered", "neurobrau", "settings.json"));
    const results = await Promise.all([ordered.load(), ordered.save(settingsWith(new Map()))]);
    assert.equal(results[1].saved, true);
  });

  void it("serializes concurrent saves in order even when the first is slow", async () => {
    const hold = gate();
    let first = true;
    const store = new SettingsStore(tree.settings, {
      fs: withFs({
        async createExclusive(path, mode) {
          if (first) {
            first = false;
            await hold.enter();
          }
          return nodeFs.createExclusive(path, mode);
        },
      }),
    });
    await store.load();
    const one = store.save(settingsWith(new Map([["m", { reasoning: "one" }]])));
    const two = store.save(settingsWith(new Map([["m", { reasoning: "two" }]])));
    await hold.reached;
    hold.release();
    await Promise.all([one, two]);
    assert.equal((await new SettingsStore(tree.settings).load()).settings.providers.get("openai")?.get("m")?.reasoning, "two");
  });

  void it("snapshots the settings at invocation: later Map mutation does not change a pending write", async () => {
    const hold = gate();
    const store = new SettingsStore(tree.settings, {
      fs: withFs({
        async createExclusive(path, mode) {
          await hold.enter();
          return nodeFs.createExclusive(path, mode);
        },
      }),
    });
    await store.load();
    const models = new Map<string, StoredModelPreferences>([["m", { reasoning: "low" }]]);
    const settings = settingsWith(models);
    const pending = store.save(settings);
    models.set("m", { reasoning: "mutated" });
    models.set("extra", { reasoning: "x" });
    await hold.reached;
    hold.release();
    await pending;
    const loaded = (await new SettingsStore(tree.settings).load()).settings.providers.get("openai");
    assert.ok(loaded);
    assert.equal(loaded.size, 1);
    assert.equal(loaded.get("m")?.reasoning, "low");
  });

  void it("returns a recoverable outcome for an I/O failure, keeps the old bytes, and stays writable", async () => {
    const store = new SettingsStore(tree.settings, { fs: withFs({ rename: (from, to) => (from.includes("settings") ? Promise.reject(errno("ENOSPC")) : nodeFs.rename(from, to)) }) });
    await store.load();
    const first = await store.save(settingsWith(new Map()));
    assert.ok(!first.saved && first.reason === "io-error");
    assert.equal(first.warning, `Could not save settings at ${tree.settings}: No space left on device.`);
    assert.ok(first.error instanceof StorageIoError);
    assert.equal(store.saveEnabled, true);
    await assert.rejects(stat(tree.settings), { code: "ENOENT" });
    assert.deepEqual(await names(tree.config), []);
  });

  void it("rejects with the project's AbortError when cancelled and rejects invalid values", async () => {
    const store = new SettingsStore(tree.settings);
    await store.load();
    const controller = new AbortController();
    controller.abort("whatever");
    await assert.rejects(store.save(settingsWith(new Map()), { signal: controller.signal }), (error: unknown) => isAbortError(error));
    assert.throws(() => store.save({ answerStyle: "chatty", providers: new Map() } as unknown as StoredSettings));
    await assert.rejects(stat(tree.config), { code: "ENOENT" });
  });
});

void describe("settings: directory ownership", { skip: !POSIX }, () => {
  void it("creates and tightens only its containing directory; ancestors are untouched", async () => {
    const parent = join(tree.root, "config");
    await mkdir(tree.config, { recursive: true });
    await chmod(parent, 0o751);
    await chmod(tree.config, 0o755);
    const store = new SettingsStore(tree.settings);
    await store.load();
    await store.save(settingsWith(new Map()));
    assert.equal((await stat(tree.config)).mode & 0o777, 0o700);
    assert.equal((await stat(parent)).mode & 0o777, 0o751);
    assert.equal((await stat(tree.settings)).mode & 0o777, 0o600);
  });

  void it("refuses a symlinked settings directory", async () => {
    const elsewhere = join(tree.root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o755 });
    await mkdir(join(tree.root, "config"), { recursive: true });
    await symlink(elsewhere, tree.config);
    const store = new SettingsStore(tree.settings);
    await store.load();
    const outcome = await store.save(settingsWith(new Map()));
    assert.ok(!outcome.saved && outcome.reason === "io-error");
    assert.deepEqual(await names(elsewhere), []);
  });
});
