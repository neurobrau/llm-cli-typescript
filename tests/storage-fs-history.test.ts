import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { isAbortError } from "../src/domain/errors.js";
import { historyOwnedDirectories, tightenExisting } from "../src/storage/fs/directories.js";
import { HistoryStore, nodeFs, StorageIoError, StoragePathError } from "../src/storage/fs/index.js";
import { encodeActiveSelection, encodeConversation, matchesSelection } from "../src/storage/index.js";
import type { StoredConversation } from "../src/storage/index.js";
import { activeCases, conversationCases } from "./helpers/storage-cases.js";
import { ID_A, ID_B, ID_C, conversation, errno, gate, makeTree, names, put, tempFiles, text, withFs, without } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

const POSIX = process.platform !== "win32";
const FIXTURES = join(import.meta.dirname, "..", "..", "tests", "fixtures", "storage", "ts");
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

let tree: Tree;
let store: HistoryStore;

beforeEach(async () => {
  tree = await makeTree(); // a fresh tree per test
  store = new HistoryStore(tree.conversations);
});
afterEach(async () => {
  await tree.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  return assert.fail("expected a rejection");
}

const setTimes = (id: string, seconds: number): Promise<void> => utimes(store.pathFor(id), seconds, seconds);

void describe("history: saving", () => {
  void it("writes canonical bytes identical to the 005A encoders and fixtures", async () => {
    for (const { file, value } of conversationCases) {
      await store.save(value);
      assert.equal(await text(store.pathFor(value.id)), encodeConversation(value));
      assert.equal(await text(store.pathFor(value.id)), await readFile(join(FIXTURES, file), "utf8"));
      const loaded = await store.loadById(value.id);
      assert.equal(loaded.kind, "loaded");
    }
    for (const { file, value } of activeCases) {
      await store.saveActive(value);
      assert.equal(await text(store.activePath), encodeActiveSelection(value));
      assert.equal(await text(store.activePath), await readFile(join(FIXTURES, file), "utf8"));
    }
  });

  void it("keeps huge counts exact through the disk round trip", async () => {
    const usage = conversationCases.find((entry) => entry.file === "conversation_usage_edges.json");
    assert.ok(usage);
    await store.save(usage.value);
    const loaded = await store.loadById(usage.value.id);
    assert.ok(loaded.kind === "loaded");
    assert.deepEqual(loaded.conversation, usage.value);
    assert.ok(encodeConversation(loaded.conversation).includes("1180591620717411303429"));
  });

  void it("snapshots the value when save is invoked, even while an earlier write is still pending", async () => {
    const hold = gate();
    let first = true;
    store = new HistoryStore(tree.conversations, {
      fs: withFs({
        async createExclusive(path, mode2) {
          if (first) {
            first = false;
            await hold.enter();
          }
          return nodeFs.createExclusive(path, mode2);
        },
      }),
    });
    const messages = [{ role: "user" as const, content: "original" }];
    const when = new Date("2026-10-21T08:00:00.000Z");
    const value: StoredConversation = { ...conversation(), messages, updatedAt: when };
    const pending = store.save(value);
    messages[0] = { role: "user", content: "mutated" };
    messages.push({ role: "user", content: "extra" });
    when.setUTCFullYear(2000);
    await hold.reached;
    hold.release();
    await pending;
    const loaded = await store.loadById(ID_A);
    assert.ok(loaded.kind === "loaded");
    assert.deepEqual(loaded.conversation.messages, [{ role: "user", content: "original" }]);
    assert.equal(loaded.conversation.updatedAt.toISOString(), "2026-10-21T08:00:00.000Z");
  });

  void it("does not touch the store or generate anything: validation fails before any directory exists", async () => {
    const bad = { ...conversation(), id: "not-a-uuid" };
    assert.throws(() => store.save(bad), StoragePathError);
    const invalid = { ...conversation(), messages: [{ role: "tool", content: "x" }] } as unknown as StoredConversation;
    assert.throws(() => store.save(invalid));
    await assert.rejects(stat(tree.state), { code: "ENOENT" });
  });

  void it("saves operations of one store in invocation order, whatever the I/O timing", async () => {
    const hold = gate();
    let first = true;
    store = new HistoryStore(tree.conversations, {
      fs: withFs({
        async createExclusive(path, mode2) {
          if (first) {
            first = false;
            await hold.enter(); // the first save is slow
          }
          return nodeFs.createExclusive(path, mode2);
        },
      }),
    });
    const old = store.save(conversation(ID_A, "2026-10-21T08:00:00.000Z", { messages: [{ role: "user", content: "first" }] }));
    const latest = store.save(conversation(ID_A, "2026-10-21T09:00:00.000Z", { messages: [{ role: "user", content: "second" }] }));
    await hold.reached;
    hold.release();
    await Promise.all([old, latest]);
    const loaded = await store.loadById(ID_A);
    assert.ok(loaded.kind === "loaded");
    assert.equal(loaded.conversation.messages[0]?.content, "second");
  });

  void it("rejects a queued save promptly when its signal aborts, without running it", async () => {
    const hold = gate();
    let calls = 0;
    store = new HistoryStore(tree.conversations, {
      fs: withFs({
        async createExclusive(path, mode2) {
          calls += 1;
          await hold.enter();
          return nodeFs.createExclusive(path, mode2);
        },
      }),
    });
    const running = store.save(conversation(ID_A));
    const controller = new AbortController();
    const queued = store.save(conversation(ID_B), { signal: controller.signal });
    await hold.reached;
    controller.abort();
    assert.ok(isAbortError(await rejection(queued)));
    hold.release();
    await running;
    assert.equal(calls, 1);
    assert.deepEqual(await names(tree.conversations), [`${ID_A}.json`]);
  });

  void it("reports a failed save as a typed error with the reference wording", async () => {
    await put(tree.app, "a file where the application directory should be").catch(() => undefined);
    await mkdir(tree.state, { recursive: true });
    await writeFile(tree.app, "blocker");
    const error = await rejection(store.save(conversation()));
    assert.ok(error instanceof StorageIoError);
    assert.equal(error.operation, "save");
    assert.match(error.message, /^Could not save conversation history at .*11111111-1111-4111-8111-111111111111\.json: .+\.$/);
  });
});

void describe("history: directories and permissions", { skip: !POSIX }, () => {
  void it("creates owner-only application directories and files, leaving ancestors unchanged", async () => {
    await mkdir(tree.state, { recursive: true });
    await chmod(tree.state, 0o751);
    await chmod(tree.root, 0o755);
    await store.save(conversation());
    await store.saveActive({ provider: "openai", model: "m" });
    assert.equal(await mode(tree.app), 0o700);
    assert.equal(await mode(tree.conversations), 0o700);
    assert.equal(await mode(store.pathFor(ID_A)), 0o600);
    assert.equal(await mode(tree.active), 0o600);
    assert.equal(await mode(tree.state), 0o751);
    assert.equal(await mode(tree.root), 0o755);
  });

  void it("tightens existing lax application directories on save and on load, never creating anything", async () => {
    await mkdir(tree.conversations, { recursive: true });
    await chmod(tree.app, 0o755);
    await chmod(tree.conversations, 0o777);
    await mkdir(join(tree.root, "x"), { recursive: true });
    const latest = await store.loadLatest();
    assert.deepEqual(latest.warnings, []);
    assert.equal(await mode(tree.app), 0o700);
    assert.equal(await mode(tree.conversations), 0o700);
    // A missing directory is not created by loading.
    const lonely = new HistoryStore(join(tree.root, "other", "neurobrau", "conversations"));
    assert.deepEqual(await lonely.loadLatest(), { conversation: undefined, path: undefined, warnings: [] });
    assert.deepEqual(await lonely.listPaths(), []);
    assert.deepEqual(await lonely.loadActive(), { selection: undefined, warning: undefined });
    assert.equal(await lonely.countConversations(), 0);
    assert.deepEqual(await lonely.deleteAll(), { deleted: 0, error: undefined });
    await assert.rejects(stat(join(tree.root, "other")), { code: "ENOENT" });
  });

  void it("owns the parent of an injected directory only when it is named neurobrau", async () => {
    const custom = join(tree.root, "custom", "conversations");
    await mkdir(custom, { recursive: true });
    await chmod(join(tree.root, "custom"), 0o755);
    await chmod(custom, 0o755);
    const other = new HistoryStore(custom);
    await other.save(conversation());
    assert.equal(await mode(custom), 0o700);
    assert.equal(await mode(join(tree.root, "custom")), 0o755);
    await other.saveActive({ provider: "openai", model: "m" });
    assert.equal(await mode(join(tree.root, "custom")), 0o755, "an active-only save does not claim a parent it does not own");
    assert.ok((await names(join(tree.root, "custom"))).includes("active.json"));
  });

  void it("an active-only save creates just the state application directory", async () => {
    await store.saveActive({ provider: "ollama", model: "q" });
    assert.deepEqual(await names(tree.app), ["active.json"]);
  });

  void it("surfaces a failure to tighten as a warning and still reads", async () => {
    await store.save(conversation());
    await chmod(tree.app, 0o755);
    const failing = new HistoryStore(tree.conversations, { fs: withFs({ chmod: () => Promise.reject(errno("EPERM")) }) });
    const latest = await failing.loadLatest();
    assert.equal(latest.conversation?.id, ID_A);
    assert.deepEqual(latest.warnings, [
      `Could not tighten permissions on ${tree.app}: Operation not permitted.`,
      `Could not tighten permissions on ${tree.conversations}: Operation not permitted.`,
    ]);
    assert.equal(await mode(tree.app), 0o755);
  });

  void it("tightening stops at a symlinked owned ancestor and never touches the directories behind it", async () => {
    const external = join(tree.root, "external");
    await mkdir(join(external, "conversations"), { recursive: true });
    await chmod(external, 0o755);
    await chmod(join(external, "conversations"), 0o755);
    await writeFile(join(external, "conversations", "keep.json"), "{}");
    await mkdir(tree.state, { recursive: true });
    await symlink(external, tree.app);
    const warnings = await tightenExisting(nodeFs, historyOwnedDirectories(tree.conversations));
    assert.deepEqual(warnings, [`Could not tighten permissions on ${tree.app}: Is a symbolic link.`]);
    assert.equal(await mode(external), 0o755);
    assert.equal(await mode(join(external, "conversations")), 0o755);
    assert.deepEqual(await names(external), ["conversations"]);
    assert.deepEqual(await names(join(external, "conversations")), ["keep.json"]);
    assert.equal(await text(join(external, "conversations", "keep.json")), "{}");
  });

  void it("tightening stops at a non-directory owned ancestor", async () => {
    await mkdir(tree.state, { recursive: true });
    await writeFile(tree.app, "not a directory");
    const warnings = await tightenExisting(nodeFs, historyOwnedDirectories(tree.conversations));
    assert.deepEqual(warnings, [`Could not tighten permissions on ${tree.app}: Not a directory.`]);
    assert.equal(await text(tree.app), "not a directory");
  });

  void it("a chmod failure on an owned ancestor does not stop its descendants", async () => {
    await mkdir(tree.conversations, { recursive: true });
    await chmod(tree.app, 0o755);
    await chmod(tree.conversations, 0o755);
    const chmods: string[] = [];
    const fs = withFs({
      chmod: (path, fileMode) => {
        chmods.push(path);
        return path === tree.app ? Promise.reject(errno("EPERM")) : nodeFs.chmod(path, fileMode);
      },
    });
    const warnings = await tightenExisting(fs, historyOwnedDirectories(tree.conversations));
    assert.deepEqual(warnings, [`Could not tighten permissions on ${tree.app}: Operation not permitted.`]);
    assert.deepEqual(chmods, [tree.app, tree.conversations]);
    assert.equal(await mode(tree.conversations), 0o700);
  });

  void it("fails an explicit save when permission preparation fails, writing nothing", async () => {
    await mkdir(tree.conversations, { recursive: true });
    const failing = new HistoryStore(tree.conversations, { fs: withFs({ chmod: () => Promise.reject(errno("EPERM")) }) });
    const error = await rejection(failing.save(conversation()));
    assert.ok(error instanceof StorageIoError && error.code === "EPERM");
    assert.deepEqual(await names(tree.conversations), []);
  });

  void it("refuses symlinks and files at application-owned locations, never chmod-ing a target", async () => {
    const target = join(tree.root, "elsewhere");
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await mkdir(tree.state, { recursive: true });
    await symlink(target, tree.app);
    const error = await rejection(store.save(conversation()));
    assert.ok(error instanceof StorageIoError);
    assert.equal(error.reason, "Is a symbolic link");
    assert.equal(await mode(target), 0o755);
    assert.deepEqual(await names(target), []);
    // Tightening warns and leaves the target alone, too.
    const latest = await store.loadLatest();
    assert.match(latest.warnings.join("\n"), /Could not tighten permissions on .*: Is a symbolic link\./);
    assert.equal(await mode(target), 0o755);
    // Same for a symlinked conversations directory.
    const second = await makeTree();
    try {
      await mkdir(second.app, { recursive: true });
      await symlink(target, second.conversations);
      const other = new HistoryStore(second.conversations);
      assert.ok((await rejection(other.save(conversation()))) instanceof StorageIoError);
      assert.deepEqual(await names(target), []);
    } finally {
      await second.cleanup();
    }
  });
});

void describe("history: latest selection", () => {
  void it("prefers the greatest updatedAt, then the greatest bigint mtime, then the first path", async () => {
    await store.save(conversation(ID_A, "2026-10-21T08:00:00.000Z"));
    await store.save(conversation(ID_B, "2026-10-21T10:00:00.000Z"));
    await store.save(conversation(ID_C, "2026-10-21T09:00:00.000Z"));
    assert.equal((await store.loadLatest()).conversation?.id, ID_B);
  });

  void it("breaks updatedAt ties by filesystem modification time", async () => {
    for (const id of [ID_A, ID_B, ID_C]) await store.save(conversation(id, "2026-10-21T08:00:00.000Z"));
    const base = 1_700_000_000;
    await setTimes(ID_A, base + 1);
    await setTimes(ID_B, base + 3);
    await setTimes(ID_C, base + 2);
    assert.equal((await store.loadLatest()).conversation?.id, ID_B);
    await setTimes(ID_A, base + 9);
    assert.equal((await store.loadLatest()).conversation?.id, ID_A);
  });

  void it("compares mtimes as bigints: a difference below double precision still decides", async () => {
    for (const id of [ID_A, ID_B]) await store.save(conversation(id, "2026-10-21T08:00:00.000Z"));
    const fake = (ns: Record<string, bigint>) =>
      new HistoryStore(tree.conversations, {
        fs: withFs({
          async lstat(path) {
            const info = await nodeFs.lstat(path);
            const id = Object.keys(ns).find((key) => path.includes(key));
            return id === undefined ? info : { ...info, mtimeNs: ns[id] ?? info.mtimeNs };
          },
        }),
      });
    const huge = 2n ** 62n;
    assert.equal(Number(huge) === Number(huge + 1n), true, "precondition: these are the same double");
    assert.equal((await fake({ [ID_A]: huge, [ID_B]: huge + 1n }).loadLatest()).conversation?.id, ID_B);
    assert.equal((await fake({ [ID_A]: huge + 1n, [ID_B]: huge }).loadLatest()).conversation?.id, ID_A);
  });

  void it("keeps the first candidate in path order on an exact tie", async () => {
    for (const id of [ID_C, ID_A, ID_B]) await store.save(conversation(id, "2026-10-21T08:00:00.000Z"));
    const frozen = new HistoryStore(tree.conversations, {
      fs: withFs({ lstat: async (path) => ({ ...(await nodeFs.lstat(path)), mtimeNs: 5n }) }),
    });
    const latest = await frozen.loadLatest();
    assert.equal(latest.conversation?.id, ID_A);
    assert.equal(latest.path, store.pathFor(ID_A));
  });

  void it("applies the predicate, defaults to accepting all, and does not swallow its exceptions", async () => {
    await store.save(conversation(ID_A, "2026-10-21T08:00:00.000Z", { provider: "ollama", model: "q" }));
    await store.save(conversation(ID_B, "2026-10-21T09:00:00.000Z", { provider: "openai", model: "m" }));
    assert.equal((await store.loadLatest()).conversation?.id, ID_B);
    assert.equal((await store.loadLatest((c) => c.provider === "ollama")).conversation?.id, ID_A);
    assert.equal((await store.loadLatest(() => false)).conversation, undefined);
    await assert.rejects(
      store.loadLatest(() => {
        throw new RangeError("caller bug");
      }),
      RangeError,
    );
  });

  void it("reports invalid, unreadable and stat-failing files in path order and keeps them byte-identical", async () => {
    await store.save(conversation(ID_B, "2026-10-21T08:00:00.000Z"));
    const dir = tree.conversations;
    const bad: Record<string, string | Uint8Array> = {
      "a-notjson.json": "hello",
      "b-schema.json": '{"schema_version": 2}',
      "c-utf8.json": new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]),
      "d-empty.json": "",
    };
    for (const [name, content] of Object.entries(bad)) await put(join(dir, name), content);
    await put(join(dir, "e-stat.json"), "{}");
    await put(join(dir, "f-read.json"), "{}");
    const kept = await Promise.all(Object.keys(bad).map((name) => readFile(join(dir, name))));
    const faulty = new HistoryStore(dir, {
      fs: withFs({
        lstat: (path) => (path.endsWith("e-stat.json") ? Promise.reject(errno("EIO")) : nodeFs.lstat(path)),
        readFile: (path) => (path.endsWith("f-read.json") ? Promise.reject(errno("EACCES")) : nodeFs.readFile(path)),
      }),
    });
    const latest = await faulty.loadLatest();
    assert.equal(latest.conversation?.id, ID_B);
    assert.deepEqual(latest.warnings, [
      `Ignoring unreadable conversation file ${dir}/a-notjson.json: the text is not valid JSON. The file was left unchanged.`,
      `Ignoring unreadable conversation file ${dir}/b-schema.json: unsupported schema_version (expected 1). The file was left unchanged.`,
      `Ignoring unreadable conversation file ${dir}/c-utf8.json: the input is not valid UTF-8. The file was left unchanged.`,
      `Ignoring unreadable conversation file ${dir}/d-empty.json: the text is not valid JSON. The file was left unchanged.`,
      `Could not read conversation history at ${dir}/e-stat.json: Input/output error.`,
      `Could not read conversation history at ${dir}/f-read.json: Permission denied.`,
    ]);
    const after2 = await Promise.all(Object.keys(bad).map((name) => readFile(join(dir, name))));
    assert.deepEqual(after2, kept);
    assert.ok(!latest.warnings.join("").includes("hello"), "document bodies never appear in warnings");
  });

  void it("returns no result and one warning when the directory cannot be enumerated", async () => {
    await mkdir(tree.state, { recursive: true });
    await writeFile(tree.app, "x"); // a file where the application directory should be
    const latest = await store.loadLatest();
    assert.equal(latest.conversation, undefined);
    assert.ok(latest.warnings.some((w) => w.startsWith(`Could not read conversation history at ${tree.conversations}: `)));
    await rm(tree.app);
    const injected = new HistoryStore(tree.conversations, { fs: withFs({ readdir: () => Promise.reject(errno("EACCES")) }) });
    const result = await injected.loadLatest();
    assert.deepEqual(result.warnings, [`Could not read conversation history at ${tree.conversations}: Permission denied.`]);
    const error = await rejection(injected.listPaths());
    assert.ok(error instanceof StorageIoError && error.operation === "read");
  });

  void it("loads a valid file whose name differs from its internal id, as the references do", async () => {
    await put(join(tree.conversations, "renamed.json"), encodeConversation(conversation(ID_C)));
    const latest = await store.loadLatest();
    assert.equal(latest.conversation?.id, ID_C);
    assert.equal(latest.path, join(tree.conversations, "renamed.json"));
  });

  void it("never rewrites conversation bytes when loading", async () => {
    await put(join(tree.conversations, `${ID_A}.json`), JSON.stringify({ schema_version: 1, id: ID_A, created_at: "2026-10-21T10:00:00+02:00", updated_at: "2026-10-21T10:00:00+02:00", messages: [], extra: 1 }));
    const before = await readFile(store.pathFor(ID_A));
    const latest = await store.loadLatest();
    assert.equal(latest.conversation?.id, ID_A);
    assert.deepEqual(await readFile(store.pathFor(ID_A)), before);
  });
});

void describe("history: provider/model matching", () => {
  const stored = (extra: Partial<StoredConversation>): StoredConversation => ({ ...conversation(), ...extra });
  const legacy = without(conversation(), "provider", "model");

  void it("treats unspecified requests as wildcards", () => {
    assert.ok(matchesSelection(stored({ provider: "ollama", model: "q" }), {}));
    assert.ok(matchesSelection(stored({ provider: "ollama", model: "q" }), { provider: "ollama" }));
    assert.ok(!matchesSelection(stored({ provider: "ollama", model: "q" }), { provider: "openai" }));
    assert.ok(matchesSelection(stored({ provider: "ollama", model: "q" }), { model: "q" }));
    assert.ok(!matchesSelection(stored({ provider: "ollama", model: "q" }), { model: "other" }));
  });

  void it("counts an absent stored provider as openai and an absent model as any model of the provider", () => {
    assert.ok(matchesSelection(legacy, { provider: "openai", model: "anything" }));
    assert.ok(!matchesSelection(legacy, { provider: "ollama" }));
    const modelless = without(conversation(ID_A, "2026-10-21T08:00:00.000Z", { provider: "ollama" }), "model");
    assert.ok(matchesSelection(modelless, { provider: "ollama", model: "any" }));
    assert.ok(!matchesSelection(modelless, { provider: "openai", model: "any" }));
    assert.equal(legacy.provider, undefined);
  });

  void it("keeps unknown stored providers as exact strings and never rewrites metadata", async () => {
    const future = stored({ provider: "anthropic", model: "claude" });
    assert.ok(matchesSelection(future, { provider: "anthropic" }));
    assert.ok(!matchesSelection(future, { provider: "openai" }));
    assert.ok(matchesSelection(future, {}));
    await store.save(future);
    const bytes = await readFile(store.pathFor(ID_A));
    const latest = await store.loadLatest((c) => matchesSelection(c, { provider: "openai" }));
    assert.equal(latest.conversation, undefined);
    assert.deepEqual(await readFile(store.pathFor(ID_A)), bytes);
  });
});

void describe("history: which entries count", () => {
  void it("lists only direct regular case-sensitive .json files, in code-point order", async () => {
    const dir = tree.conversations;
    await put(join(dir, "b.json"), "{}");
    await put(join(dir, "a.json"), "{}");
    await put(join(dir, "\u{1F600}.json"), "{}"); // astral: after U+FF5E in code-point order, before it in UTF-16
    await put(join(dir, "～.json"), "{}");
    await put(join(dir, "upper.JSON"), "{}");
    await put(join(dir, "notes.txt"), "x");
    await put(join(dir, "c.json.bak"), "x");
    await put(join(dir, `.${ID_A}.0123456789abcdef.tmp`), "temp");
    await mkdir(join(dir, "folder.json"));
    await put(join(dir, "folder.json", "inner.json"), "{}");
    assert.deepEqual(
      (await store.listPaths()).map((path) => path.slice(dir.length + 1)),
      ["a.json", "b.json", "～.json", "\u{1F600}.json"],
    );
  });

  void it("ignores symlinks (to files, directories and dangling) and FIFOs without following or blocking", { skip: !POSIX }, async (t) => {
    const dir = tree.conversations;
    await put(join(dir, "real.json"), encodeConversation(conversation(ID_A)));
    const outside = join(tree.root, "outside.json");
    await writeFile(outside, encodeConversation(conversation(ID_B, "2030-01-01T00:00:00.000Z")));
    await symlink(outside, join(dir, "link.json"));
    await symlink(tree.root, join(dir, "dirlink.json"));
    await symlink(join(tree.root, "missing"), join(dir, "dangling.json"));
    try {
      execFileSync("mkfifo", [join(dir, "pipe.json")]);
    } catch {
      t.diagnostic("mkfifo unavailable: FIFO case skipped");
    }
    assert.deepEqual(
      (await store.listPaths()).map((path) => path.slice(dir.length + 1)),
      ["real.json"],
    );
    const latest = await store.loadLatest();
    assert.equal(latest.conversation?.id, ID_A, "the symlink to a newer conversation is not followed");
    assert.deepEqual(latest.warnings, []);
    assert.equal(await store.countConversations(), 1);
  });

  void it("refuses to load a symlink or an outside path directly", { skip: !POSIX }, async () => {
    const dir = tree.conversations;
    await mkdir(dir, { recursive: true });
    const outside = join(tree.root, "outside.json");
    await writeFile(outside, encodeConversation(conversation(ID_B)));
    await symlink(outside, join(dir, "link.json"));
    const viaLink = await store.loadFile(join(dir, "link.json"));
    assert.ok(viaLink.kind === "unusable" && viaLink.warning.includes("Is a symbolic link"));
    await assert.rejects(store.loadFile(outside), StoragePathError);
    await assert.rejects(store.loadFile(join(dir, "sub", "x.json")), StoragePathError);
    await assert.rejects(store.loadFile(join(dir, "x.txt")), StoragePathError);
    assert.deepEqual(await store.loadFile(join(dir, "absent.json")), { kind: "missing", path: join(dir, "absent.json") });
  });

  void it("escapes control characters in file names so warnings stay on one line", async () => {
    const dir = tree.conversations;
    await put(join(dir, "evil\u001b[31m\nname.json"), "nope");
    const latest = await store.loadLatest();
    const [warning] = latest.warnings;
    assert.ok(warning);
    assert.ok(Array.from(warning, (char) => char.charCodeAt(0)).every((code) => code > 0x1f && code !== 0x7f));
    assert.ok(warning.includes("evil\\x1b[31m\\x0aname.json"));
  });
});

void describe("history: delete all", () => {
  async function populate(): Promise<void> {
    await store.save(conversation(ID_A));
    await store.save(conversation(ID_B));
    await put(join(tree.conversations, "corrupt.json"), "{");
    await put(join(tree.conversations, "not-a-uuid.json"), "{}");
    await put(join(tree.conversations, "notes.txt"), "keep");
    await put(join(tree.conversations, "backup.json.bak"), "keep");
    await put(join(tree.conversations, "UPPER.JSON"), "keep");
    await mkdir(join(tree.conversations, "sub.json"));
    await put(join(tree.conversations, "sub.json", "inner.json"), "keep");
    await store.saveActive({ provider: "ollama", model: "q" });
    await put(tree.settings, "{}");
  }

  void it("counts and deletes every regular .json file, including corrupt and non-UUID names, and nothing else", async () => {
    await populate();
    assert.equal(await store.countConversations(), 4);
    assert.deepEqual(await store.deleteAll(), { deleted: 4, error: undefined });
    assert.deepEqual(await names(tree.conversations), ["UPPER.JSON", "backup.json.bak", "notes.txt", "sub.json"]);
    assert.deepEqual(await names(join(tree.conversations, "sub.json")), ["inner.json"]);
    assert.ok((await stat(tree.active)).isFile());
    assert.ok((await stat(tree.settings)).isFile());
    assert.deepEqual(await store.deleteAll(), { deleted: 0, error: undefined });
  });

  void it("never removes symlinks' targets or the links themselves", { skip: !POSIX }, async () => {
    await store.save(conversation(ID_A));
    const outside = join(tree.root, "outside.json");
    await writeFile(outside, "keep");
    await symlink(outside, join(tree.conversations, "link.json"));
    assert.equal((await store.deleteAll()).deleted, 1);
    assert.equal(await text(outside), "keep");
    assert.deepEqual(await names(tree.conversations), ["link.json"]);
  });

  void it("skips a file that disappears during deletion", async () => {
    await populate();
    const racing = new HistoryStore(tree.conversations, {
      fs: withFs({
        async unlink(path) {
          if (path.endsWith("corrupt.json")) {
            await nodeFs.unlink(path); // someone else removed it first
            throw errno("ENOENT");
          }
          return nodeFs.unlink(path);
        },
      }),
    });
    assert.deepEqual(await racing.deleteAll(), { deleted: 3, error: undefined });
  });

  void it("reports the deleted count together with a typed error on a partial failure", async () => {
    await populate();
    const failing = new HistoryStore(tree.conversations, {
      fs: withFs({ unlink: (path) => (path.endsWith(`${ID_A}.json`) ? Promise.reject(errno("EACCES")) : nodeFs.unlink(path)) }),
    });
    // Path order: 1111… (ID_A) < 2222… < corrupt < not-a-uuid -> ID_A fails first.
    const first = await failing.deleteAll();
    assert.equal(first.deleted, 0);
    assert.ok(first.error instanceof StorageIoError);
    assert.equal(first.error.operation, "delete");
    assert.equal(first.error.deleted, 0);
    assert.equal(first.error.message, `Could not delete conversation history at ${failing.pathFor(ID_A)}: Permission denied.`);
    const failLater = new HistoryStore(tree.conversations, {
      fs: withFs({ unlink: (path) => (path.endsWith("not-a-uuid.json") ? Promise.reject(errno("EBUSY")) : nodeFs.unlink(path)) }),
    });
    const later = await failLater.deleteAll();
    assert.equal(later.deleted, 3);
    assert.equal(later.error?.deleted, 3);
    assert.deepEqual(await names(tree.conversations), ["UPPER.JSON", "backup.json.bak", "not-a-uuid.json", "notes.txt", "sub.json"]);
  });

  void it("returns a typed error and a zero count when the directory cannot be read", async () => {
    const broken = new HistoryStore(tree.conversations, { fs: withFs({ readdir: () => Promise.reject(errno("EACCES")) }) });
    const result = await broken.deleteAll();
    assert.equal(result.deleted, 0);
    assert.ok(result.error instanceof StorageIoError);
    await assert.rejects(broken.countConversations(), StorageIoError);
  });
});

void describe("history: active selection", () => {
  void it("round-trips and is independent of the conversations", async () => {
    assert.deepEqual(await store.loadActive(), { selection: undefined, warning: undefined });
    await store.save(conversation(ID_A));
    const before = await readFile(store.pathFor(ID_A));
    const receipt = await store.saveActive({ provider: "ollama", model: "hf.co/org/m:Q4" });
    assert.equal(receipt.path, tree.active);
    assert.deepEqual((await store.loadActive()).selection, { provider: "ollama", model: "hf.co/org/m:Q4" });
    assert.deepEqual(await readFile(store.pathFor(ID_A)), before);
    assert.equal(await text(tree.active), '{"schema_version": 1, "provider": "ollama", "model": "hf.co/org/m:Q4"}\n');
    assert.ok(!(await names(tree.conversations)).includes("active.json"));
  });

  void it("returns a warning and preserves the file for invalid, unsupported, non-UTF-8 and unreadable entries", async () => {
    const cases: readonly [string | Uint8Array, RegExp][] = [
      ['{"schema_version": 1, "provider": "anthropic", "model": "x"}', /^Ignoring invalid /],
      ['{"schema_version": 2, "provider": "openai", "model": "x"}', /^Ignoring invalid /],
      ['{"schema_version": 1, "provider": "openai", "model": ""}', /^Ignoring invalid /],
      ['["openai"]', /^Ignoring invalid /],
      ["{oops", /^Ignoring unreadable .*: the text is not valid JSON\.$/],
      [new Uint8Array([0xff, 0xfe]), /^Ignoring unreadable .*: the input is not valid UTF-8\.$/],
    ];
    for (const [content, pattern] of cases) {
      await put(tree.active, content);
      const before = await readFile(tree.active);
      const result = await store.loadActive();
      assert.equal(result.selection, undefined);
      assert.match(result.warning ?? "", pattern);
      assert.ok((result.warning ?? "").includes(tree.active));
      assert.deepEqual(await readFile(tree.active), before);
    }
  });

  void it("refuses non-regular entries and read errors with a warning", { skip: !POSIX }, async () => {
    await mkdir(tree.app, { recursive: true });
    const real = join(tree.root, "real-active.json");
    await writeFile(real, '{"schema_version": 1, "provider": "openai", "model": "m"}\n');
    await symlink(real, tree.active);
    assert.equal((await store.loadActive()).warning, `Ignoring unreadable ${tree.active}: Is a symbolic link.`);
    const unreadable = new HistoryStore(tree.conversations, { fs: withFs({ lstat: () => Promise.reject(errno("EACCES")) }) });
    assert.equal((await unreadable.loadActive()).warning, `Ignoring unreadable ${tree.active}: Permission denied.`);
    // An atomic save refuses to replace the symlink.
    assert.ok((await rejection(store.saveActive({ provider: "openai", model: "x" }))) instanceof StorageIoError);
    assert.equal(await text(real), '{"schema_version": 1, "provider": "openai", "model": "m"}\n');
  });

  void it("rejects an unsupported selection before any filesystem work", () => {
    assert.throws(() => store.saveActive({ provider: "anthropic", model: "x" } as never));
    assert.throws(() => store.saveActive({ provider: "openai", model: "" }));
  });

  void it("is not changed by saving a conversation", async () => {
    await store.saveActive({ provider: "openai", model: "m" });
    const before = await readFile(tree.active);
    await store.save(conversation(ID_A, "2026-10-21T08:00:00.000Z", { provider: "ollama", model: "q" }));
    assert.deepEqual(await readFile(tree.active), before);
  });
});

void describe("history: write failures keep earlier data", () => {
  void it("keeps the previous conversation when the rename fails and leaves no temp file", async () => {
    await store.save(conversation(ID_A, "2026-10-21T08:00:00.000Z"));
    const before = await readFile(store.pathFor(ID_A));
    const failing = new HistoryStore(tree.conversations, { fs: withFs({ rename: () => Promise.reject(errno("ENOSPC")) }) });
    const error = await rejection(failing.save(conversation(ID_A, "2026-10-21T09:00:00.000Z")));
    assert.ok(error instanceof StorageIoError);
    assert.equal(error.message, `Could not save conversation history at ${failing.pathFor(ID_A)}: No space left on device.`);
    assert.deepEqual(await readFile(store.pathFor(ID_A)), before);
    assert.deepEqual(await tempFiles(tree.conversations), []);
  });

  void it("last successful rename wins across independent instances; conversation and active are separate commits", async () => {
    const one = new HistoryStore(tree.conversations);
    const two = new HistoryStore(tree.conversations);
    await one.save(conversation(ID_A, "2026-10-21T08:00:00.000Z", { messages: [{ role: "user", content: "one" }] }));
    await two.save(conversation(ID_A, "2026-10-21T09:00:00.000Z", { messages: [{ role: "user", content: "two" }] }));
    assert.equal((await one.loadLatest()).conversation?.messages[0]?.content, "two");
    // A failing active-selection commit does not undo the conversation commit.
    const flaky = new HistoryStore(tree.conversations, { fs: withFs({ rename: (from, to) => (to.endsWith("active.json") ? Promise.reject(errno("EIO")) : nodeFs.rename(from, to)) }) });
    await flaky.save(conversation(ID_B));
    await assert.rejects(flaky.saveActive({ provider: "openai", model: "m" }), StorageIoError);
    assert.equal((await flaky.loadById(ID_B)).kind, "loaded");
    assert.equal((await flaky.loadActive()).selection, undefined);
  });
});
