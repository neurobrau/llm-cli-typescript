// Session interoperability: the real TypeScript application (dist/main.js run()
// with the real filesystem stores, fake providers and a synthetic state/config
// root) continues, writes and restores conversations that the real Python and
// Go writers produced, and the real Python and Go readers/writers read the
// saved bytes back at every checkpoint.
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers";

import { seedSpec, semantic, tsRewrite } from "./stage-storage.mjs";
import { fakeProvider, runFullscreen, runSession } from "./sessions.mjs";
import { Failure, expectClean, parseOracleJson, runBounded } from "./lib.mjs";

const SEED_BIG = 9007199254740993n;

function tree(scratch, name) {
  const root = join(scratch, "sessions", name);
  mkdirSync(join(root, "state", "neurobrau", "conversations"), { recursive: true });
  mkdirSync(join(root, "config", "neurobrau"), { recursive: true });
  return root;
}
const conversationsOf = (root) => join(root, "state", "neurobrau", "conversations");

/** Collects the saved files of a tree under oracle-friendly names. */
function collect(root, prefix) {
  const files = new Map();
  for (const name of readdirSync(conversationsOf(root)).sort()) files.set(`conversation_${prefix}_${name}`, readFileSync(join(conversationsOf(root), name)));
  const active = join(root, "state", "neurobrau", "active.json");
  if (existsSync(active)) files.set(`active_${prefix}.json`, readFileSync(active));
  const settings = join(root, "config", "neurobrau", "settings.json");
  if (existsSync(settings)) files.set(`settings_${prefix}.json`, readFileSync(settings));
  return files;
}

async function readers(ctx, dir, files) {
  const names = [...files.keys()];
  const out = {};
  for (const who of ["Python", "Go"]) {
    const run =
      who === "Python"
        ? await runBounded(ctx.py.exe, ["-B", "-I", join(ctx.root, "scripts", "python_storage_parity.py"), "check", ctx.py.src, dir], { env: ctx.py.env })
        : await runBounded(ctx.go.exe, ["storage-check", dir], { env: ctx.go.env });
    const parsed = parseOracleJson(expectClean(run, `${who} storage oracle`), `${who} storage oracle`);
    for (const name of names) {
      const text = parsed.rewritten?.[name];
      if (text === undefined) throw new Failure(`${who} could not read ${name}: ${String(parsed.problems?.[name])}`);
      if (Buffer.compare(Buffer.from(text, "utf8"), files.get(name)) !== 0) throw new Failure(`${who} rewrote ${name} with different bytes`);
    }
    out[who] = new Map(names.map((n) => [n, Buffer.from(parsed.rewritten[n], "utf8")]));
  }
  return out;
}

/** Checkpoint: the saved bytes of a scenario are read and rewritten identically by Python and Go. */
async function checkpoint(ctx, label, files) {
  const dir = join(ctx.scratch, "sessions", `checkpoint-${label}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
  const read = await readers(ctx, dir, files);
  for (const [name, bytes] of files) if (tsRewrite(ctx.modules.codecs, name, bytes) !== bytes.toString("utf8")) throw new Failure(`${label}: ${name} does not round-trip in TypeScript`);
  return read;
}

const decodeAll = (codecs, bytes) => codecs.decodeConversation(Buffer.from(bytes));
const sum = (records, field) => records.reduce((n, r) => n + (r.usage[field] ?? 0n), 0n);

export async function stageSessions(ctx) {
  const { codecs, main } = ctx.modules;
  const failures = [];
  const expect = (cond, message) => {
    if (!cond) failures.push(message);
  };
  const sessionRoot = join(ctx.scratch, "sessions");
  mkdirSync(sessionRoot, { recursive: true });
  let checkpoints = 0;

  // seeds from the references' own writers
  const spec = seedSpec();
  const specFile = join(sessionRoot, "seeds.json");
  writeFileSync(specFile, JSON.stringify(spec));
  const pySeeds = join(sessionRoot, "py-seeds");
  const goSeeds = join(sessionRoot, "go-seeds");
  expectClean(await runBounded(ctx.py.exe, ["-B", "-I", join(ctx.root, "scripts", "xparity", "py_storage_write.py"), ctx.py.src, specFile, pySeeds], { env: ctx.py.env }), "Python seed writer");
  expectClean(await runBounded(ctx.go.exe, ["storage-write", specFile, goSeeds], { env: ctx.go.env }), "Go seed writer");

  // 1. Python-written conversation restored and continued by TypeScript, then read by Go and Python.
  {
    const root = tree(ctx.scratch, "py-seed");
    const seed = readFileSync(join(pySeeds, "conversation_seed_ollama.json"));
    const before = decodeAll(codecs, seed);
    writeFileSync(join(conversationsOf(root), `${before.id}.json`), seed);
    const provider = fakeProvider("ollama", [{ kind: "completed", result: { text: "continued é", usage: { inputTokens: 20n, outputTokens: 4n, totalTokens: 24n } } }]);
    const code = await runSession(main, root, ["--provider", "ollama", "--model", "m"], ["continue please", "/exit"], provider);
    expect(code === 0, `Python seed continuation exited ${String(code)}`);
    expect(JSON.stringify(provider.seen[0]) === JSON.stringify([...before.messages.map((m) => `${m.role}:${m.content}`), "user:continue please"]), "Python seed: the request lacked the restored context");
    const files = collect(root, "pyseed");
    const read = await checkpoint(ctx, "py-seed", files);
    checkpoints += 1;
    for (const who of ["Python", "Go"]) {
      const after = decodeAll(codecs, read[who].get(`conversation_pyseed_${before.id}.json`));
      expect(JSON.stringify(after.messages.slice(0, 2)) === JSON.stringify(before.messages), `Python seed: ${who} sees changed prior messages`);
      expect(after.messages.length === 4 && after.messages[3].content === "continued é", `Python seed: ${who} lacks the new exchange`);
      expect(after.requests.length === before.requests.length + 1, `Python seed: ${who} record count`);
      expect(sum(after.requests, "inputTokens") === SEED_BIG + 20n && sum(after.requests, "outputTokens") === 11n, `Python seed: ${who} accumulated usage is not exact (${String(sum(after.requests, "inputTokens"))})`);
    }
  }

  // 2. Go-written conversation (OpenAI selection, empty tier + incomplete record) continued by TypeScript.
  {
    const root = tree(ctx.scratch, "go-seed");
    const seed = readFileSync(join(goSeeds, "conversation_seed_openai.json"));
    const before = decodeAll(codecs, seed);
    writeFileSync(join(conversationsOf(root), `${before.id}.json`), seed);
    const provider = fakeProvider("openai", [{ kind: "completed", result: { text: "next", usage: { inputTokens: 30n, outputTokens: 2n }, serviceTier: "default" } }]);
    const code = await runSession(main, root, ["--provider", "openai", "--model", "gpt-6-luna"], ["go on", "/exit"], provider);
    expect(code === 0, `Go seed continuation exited ${String(code)}`);
    const files = collect(root, "goseed");
    const read = await checkpoint(ctx, "go-seed", files);
    checkpoints += 1;
    for (const who of ["Python", "Go"]) {
      const after = decodeAll(codecs, read[who].get(`conversation_goseed_${before.id}.json`));
      expect(JSON.stringify(after.messages.slice(0, 2)) === JSON.stringify(before.messages), `Go seed: ${who} sees changed prior messages`);
      expect(after.requests.length === 3, `Go seed: ${who} record count ${String(after.requests.length)}`);
      expect(after.requests[1]?.status === "incomplete" && after.requests[1].serviceTier === "", `Go seed: ${who} lost the incomplete record or its empty tier`);
      expect(sum(after.requests, "inputTokens") === 11n + 4611686018427387904n + 30n, `Go seed: ${who} accumulated input is not exact`);
    }
  }

  // 3. A streamed TypeScript session: reasoning text and a cancelled partial answer are never persisted.
  {
    const root = tree(ctx.scratch, "stream");
    const text = "stream é \u{1F600}";
    const provider = fakeProvider("ollama", [], [
      [{ kind: "reasoning", text: "never saved reasoning" }, ...Array.from(text).map((piece) => ({ kind: "text", text: piece })), { kind: "completed", result: { text, usage: { inputTokens: 9n, outputTokens: 3n }, serviceTier: "" } }],
    ]);
    let handlers = [];
    let started;
    const hasStarted = new Promise((resolve) => {
      started = resolve;
    });
    const base = provider.stream.bind(provider);
    let calls = 0;
    provider.stream = (request, signal) => {
      calls += 1;
      if (calls === 1) return base(request, signal);
      provider.seen.push(request.messages.map((m) => `${m.role}:${m.content}`));
      return {
        async *[Symbol.asyncIterator]() {
          yield { kind: "text", text: "cancelled partial answer" };
          started();
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          });
        },
      };
    };
    const queue = ["first", "second"];
    const finished = main.run(["--stream", "--provider", "ollama", "--model", "m"], { stdout: () => undefined, stderr: () => undefined }, {
      createProvider: () => provider,
      createInput: () => ({ readLine: async () => queue.shift(), dispose() {} }),
      interrupt: { register: (handler) => { handlers.push(handler); return () => { handlers = handlers.filter((h) => h !== handler); }; } },
      storageEnvironment: { env: { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") } },
      clock: (() => { let n = 0; return () => new Date(Date.UTC(2026, 9, 23, 12, 0, n++)); })(),
      newId: () => "00000000-0000-4000-8000-0000000000a1",
      cleanupTimeoutMs: 500,
    });
    await hasStarted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const handler of handlers) handler();
    const code = await finished;
    expect(code === 0, `streamed session exited ${String(code)} (an interrupt during a request returns to the prompt; EOF then ends the chat)`);
    expect(calls === 2 && provider.seen.length === 2, "the second request was not started and cancelled");
    const files = collect(root, "stream");
    for (const [name, bytes] of files) {
      expect(!bytes.includes("never saved reasoning") && !bytes.includes("cancelled partial answer"), `${name}: reasoning or a cancelled partial answer reached the saved file`);
    }
    const read = await checkpoint(ctx, "stream", files);
    checkpoints += 1;
    const saved = decodeAll(codecs, read.Go.get("conversation_stream_00000000-0000-4000-8000-0000000000a1.json"));
    expect(saved.messages.length === 2 && saved.messages[1].content === text && saved.requests.length === 1, "streamed session: unexpected saved content");
  }

  // 4. Incomplete usage is counted without committing the partial answer; an incomplete-only new conversation stays unsaved.
  {
    const root = tree(ctx.scratch, "incomplete");
    const provider = fakeProvider("ollama", [
      { kind: "completed", result: { text: "whole", usage: { inputTokens: 5n, outputTokens: 5n } } },
      { kind: "incomplete", reason: "limit", partialText: "part", usage: { inputTokens: 12n, outputTokens: 50n }, serviceTier: "flex" },
    ]);
    const code = await runSession(main, root, ["--provider", "ollama", "--model", "m"], ["one", "two", "/exit"], provider);
    expect(code === 0, `incomplete session exited ${String(code)}`);
    const files = collect(root, "incomplete");
    const read = await checkpoint(ctx, "incomplete", files);
    checkpoints += 1;
    const saved = decodeAll(codecs, [...read.Go].find(([n]) => n.startsWith("conversation_"))[1]);
    expect(saved.messages.length === 2 && saved.requests.length === 2 && saved.requests[1].status === "incomplete" && saved.requests[1].serviceTier === "flex", "incomplete: partial answer committed or record missing");
    expect(sum(saved.requests, "outputTokens") === 55n, "incomplete: usage not counted exactly");
    const only = tree(ctx.scratch, "incomplete-only");
    const code2 = await runSession(main, only, ["--provider", "ollama", "--model", "m"], ["lonely", "/exit"], fakeProvider("ollama", [{ kind: "incomplete", reason: "limit", partialText: "p", usage: { outputTokens: 9n } }]));
    expect(code2 === 0, `incomplete-only session exited ${String(code2)}`);
    expect(readdirSync(conversationsOf(only)).length === 0, "incomplete-only: a new conversation was saved (the accepted policy keeps it unsaved)");
  }

  // 5. Active selection, saved preferences (model default / null max) and independent selections across runs.
  {
    const root = tree(ctx.scratch, "selections");
    const prefs = (entries) => new Map(entries.map(([p, m]) => [p, new Map(m)]));
    const settings = codecs.encodeSettings({ answerStyle: "brief", providers: prefs([["ollama", [["m", { reasoning: "default", maxOutputTokens: null }]]], ["openai", [["gpt-6-luna", { reasoning: "low", maxOutputTokens: 600n }]]]]) });
    const settingsPath = join(root, "config", "neurobrau", "settings.json");
    writeFileSync(settingsPath, settings);
    const requests = [];
    const recording = (id, answer) => {
      const provider = fakeProvider(id, [{ kind: "completed", result: { text: answer, usage: { inputTokens: 4n, outputTokens: 2n } } }]);
      const generate = provider.generate.bind(provider);
      provider.generate = (request, signal) => {
        requests.push({ id, reasoning: request.reasoning, max: request.maxOutputTokens, instructions: request.instructions });
        return generate(request, signal);
      };
      return provider;
    };
    expect(await runSession(main, root, ["--provider", "ollama", "--model", "m"], ["to ollama", "/exit"], recording("ollama", "o")) === 0, "selection A failed");
    const afterA = new Map([...collect(root, "sel")]);
    expect(await runSession(main, root, ["--provider", "openai", "--model", "gpt-6-luna"], ["to openai", "/exit"], recording("openai", "p"), 10) === 0, "selection B failed");
    expect(await runSession(main, root, ["--provider", "ollama", "--model", "m"], ["again", "/exit"], recording("ollama", "o2"), 20) === 0, "selection A (second run) failed");
    const files = collect(root, "sel");
    const read = await checkpoint(ctx, "selections", files);
    checkpoints += 1;
    // omission semantics: model default sends no reasoning effort and no limit; the other selection uses its own saved values
    const [a, b, a2] = requests;
    expect(a.reasoning.explicit === true && a.reasoning.effort === undefined && a.max === undefined, "saved reasoning 'default' / null max did not omit both parameters");
    expect(b.reasoning.effort === "low" || b.reasoning.effort === undefined, "unexpected OpenAI reasoning");
    expect(b.max === 600 || b.max === undefined, "unexpected OpenAI limit");
    expect(a2.reasoning.explicit === true && a2.max === undefined, "second run of selection A lost its preferences");
    expect(Buffer.compare(readFileSync(settingsPath), settings.length === 0 ? Buffer.alloc(0) : Buffer.from(settings)) === 0, "settings.json was modified by plain chat sessions");
    const convs = [...files].filter(([n]) => n.startsWith("conversation_"));
    expect(convs.length === 2, `expected two independent conversations, found ${String(convs.length)}`);
    const models = convs.map(([, bytes]) => decodeAll(codecs, bytes)).sort((x, y) => x.provider.localeCompare(y.provider));
    expect(models[0].provider === "ollama" && models[0].messages.map((m) => m.content).join("|") === "to ollama|o|again|o2", "selection A conversation is wrong");
    expect(models[1].provider === "openai" && models[1].messages.map((m) => m.content).join("|") === "to openai|p", "selection B conversation is wrong");
    const aAfterB = [...afterA].filter(([n]) => n.startsWith("conversation_")).map(([, bytes]) => decodeAll(codecs, bytes));
    expect(aAfterB.length === 1 && aAfterB[0].messages.length === 2, "selection A's first conversation state is wrong");
    expect(semantic(codecs, "active.json", files.get("active_sel.json")).includes("ollama"), "active.json does not name the last selection");
    for (const who of ["Python", "Go"]) expect(read[who].get("settings_sel.json") !== undefined, `${who} could not read the saved settings`);
  }

  // 6. The fullscreen controller with menus (F6/F4/F5/F2): saved preferences and independent per-model conversations.
  {
    const root = tree(ctx.scratch, "menus");
    const big = 2n ** 62n + 5n;
    const catalog = [{ id: "hf.co/org/model:Q4_K_M", remote: false, details: "4B" }, { id: "second:latest", remote: false, details: "1B" }];
    const provider = fakeProvider("ollama", [
      { kind: "completed", result: { text: "first model answer", usage: { inputTokens: big, outputTokens: 4n } } },
      { kind: "completed", result: { text: "second model answer", usage: { inputTokens: 9n, outputTokens: 1n } } },
    ], [], catalog);
    const code = await runFullscreen(main, root, ["--provider", "ollama", "--model", "hf.co/org/model:Q4_K_M"], [
      ["m1\r", "DONE"],
      ["\x1b[17~", "ANSWER STYLE ]"], ["\x1b[F", "3/3 Enter=OK"], ["\r", "Answer style: Detailed."],
      ["\x1bOS", "[ REASONING ]"], ["\r", "Reasoning for hf.co/org/model:Q4_K_M: Model default"],
      ["\x1b[15~", "[ MAX OUTPUT TOKENS ]"], ["\x1b[F", "7/7 Enter=OK"], ["\r", "Type the max output tokens"], ["77\r", "Max output tokens for hf.co/org/model:Q4_K_M: 77."],
      ["\x1bOQ", "[ SELECT OLLAMA MODEL ]"], ["\x1b[B", "2/2 Enter=OK"], ["\r", "Now using Ollama / second:latest."],
      ["m2\r", "DONE"],
      ["\x1bOQ", "[ SELECT OLLAMA MODEL ]"], ["\x1b[H", "1/2 Enter=OK"], ["\r", "conversation (2 messages)."],
      ["\x1b[15~", "[ MAX OUTPUT TOKENS ]"], ["\x1b[H", "1/7 Enter=OK"], ["\r", "Max output tokens for hf.co/org/model:Q4_K_M: model"],
      ["/exit\r", undefined],
    ], provider);
    expect(code === 0, `fullscreen menu session exited ${String(code)}`);
    const files = collect(root, "menus");
    const read = await checkpoint(ctx, "menus", files);
    checkpoints += 1;
    const saved = codecs.decodeSettings(read.Go.get("settings_menus.json")).settings;
    const first = saved.providers.get("ollama")?.get("hf.co/org/model:Q4_K_M");
    expect(saved.answerStyle === "detailed" && first?.reasoning === "default" && first.maxOutputTokens === null, "menus: saved preferences were not preserved by the Go/Python round trip");
    const convs = [...read.Python].filter(([n]) => n.startsWith("conversation_")).map(([, b]) => decodeAll(codecs, b));
    expect(convs.length === 2 && convs.every((c) => c.messages.length === 2) && convs.find((c) => c.model === "hf.co/org/model:Q4_K_M")?.requests[0]?.usage.inputTokens === big, "menus: the two selections did not keep independent exact conversations");
  }

  if (failures.length > 0) throw new Failure(`${String(failures.length)} session problem(s):\n  ${failures.join("\n  ")}`);
  return `6 scenarios, ${String(checkpoints)} checkpoints: Python-written and Go-written conversations continued by the real TypeScript sessions and read back identically (and with exact accumulated usage) by Python and Go; streaming (reasoning and a cancelled partial never persisted), incomplete accounting, model-default/null-max omission, independent selections and the fullscreen menus verified on the saved bytes`;
}
