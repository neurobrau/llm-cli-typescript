import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { decodeConversation, encodeConversation } from "../src/storage/index.js";
import { ManualInput, MemoryHistory, ScriptedProvider, answer, completed, fakeInterrupts, ioError, outcome, runChat } from "./helpers/chat.js";
import type { ChatRun } from "./helpers/chat.js";
import { ID_A, ID_B, conversation, makeTree, put } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

let tree: Tree;
beforeEach(async () => {
  tree = await makeTree();
});
afterEach(async () => {
  await tree.cleanup();
});

const run = (provider: ScriptedProvider, lines: readonly string[], argv: readonly string[] = ["--provider", "ollama", "--model", "m"], end = true): Promise<ChatRun> =>
  runChat(argv, provider, new ManualInput(lines, end), { tree });
const files = async (): Promise<string[]> => (await readdir(tree.conversations)).sort();
const load = async (name: string) => decodeConversation(await readFile(join(tree.conversations, name)));
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

void describe("chat history: saving", () => {
  void it("saves each completed exchange with canonical bytes, owner-only modes and the selection, then active.json", async () => {
    const provider = new ScriptedProvider("ollama", [outcome(completed("one", { inputTokens: 3n, outputTokens: 2n }, "default")), answer("two")]);
    const result = await run(provider, ["a", "b"]);
    assert.equal(result.code, 0);
    assert.equal(result.err, "");
    const [name] = await files();
    assert.ok(name);
    const saved = await load(name);
    assert.deepEqual(saved.messages.map((m) => `${m.role}:${m.content}`), ["user:a", "assistant:one", "user:b", "assistant:two"]);
    assert.equal(saved.provider, "ollama");
    assert.equal(saved.model, "m");
    assert.equal(saved.requests.length, 1);
    assert.equal(saved.requests[0]?.serviceTier, "default");
    assert.equal(saved.requests[0].at.toISOString(), "2026-10-23T10:00:01.000Z");
    assert.equal(saved.requests[0].usage.inputTokens, 3n);
    assert.equal(encodeConversation(saved), await readFile(join(tree.conversations, name), "utf8"));
    assert.equal(await readFile(tree.active, "utf8"), '{"schema_version": 1, "provider": "ollama", "model": "m"}\n');
    assert.equal(await mode(tree.app), 0o700);
    assert.equal(await mode(tree.conversations), 0o700);
    assert.equal(await mode(join(tree.conversations, name)), 0o600);
    assert.equal(await mode(tree.active), 0o600);
  });

  void it("continues a saved conversation across runs with the full context", async () => {
    await run(new ScriptedProvider("ollama", [answer("A")]), ["first"]);
    const second = new ScriptedProvider("ollama", [answer("B")]);
    const result = await run(second, ["second"]);
    assert.match(result.out, /Restored conversation from .* \(2 messages\)/);
    assert.deepEqual(second.sent(0), ["user: first", "assistant: A", "user: second"]);
    assert.equal((await files()).length, 1);
  });

  void it("a storage failure is a warning and the chat continues (blocked conversations directory)", async () => {
    await mkdir(tree.state, { recursive: true });
    await writeFile(tree.app, "a file where the application directory should be");
    const provider = new ScriptedProvider("ollama", [answer("1"), answer("2")]);
    const result = await run(provider, ["a", "b"]);
    assert.equal(result.code, 0);
    assert.match(result.err, /warning: .*Not a directory/);
    assert.deepEqual(provider.sent(1), ["user: a", "assistant: 1", "user: b"]);
    assert.equal(result.out.split("AI > ").length - 1, 2);
  });
});

void describe("chat history: /reset", () => {
  void it("archives the old file, saves a fresh empty conversation and restores it next time", async () => {
    const provider = new ScriptedProvider("ollama", [answer("old reply"), answer("new reply")]);
    const result = await run(provider, ["old topic", "/reset", "new topic"]);
    assert.match(result.out, /Started a new conversation\. The previous one stays saved\.\n/);
    assert.deepEqual(provider.sent(1), ["user: new topic"]);
    const names = await files();
    assert.equal(names.length, 2);
    const loaded = await Promise.all(names.map(load));
    const byMessages = loaded.map((c) => c.messages.map((m) => m.content).join("|")).sort();
    assert.deepEqual(byMessages, ["new topic|new reply", "old topic|old reply"]);
    const old = loaded.find((c) => c.messages[0]?.content === "old topic");
    assert.equal(old?.requests.length, 0);
  });

  void it("reset alone saves the empty replacement, which the next run restores without a notice", async () => {
    await run(new ScriptedProvider("ollama", [answer("x")]), ["topic", "/reset", "/exit"]);
    const next = new ScriptedProvider("ollama");
    const result = await run(next, ["/exit"], []);
    assert.doesNotMatch(result.out, /Restored/);
    const empties = (await Promise.all((await files()).map(load))).filter((c) => c.messages.length === 0);
    assert.equal(empties.length, 1);
  });

  void it("an empty conversation is reused: no new ID and no file", async () => {
    await run(new ScriptedProvider("ollama"), ["/reset", "/reset", "/exit"]);
    assert.equal(await readdir(tree.state).then(() => true, () => false), false);
  });

  void it("reset drops old usage; /usage afterwards starts from zero", async () => {
    const provider = new ScriptedProvider("ollama", [outcome(completed("a", { inputTokens: 1n }))]);
    const result = await run(provider, ["q", "/usage", "/reset", "/usage"]);
    const reports = result.out.split("Conversation usage").length - 1;
    assert.equal(reports, 1);
    assert.match(result.out, /no API requests in this conversation yet/);
  });

  void it("a failed save after reset warns, and the new in-memory conversation keeps working", async () => {
    const history = new MemoryHistory();
    history.latest = conversation(ID_A, undefined, { provider: "ollama", model: "m" });
    history.saveError = ioError();
    const provider = new ScriptedProvider("ollama", [answer("fresh")]);
    const result = await runChat(["--provider", "ollama", "--model", "m"], provider, new ManualInput(["/reset", "q"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.equal(result.code, 0);
    assert.match(result.err, /warning: Could not save conversation history at .*Permission denied\./);
    assert.deepEqual(provider.sent(0), ["user: q"]); // nothing of the restored conversation leaks in
    assert.match(result.out, /Started a new conversation\./);
  });
});

void describe("chat history: /cleanup", () => {
  async function seedFiles(): Promise<void> {
    await put(join(tree.conversations, `${ID_A}.json`), encodeConversation(conversation(ID_A)));
    await put(join(tree.conversations, `${ID_B}.json`), encodeConversation(conversation(ID_B, "2026-10-22T08:00:00.000Z")));
    await put(join(tree.conversations, "corrupt.json"), "{");
    await put(join(tree.conversations, "notes.txt"), "keep me");
    await mkdir(join(tree.conversations, "dir.json"));
    await put(tree.active, '{"schema_version": 1, "provider": "ollama", "model": "m"}');
    await put(tree.settings, '{"schema_version": 1}');
  }

  void it("asks for the exact prompt, deletes only conversation files after `yes`, keeps everything else and starts a fresh conversation", async () => {
    await seedFiles();
    const provider = new ScriptedProvider("ollama", [answer("after")]);
    const result = await run(provider, ["/cleanup", "  YES  ", "hello"]);
    assert.ok(result.out.includes(`Delete 3 saved conversation(s) in ${tree.conversations}? This cannot be undone. Type 'yes' to confirm: `));
    assert.match(result.out, /Deleted 3 saved conversation\(s\)\. Started a new conversation\.\n/);
    assert.deepEqual(provider.sent(0), ["user: hello"]); // "YES" never reached the model; context was cleared
    const rest = await files();
    assert.ok(rest.includes("notes.txt") && rest.includes("dir.json"));
    assert.ok(!rest.includes("corrupt.json") && !rest.includes(`${ID_A}.json`));
    assert.equal(await readFile(tree.settings, "utf8"), '{"schema_version": 1}');
    assert.match(await readFile(tree.active, "utf8"), /ollama/);
  });

  void it("anything but yes cancels, and the line is neither executed nor sent", async () => {
    for (const answerLine of ["/exit", "/reset", "", "no", "y", "yes please"]) {
      await seedFiles();
      const provider = new ScriptedProvider("ollama", [answer("x")]);
      const result = await run(provider, ["/cleanup", answerLine, "ping"]);
      assert.match(result.out, /Cleanup cancelled\. Nothing was deleted\.\n/, answerLine);
      assert.equal(provider.calls, 1, answerLine); // only "ping": the confirmation line was consumed
      assert.deepEqual(provider.sent(0), ["user: ping"], answerLine);
      assert.equal(result.code, 0);
      assert.ok((await files()).includes("corrupt.json"), answerLine);
      await tree.cleanup();
      tree = await makeTree();
    }
  });

  void it("EOF during confirmation cancels and exits 0 without deleting", async () => {
    await seedFiles();
    const result = await run(new ScriptedProvider("ollama"), ["/cleanup"]);
    assert.equal(result.code, 0);
    assert.match(result.out, /Cleanup cancelled\. Nothing was deleted\.\n/);
    assert.ok(result.out.endsWith("\nGoodbye.\n"));
    assert.equal((await files()).length, 5);
  });

  void it("Ctrl+C during confirmation cancels cleanup and exits 130 without deleting", async () => {
    await seedFiles();
    const interrupts = fakeInterrupts();
    const input = new ManualInput(["/cleanup"]);
    let asked: () => void = () => undefined;
    const prompt = new Promise<void>((resolve) => { asked = resolve; });
    const pending = runChat(["--provider", "ollama", "--model", "m"], new ScriptedProvider("ollama"), input, {
      tree,
      deps: { interrupt: interrupts.source },
      onWrite: (_stream, text) => { if (text.startsWith("Delete 3")) asked(); },
    });
    await prompt;
    interrupts.fire();
    const result = await pending;
    assert.equal(result.code, 130);
    assert.match(result.out, /Cleanup cancelled\. Nothing was deleted\.\n/);
    assert.equal((await files()).length, 5);
    assert.equal(interrupts.active(), 0);
  });

  void it("with no conversation files it says so and keeps the unsaved in-memory context", async () => {
    const provider = new ScriptedProvider("ollama", [answer("1"), answer("2")]);
    const history = new MemoryHistory();
    const result = await runChat(["--provider", "ollama", "--model", "m"], provider, new ManualInput(["a", "/cleanup", "b"], true), { tree, deps: { createHistoryStore: () => history } });
    history.files = 0;
    assert.match(result.out, /No saved conversations\.\n/);
    assert.deepEqual(provider.sent(1), ["user: a", "assistant: 1", "user: b"]);
  });

  void it("with --no-history it shows the disabled notice and asks nothing", async () => {
    const result = await run(new ScriptedProvider("ollama"), ["/cleanup", "yes"], ["--no-history"]);
    assert.match(result.out, /Conversation history is disabled for this session \(--no-history\)\.\n/);
    assert.doesNotMatch(result.out, /Delete \d/);
  });

  void it("a partial failure reports the deleted count and a safe error, and preserves the in-memory session", async () => {
    const history = new MemoryHistory();
    history.files = 3;
    history.deleteResult = { deleted: 2, error: { message: "Could not delete conversation history at /x/y.json: Permission denied." } };
    const provider = new ScriptedProvider("ollama", [answer("1"), answer("2")]);
    const result = await runChat(["--provider", "ollama", "--model", "m"], provider, new ManualInput(["a", "/cleanup", "yes", "b"], true), { tree, deps: { createHistoryStore: () => history } });
    assert.equal(result.code, 0);
    assert.match(result.err, /error: Could not delete conversation history at \/x\/y\.json: Permission denied\. Deleted 2 saved conversation\(s\) before the failure; they cannot be restored\.\n/);
    assert.doesNotMatch(result.out, /Deleted 2 saved conversation\(s\)\. Started/);
    assert.deepEqual(provider.sent(1), ["user: a", "assistant: 1", "user: b"]);
  });

  void it("symlinks inside the conversations directory are neither counted nor deleted", async () => {
    await seedFiles();
    const outside = join(tree.root, "outside.json");
    await writeFile(outside, "outside");
    await symlink(outside, join(tree.conversations, "link.json"));
    const result = await run(new ScriptedProvider("ollama"), ["/cleanup", "yes"]);
    assert.match(result.out, /Deleted 3 saved conversation\(s\)/);
    assert.equal(await readFile(outside, "utf8"), "outside");
  });
});
