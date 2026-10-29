import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { savedPreferences } from "../src/application/chat-startup.js";
import { ProviderError } from "../src/domain/errors.js";
import type { ModelCapabilities } from "../src/domain/settings.js";
import { run } from "../src/main.js";
import { missingApiKeyError } from "../src/providers/openai/errors.js";
import { decodeSettings, encodeActiveSelection, encodeConversation } from "../src/storage/index.js";
import type { StoredConversation } from "../src/storage/index.js";
import { ManualInput, ScriptedProvider, answer, runChat } from "./helpers/chat.js";
import type { ChatRun } from "./helpers/chat.js";
import { ID_A, ID_B, ID_C, conversation, makeTree, put, without } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

let tree: Tree;
beforeEach(async () => {
  tree = await makeTree();
});
afterEach(async () => {
  await tree.cleanup();
});

const ID_D = "44444444-4444-4444-8444-444444444444";

/** Bytes of every regular file below `dir`, keyed by relative path. */
async function snapshot(dir: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }
  for (const name of entries.sort()) {
    const info = await lstat(join(dir, name));
    if (info.isDirectory()) Object.assign(result, await snapshot(join(dir, name), `${prefix}${name}/`));
    else result[`${prefix}${name}`] = (await readFile(join(dir, name))).toString("latin1");
  }
  return result;
}

const store = (id: string, extra: Partial<StoredConversation>): Promise<void> => put(join(tree.conversations, `${id}.json`), encodeConversation(conversation(id, undefined, extra)));
const writeActive = (provider: "openai" | "ollama", model: string): Promise<void> => put(tree.active, encodeActiveSelection({ provider, model }));
const chat = (provider: ScriptedProvider, lines: readonly string[], argv: readonly string[] = []): Promise<ChatRun> => runChat(argv, provider, new ManualInput(lines, true), { tree });
const banner = (run: ChatRun): string => /Provider: (\S+) \| Model: (.+)\n/.exec(run.out)?.slice(1, 3).join("/") ?? "no banner";

async function seed(): Promise<void> {
  await store(ID_A, { provider: "openai", model: "gpt-x", updatedAt: new Date("2026-10-21T08:00:00.000Z"), messages: [{ role: "user", content: "openai chat" }, { role: "assistant", content: "oa" }] });
  await store(ID_B, { provider: "ollama", model: "qwen", updatedAt: new Date("2026-10-22T08:00:00.000Z"), messages: [{ role: "user", content: "ollama chat" }, { role: "assistant", content: "ob" }] });
  await store(ID_C, { provider: "ollama", model: "llama", updatedAt: new Date("2026-10-20T08:00:00.000Z"), messages: [{ role: "user", content: "llama chat" }, { role: "assistant", content: "oc" }] });
}

void describe("chat startup: restore matrix", () => {
  void it("neither provider nor model: the active selection wins, else the newest eligible conversation", async () => {
    await seed();
    const newest = await chat(new ScriptedProvider("ollama"), ["/exit"]);
    assert.equal(banner(newest), "ollama/qwen"); // no active.json: the newest across supported providers
    await writeActive("openai", "gpt-x");
    const provider = new ScriptedProvider("openai");
    const run = await chat(provider, ["next"]);
    assert.equal(banner(run), "openai/gpt-x");
    assert.deepEqual(provider.sent(0), ["user: openai chat", "assistant: oa", "user: next"]);
    assert.match(run.out, /Restored conversation from \d{4}-\d\d-\d\d \d\d:\d\d \(2 messages\)\. Type \/reset to start a new one\.\n\n/);
  });

  void it("a valid active selection without a matching conversation starts a new one for it, with no fallback", async () => {
    await seed();
    await writeActive("ollama", "brand-new");
    const provider = new ScriptedProvider("ollama");
    const run = await chat(provider, ["hi"]);
    assert.equal(banner(run), "ollama/brand-new");
    assert.deepEqual(provider.sent(0), ["user: hi"]);
    assert.doesNotMatch(run.out, /Restored/);
  });

  void it("--provider only: the newest conversation of that provider and its model", async () => {
    await seed();
    const provider = new ScriptedProvider("ollama");
    const run = await chat(provider, ["x"], ["--provider", "ollama"]);
    assert.equal(banner(run), "ollama/qwen");
    const openai = await chat(new ScriptedProvider("openai"), ["x"], ["--provider", "openai"]);
    assert.equal(banner(openai), "openai/gpt-x");
  });

  void it("an explicit --provider openai differs from an omitted one", async () => {
    await seed();
    await writeActive("ollama", "qwen");
    assert.equal(banner(await chat(new ScriptedProvider("ollama"), [])), "ollama/qwen");
    assert.equal(banner(await chat(new ScriptedProvider("openai"), [], ["--provider", "openai"])), "openai/gpt-x");
  });

  void it("--model alone means OpenAI; model and provider together need the exact pair", async () => {
    await seed();
    const modelOnly = await chat(new ScriptedProvider("openai"), [], ["--model", "gpt-x"]);
    assert.equal(banner(modelOnly), "openai/gpt-x");
    assert.match(modelOnly.out, /Restored/);
    const other = await chat(new ScriptedProvider("openai"), [], ["--model", "qwen"]); // an Ollama conversation of that name is not OpenAI's
    assert.equal(banner(other), "openai/qwen");
    assert.doesNotMatch(other.out, /Restored/);
    const exact = await chat(new ScriptedProvider("ollama"), [], ["--provider", "ollama", "--model", "llama"]);
    assert.equal(banner(exact), "ollama/llama");
    assert.match(exact.out, /Restored/);
    const noPair = await chat(new ScriptedProvider("ollama"), [], ["--provider", "ollama", "--model", "other"]);
    assert.doesNotMatch(noPair.out, /Restored/);
  });

  void it("legacy files without metadata count as OpenAI and take the requested or default model; unknown providers are skipped untouched", async () => {
    const legacyPath = join(tree.conversations, `${ID_A}.json`);
    await put(legacyPath, encodeConversation(without(conversation(ID_A, "2026-10-22T08:00:00.000Z", { messages: [{ role: "user", content: "legacy" }, { role: "assistant", content: "l" }] }), "provider", "model")));
    const foreign = encodeConversation(conversation(ID_B, "2026-10-23T08:00:00.000Z", { provider: "anthropic", model: "claude" }));
    await put(join(tree.conversations, `${ID_B}.json`), foreign);
    const before = await snapshot(tree.app);
    const provider = new ScriptedProvider("openai", [], { defaultModel: "gpt-default" });
    const run = await chat(provider, ["/exit"]);
    assert.equal(banner(run), "openai/gpt-default");
    assert.match(run.out, /Restored/);
    assert.deepEqual(await snapshot(tree.app), before); // restoring and exiting rewrote nothing
    const withModel = await chat(new ScriptedProvider("openai"), ["/exit"], ["--model", "pinned"]);
    assert.equal(banner(withModel), "openai/pinned");
    assert.match(withModel.out, /Restored/);
  });

  void it("filling defaults: an unresolved provider is OpenAI and an unresolved model is that provider's default", async () => {
    const provider = new ScriptedProvider("openai", [], { defaultModel: "the-default" });
    const run = await chat(provider, []);
    assert.equal(banner(run), "openai/the-default");
    assert.equal(provider.defaultModelCalls, 1);
    const ollama = new ScriptedProvider("ollama", [], { defaultModel: "local-first" });
    assert.equal(banner(await chat(ollama, [], ["--provider", "ollama"])), "ollama/local-first");
    const pinned = new ScriptedProvider("ollama", [], { defaultModel: "unused" });
    await chat(pinned, [], ["--provider", "ollama", "--model", "m"]);
    assert.equal(pinned.defaultModelCalls, 0);
  });

  void it("opening and exiting leaves every byte unchanged and creates nothing, including after a restored empty conversation", async () => {
    await seed();
    await writeActive("ollama", "qwen");
    await store(ID_D, { provider: "ollama", model: "qwen", updatedAt: new Date("2026-10-25T08:00:00.000Z"), messages: [] });
    const before = await snapshot(tree.root);
    const run = await chat(new ScriptedProvider("ollama"), ["/exit"]);
    assert.equal(run.code, 0);
    assert.doesNotMatch(run.out, /Restored/); // restoring an empty conversation prints no notice
    assert.deepEqual(await snapshot(tree.root), before);
  });

  void it("a restored empty conversation is adopted: the next exchange is saved under its identity", async () => {
    await store(ID_D, { provider: "ollama", model: "qwen", messages: [] });
    await chat(new ScriptedProvider("ollama"), ["hello"]);
    assert.deepEqual((await readdir(tree.conversations)).sort(), [`${ID_D}.json`]);
    assert.match(await readFile(join(tree.conversations, `${ID_D}.json`), "utf8"), /"hello"/);
  });

  void it("an active.json naming an unsupported provider is ignored with a warning and left untouched", async () => {
    await seed();
    const foreign = '{"schema_version": 1, "provider": "anthropic", "model": "claude"}\n';
    await put(tree.active, foreign);
    const run = await chat(new ScriptedProvider("ollama"), ["/exit"]);
    assert.equal(banner(run), "ollama/qwen"); // fell back to the newest eligible conversation
    assert.match(run.err, /^warning: Ignoring .*active\.json/);
    assert.equal(await readFile(tree.active, "utf8"), foreign);
  });

  void it("/usage after a restore aggregates the restored records", async () => {
    await store(ID_A, {
      provider: "ollama",
      model: "qwen",
      requests: [
        { at: new Date("2026-10-21T08:00:00.000Z"), provider: "ollama", model: "qwen", status: "completed", usage: { inputTokens: 2n ** 65n, outputTokens: 1n } },
        { at: new Date("2026-10-21T08:00:05.000Z"), provider: "ollama", model: "qwen", status: "incomplete", usage: { outputTokens: 4n } },
      ],
    });
    const run = await chat(new ScriptedProvider("ollama"), ["/usage", "/exit"]);
    assert.match(run.out, /2 request\(s\): 1 completed, 1 incomplete/);
    assert.match(run.out, /Input tokens: 36,893,488,147,419,103,232 \(reported subtotal: 1 of 2/);
    assert.match(run.out, /Output tokens: 5\n/);
  });

  void it("warnings come out once, in a deterministic order, on stderr after the banner", async () => {
    await seed();
    await put(join(tree.conversations, "bad.json"), "{");
    await put(tree.active, "[]");
    await put(tree.settings, "{");
    const run = await chat(new ScriptedProvider("ollama"), []);
    const warnings = run.err.trim().split("\n");
    assert.equal(warnings.length, 3);
    assert.match(warnings[0] ?? "", /^warning: Ignoring invalid .*active\.json\.$/);
    assert.match(warnings[1] ?? "", /^warning: Ignoring unreadable conversation file .*bad\.json: .*left unchanged\.$/);
    assert.match(warnings[2] ?? "", /^warning: Ignoring invalid settings file .*settings\.json: /);
    assert.ok(run.log.findIndex((l) => l.startsWith("err:")) > run.log.findIndex((l) => l.startsWith("out:NeuroBr")));
    assert.equal(await readFile(join(tree.conversations, "bad.json"), "utf8"), "{");
  });
});

void describe("chat startup: provider selection", () => {
  void it("builds only the selected provider and checks readiness for it before the banner", async () => {
    await seed();
    const created: string[] = [];
    const ready: string[] = [];
    const provider = new ScriptedProvider("ollama");
    const result = await runChat([], provider, new ManualInput([], true), {
      tree,
      deps: {
        createProvider: (id) => { created.push(id); return provider; },
        checkProviderReady: (id) => { ready.push(id); },
      },
    });
    assert.equal(result.code, 0);
    assert.deepEqual(created, ["ollama"]);
    assert.deepEqual(ready, ["ollama"]);
  });

  void it("a missing OpenAI key exits 3 before any banner or input read", async () => {
    const input = new ManualInput(["q"]);
    const result = await runChat([], new ScriptedProvider("openai"), input, {
      tree,
      deps: { checkProviderReady: () => { throw missingApiKeyError(); } },
    });
    assert.equal(result.code, 3);
    assert.equal(result.out, "");
    assert.match(result.err, /^neurobrau: error: OPENAI_API_KEY is not set/);
    assert.equal(input.readCalls, 0);
    assert.ok(input.disposed);
  });

  void it("a failed capability lookup ends startup with the mapped exit code and no banner", async () => {
    const provider = new ScriptedProvider("ollama", [], { capabilityError: new ProviderError("Model qwen is not installed.", "api") });
    const result = await chat(provider, ["q"], ["--provider", "ollama", "--model", "qwen"]);
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.equal(provider.calls, 0);
  });

  void it("never replaces a restored model that the provider reports as unusable", async () => {
    await seed();
    const provider = new ScriptedProvider("ollama", [], { capabilityError: new ProviderError("Model qwen is not installed.", "authentication") });
    const result = await chat(provider, [], ["--provider", "ollama"]);
    assert.equal(result.code, 4);
    assert.deepEqual(provider.capabilityCalls, ["qwen"]);
  });
});

const reasoningCaps: ModelCapabilities = {
  reasoning: { known: true, values: ["none", "low", "high"], allowsModelDefault: true, defaultValue: "none" },
  maxOutputTokensLimit: 1000,
};

const settingsJson = (models: string, style = "brief"): string =>
  `{"schema_version": 1, "answer_style": "${style}", "providers": {"openai": {"models": {${models}}}}}`;

void describe("chat startup: saved settings", () => {
  void it("applies saved preferences, lets the command line win, and never writes the settings file", async () => {
    const json = settingsJson('"m": {"reasoning": "low", "max_output_tokens": 300}');
    await put(tree.settings, json);
    const saved = new ScriptedProvider("openai", [], { capabilities: reasoningCaps });
    await chat(saved, ["q"], ["--no-history", "--model", "m"]);
    assert.deepEqual(saved.requests[0]?.reasoning, { effort: "low", explicit: true, source: "saved" });
    assert.equal(saved.requests[0].maxOutputTokens, 300);
    assert.match(saved.requests[0].instructions ?? "", /^Answer briefly/);

    const cli = new ScriptedProvider("openai", [], { capabilities: reasoningCaps });
    await chat(cli, ["q"], ["--no-history", "--model", "m", "--reasoning-effort", "high", "--max-output-tokens", "50", "--answer-style", "normal"]);
    assert.deepEqual(cli.requests[0]?.reasoning, { effort: "high", explicit: true, source: "cli" });
    assert.equal(cli.requests[0].maxOutputTokens, 50);
    assert.equal(cli.requests[0].instructions, undefined);
    assert.equal(await readFile(tree.settings, "utf8"), json);
  });

  void it("strict startup: an unsupported command-line value exits 2 before the banner, with no request", async () => {
    const provider = new ScriptedProvider("openai", [], { capabilities: { reasoning: { known: true, values: [], allowsModelDefault: true } } });
    const result = await chat(provider, ["q"], ["--no-history", "--reasoning-effort", "high"]);
    assert.equal(result.code, 2);
    assert.equal(result.out, "");
    assert.match(result.err, /does not support reasoning/);
    assert.equal(provider.calls, 0);
  });

  void it("a saved limit beyond Number.MAX_SAFE_INTEGER is ignored with a visible notice, kept exact on disk, and keeps valid reasoning", async () => {
    const huge = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    const json = settingsJson(`"m": {"reasoning": "high", "max_output_tokens": ${huge}}`);
    await put(tree.settings, json);
    const provider = new ScriptedProvider("openai", [], { capabilities: reasoningCaps });
    const result = await chat(provider, ["q"], ["--no-history", "--model", "m"]);
    assert.equal(result.code, 0);
    assert.match(result.err, new RegExp(`warning: Saved setting ignored: max output tokens ${huge} for openai/m cannot be used`));
    assert.equal(provider.requests[0]?.maxOutputTokens, undefined);
    assert.deepEqual(provider.requests[0]?.reasoning, { effort: "high", explicit: true, source: "saved" });
    assert.equal(await readFile(tree.settings, "utf8"), json);
    assert.ok(decodeSettings(json).settings.providers.get("openai")?.get("m")?.maxOutputTokens === BigInt(huge));
  });

  void it("converts saved limits only after bigint bounds checks (null, boundary values, absent)", () => {
    const withLimit = (limit: bigint | null | undefined) => savedPreferences({ answerStyle: "normal", providers: new Map([["openai", new Map([["m", { reasoning: "low", ...(limit === undefined ? {} : { maxOutputTokens: limit }) }]])]]) }, "openai", "m", false);
    assert.equal(withLimit(null).preferences.maxOutputTokens, null);
    assert.equal("maxOutputTokens" in withLimit(undefined).preferences, false);
    assert.equal(withLimit(BigInt(Number.MAX_SAFE_INTEGER)).preferences.maxOutputTokens, Number.MAX_SAFE_INTEGER);
    const over = withLimit(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    assert.equal("maxOutputTokens" in over.preferences, false);
    assert.equal(over.preferences.reasoning, "low");
    assert.equal(over.notices.length, 1);
    assert.equal(withLimit(2n ** 70n).notices.length, 1);
    assert.deepEqual(savedPreferences(undefined, "openai", "m", false), { preferences: {}, notices: [] });
  });

  void it("a saved limit above the model's limit is reported by the resolver and the rest is kept", async () => {
    await put(tree.settings, settingsJson('"m": {"reasoning": "low", "max_output_tokens": 5000}'));
    const provider = new ScriptedProvider("openai", [], { capabilities: reasoningCaps });
    const result = await chat(provider, ["q"], ["--no-history", "--model", "m"]);
    assert.match(result.err, /Saved setting ignored: 5000 exceeds the limit of 1000 output tokens for m\./);
    assert.equal(provider.requests[0]?.maxOutputTokens, undefined);
    assert.equal(provider.requests[0]?.reasoning.effort, "low");
  });

  void it("a whole-file settings failure is a warning and defaults apply; the file is left alone", async () => {
    await put(tree.settings, "not json");
    const provider = new ScriptedProvider("openai");
    const result = await chat(provider, ["q"], ["--no-history"]);
    assert.equal(result.code, 0);
    assert.match(result.err, /^warning: Ignoring invalid settings file .*settings\.json: .*Using defaults; changes will not be saved/);
    assert.equal(await readFile(tree.settings, "utf8"), "not json");
  });

  void it("does not create the settings directory or file when none exists", async () => {
    await chat(new ScriptedProvider("openai"), ["q"], ["--no-history"]);
    await assert.rejects(stat(tree.config));
  });
});

void describe("chat startup: --no-history and missing locations", () => {
  void it("--no-history reads and writes no state, creates no directory, changes no mode, yet settings still apply", async () => {
    await seed();
    await chmod(tree.app, 0o755);
    await writeActive("ollama", "qwen");
    await put(tree.settings, settingsJson('"gpt-6-luna": {"reasoning": "low"}'));
    const before = await snapshot(tree.root);
    const provider = new ScriptedProvider("openai", [], { capabilities: reasoningCaps });
    const result = await chat(provider, ["a", "/reset", "b", "/usage", "/cleanup", "/exit"], ["--no-history", "--model", "gpt-6-luna"]);
    assert.equal(result.code, 0);
    assert.equal(provider.requests[0]?.reasoning.effort, "low");
    assert.deepEqual(await snapshot(tree.root), before);
    assert.equal((await stat(tree.app)).mode & 0o777, 0o755);
    const fresh = await makeTree();
    try {
      await chat2(fresh, ["--no-history"]);
      await assert.rejects(stat(fresh.state));
    } finally {
      await fresh.cleanup();
    }
  });

  void it("--no-history does not even read an unreadable conversations directory (any history access would warn)", async () => {
    await seed();
    const before = await snapshot(tree.root);
    await chmod(tree.conversations, 0o311);
    try {
      const run = await chat(new ScriptedProvider("openai"), ["hi", "/exit"], ["--no-history"]);
      assert.equal(run.code, 0);
      assert.equal(run.err, "");
      assert.equal((await stat(tree.conversations)).mode & 0o777, 0o311);
    } finally {
      await chmod(tree.conversations, 0o700);
    }
    assert.deepEqual(await snapshot(tree.root), before);
  });

  void it("each storage component is disabled independently when its base cannot be determined", async () => {
    const none = await runChat([], new ScriptedProvider("openai"), new ManualInput([], true), { env: {}, home: undefined });
    assert.equal(none.code, 0);
    assert.equal(none.err, "warning: Cannot determine the home directory; conversation history is disabled.\nwarning: Cannot determine the home directory; settings are not loaded or saved.\n");

    const stateOnly = await runChat([], new ScriptedProvider("openai"), new ManualInput(["hi"], true), { env: { XDG_STATE_HOME: tree.state }, home: undefined });
    assert.equal(stateOnly.err, "warning: Cannot determine the home directory; settings are not loaded or saved.\n");
    assert.deepEqual((await readdir(tree.conversations)).length, 1); // history works

    const configOnly = await runChat(["--no-history"], new ScriptedProvider("openai"), new ManualInput([], true), { env: { XDG_CONFIG_HOME: join(tree.root, "config") }, home: undefined });
    assert.equal(configOnly.err, ""); // --no-history never resolves or warns about history
    const configWithHistory = await runChat([], new ScriptedProvider("openai"), new ManualInput(["hi"], true), { env: { XDG_CONFIG_HOME: join(tree.root, "config") }, home: undefined });
    assert.equal(configWithHistory.err, "warning: Cannot determine the home directory; conversation history is disabled.\n");
    assert.equal(configWithHistory.code, 0);

    const relative = await runChat([], new ScriptedProvider("openai"), new ManualInput([], true), { env: { XDG_STATE_HOME: "relative", XDG_CONFIG_HOME: "rel" }, home: "also/relative" });
    assert.match(relative.err, /history is disabled/);
  });

  void it("one-shot prompts ignore all state and configuration, even corrupt ones, and never build a store", async () => {
    await put(tree.settings, "{");
    await put(tree.active, "garbage");
    await put(join(tree.conversations, "x.json"), "{");
    const before = await snapshot(tree.root);
    const provider = new ScriptedProvider("openai", [answer("done")]);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["prompt text"], { stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); } }, {
      createProvider: () => provider,
      storageEnvironment: { env: { XDG_STATE_HOME: tree.state, XDG_CONFIG_HOME: join(tree.root, "config") } },
      createHistoryStore: () => { throw new Error("one-shot must not build a history store"); },
      createSettingsStore: () => { throw new Error("one-shot must not build a settings store"); },
      createInput: () => { throw new Error("one-shot must not read input"); },
    });
    assert.equal(code, 0);
    assert.equal(out.join(""), "done\n");
    assert.equal(err.join(""), "");
    assert.deepEqual(await snapshot(tree.root), before);
  });

  void it("lenient behavior is not used: --plain and --no-history with a prompt are rejected before any provider or filesystem work", async () => {
    let touched = 0;
    for (const argv of [["--plain", "p"], ["--no-history", "p"]]) {
      const code = await run(argv, { stdout: () => undefined, stderr: () => undefined }, {
        createProvider: () => { touched += 1; return new ScriptedProvider("openai"); },
        createHistoryStore: () => { touched += 1; throw new Error("no"); },
        createSettingsStore: () => { touched += 1; throw new Error("no"); },
      });
      assert.equal(code, 2);
    }
    assert.equal(touched, 0);
  });

  void it("symlinked state locations are refused by the stores, not followed, and chat continues with a warning", async () => {
    const elsewhere = join(tree.root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o755 });
    await mkdir(tree.state, { recursive: true });
    await symlink(elsewhere, tree.app);
    const provider = new ScriptedProvider("openai");
    const result = await chat(provider, ["hi"]);
    assert.equal(result.code, 0);
    assert.match(result.err, /Is a symbolic link/);
    assert.equal(provider.calls, 1);
    assert.deepEqual(await readdir(elsewhere), []);
    assert.equal((await stat(elsewhere)).mode & 0o777, 0o755);
  });
});

async function chat2(t: Tree, argv: readonly string[]): Promise<ChatRun> {
  return runChat(argv, new ScriptedProvider("openai"), new ManualInput(["x"], true), { tree: t });
}
