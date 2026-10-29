import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { decodeConversation } from "../src/storage/index.js";
import { deferred } from "./helpers/deferred.js";
import { Loopback, completedBody, json } from "./helpers/loopback.js";
import { KEY, bodyOf as openaiBody } from "./helpers/openai.js";
import { bodyOf as ollamaBody, chat as ollamaChat, paths, tag, tags } from "./helpers/ollama.js";
import { startNode } from "./helpers/spawn.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const HARNESS = resolve(import.meta.dirname, "helpers", "harness.js");

let server: Loopback;
let scratch = "";
let env: NodeJS.ProcessEnv = {};
let state = "";

before(async () => {
  server = await Loopback.start();
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-chat-exe-"));
  state = join(scratch, "state");
  // Allowlisted environment: no keys, no proxies, temporary HOME/XDG only.
  env = {
    HOME: join(scratch, "home"),
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(scratch, "config"),
    OLLAMA_HOST: server.origin.replace("http://", ""),
    HARNESS_OLLAMA_BASE: server.origin,
  };
  assert.equal(server.pending, 0, "previous test left unconsumed responders");
  server.requests.length = 0;
  server.unexpected.length = 0;
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  assert.equal(server.unexpected.length, 0);
});

const conversations = (): string => join(state, "neurobrau", "conversations");
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const plain = tag("m1", { capabilities: ["completion"], details: { context_length: 4096 } });
const messagesOf = (body: Record<string, unknown>): string[] => (body.messages as { role: string; content: string }[]).map((m) => `${m.role}: ${m.content}`);

void describe("plain chat through dist/cli.js with Ollama (loopback, piped stdin)", () => {
  void it("runs several piped turns with growing context, saves owner-only files and restores them in a new process", async () => {
    server.expect(tags(plain), ollamaChat("A", { prompt_eval_count: 2, eval_count: 3 }), ollamaChat("B"));
    const first = await startNode([CLI, "--provider", "ollama", "--model", "m1", "--usage"], env, 20_000, "first\nsecond\r\n/exit\n").result;
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^NeuroBräu TypeScript CLI .*\nProvider: ollama \| Model: m1\nType \/help for commands, \/exit to quit\.\n\nYOU > AI > A\nYOU > AI > B\nYOU > Goodbye\.\n$/);
    assert.equal(first.stderr, "Token usage: input=2, output=3, total=5\nToken usage: not reported\n");
    assert.deepEqual(paths(server), ["GET /api/tags", "POST /api/chat", "POST /api/chat"]);
    const [, one, two] = server.requests;
    assert.ok(one && two);
    assert.deepEqual(messagesOf(ollamaBody(one)), ["user: first"]);
    assert.deepEqual(messagesOf(ollamaBody(two)), ["user: first", "assistant: A", "user: second"]);
    assert.equal(ollamaBody(one).stream, false);
    assert.equal(ollamaBody(one).think, undefined);

    const [name] = await readdir(conversations());
    assert.ok(name);
    const saved = decodeConversation(await readFile(join(conversations(), name)));
    assert.deepEqual(saved.messages.map((m) => m.content), ["first", "A", "second", "B"]);
    assert.equal(saved.requests.length, 1);
    assert.equal(saved.requests[0]?.usage.totalTokens, 5n);
    assert.equal(await mode(join(state, "neurobrau")), 0o700);
    assert.equal(await mode(conversations()), 0o700);
    assert.equal(await mode(join(conversations(), name)), 0o600);
    assert.equal(await mode(join(state, "neurobrau", "active.json")), 0o600);
    assert.equal(server.unexpected.length, 0);

    server.requests.length = 0;
    server.expect(tags(plain), ollamaChat("C"));
    const second = await startNode([CLI], env, 20_000, "third\n").result;
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Provider: ollama \| Model: m1\n.*\n\nRestored conversation from .* \(4 messages\)\. Type \/reset to start a new one\.\n\nYOU > AI > C\n/s);
    assert.deepEqual(messagesOf(ollamaBody(server.requests[1] ?? assert.fail("no chat"))), ["user: first", "assistant: A", "user: second", "assistant: B", "user: third"]);
  });

  void it("exits 0 at EOF after finishing buffered lines, and applies saved settings from the temp config", async () => {
    const config = join(scratch, "config", "neurobrau");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), '{"schema_version": 1, "answer_style": "detailed", "providers": {"ollama": {"models": {"m1": {"max_output_tokens": 77}}}}}');
    server.expect(tags(plain), ollamaChat("x"), ollamaChat("y"));
    const done = await startNode([CLI, "--no-history", "--provider", "ollama", "--model", "m1"], env, 20_000, "one\ntwo").result;
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout.split("AI > ").length - 1, 2);
    const body = ollamaBody(server.requests[1] ?? assert.fail("no chat"));
    assert.deepEqual(body.options, { num_predict: 77 });
    assert.match(String((body.messages as { content: string }[])[0]?.content), /^Give a comprehensive/);
    await assert.rejects(stat(state)); // --no-history created nothing
  });

  void it("an unavailable model ends startup with exit 1 before the banner", async () => {
    server.expect(tags(plain), tags(plain)); // the adapter refreshes the list once before giving up
    const done = await startNode([CLI, "--provider", "ollama", "--model", "missing"], env, 20_000, "q\n").result;
    assert.equal(done.code, 1);
    assert.equal(done.stdout, "");
    assert.deepEqual(paths(server), ["GET /api/tags", "GET /api/tags"]); // never a chat request, never a download
  });
});

void describe("plain chat through the executable harness with OpenAI (loopback, synthetic key)", () => {
  const openaiReply = (text: string, extra: Record<string, unknown> = {}) => json(200, completedBody(text, extra));

  void it("sends store:false requests whose input grows, maps settings, and saves bytes", async () => {
    server.expect(openaiReply("one", { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }, service_tier: "default" }), openaiReply("two"));
    const done = await startNode([HARNESS, server.url, "--answer-style", "brief", "--max-output-tokens", "99"], env, 20_000, "alpha\nbeta\n").result;
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /Provider: openai \| Model: gpt-6-luna\n/);
    assert.equal(server.requests.length, 2);
    const [one, two] = server.requests.map(openaiBody);
    assert.ok(one && two);
    assert.equal(one.store, false);
    assert.equal(one.max_output_tokens, 99);
    assert.deepEqual(one.reasoning, { effort: "none" });
    assert.match(String(one.instructions), /^Answer briefly/);
    const inputs = (body: Record<string, unknown>): string[] =>
      (body.input as { role: string; content: unknown }[]).map((m) => `${m.role}: ${JSON.stringify(m.content).replace(/^\[\{.*"text":"(.*?)".*\}\]$/, '"$1"')}`);
    assert.equal((two.input as unknown[]).length, 3);
    assert.match(inputs(two).join("\n"), /user: "alpha"\nassistant: "one"\nuser: "beta"/);
    const [name] = await readdir(conversations());
    assert.ok(name);
    const saved = decodeConversation(await readFile(join(conversations(), name)));
    assert.equal(saved.requests[0]?.serviceTier, "default");
    assert.equal(saved.requests[0].usage.totalTokens, 7n);
    assert.equal(server.requests.some((r) => r.path.endsWith("/models")), false); // no Models API call at startup
    assert.equal(server.requests[0]?.headers.authorization, `Bearer ${KEY}`);
  });

  void it("a provider error is recoverable: the chat goes on and exits 0", async () => {
    server.expect(json(401, { error: { message: `bad ${KEY}` } }), openaiReply("fine"));
    const done = await startNode([HARNESS, server.url, "--no-history"], env, 20_000, "q1\nq2\n").result;
    assert.equal(done.code, 0);
    assert.equal(done.stderr, "error: OpenAI authentication failed. Check that OPENAI_API_KEY is valid.\n");
    assert.match(done.stdout, /AI > fine\n/);
    const second = openaiBody(server.requests[1] ?? assert.fail("no second request"));
    assert.equal((second.input as unknown[]).length, 1);
  });
});

void describe("plain chat: missing credentials through dist/cli.js", () => {
  void it("exits 3 before the banner and before reading input, without any request", async () => {
    const done = await startNode([CLI, "--provider", "openai"], env, 20_000, "hello\n").result;
    assert.equal(done.code, 3);
    assert.equal(done.stdout, "");
    assert.match(done.stderr, /^neurobrau: error: OPENAI_API_KEY is not set\./);
    assert.equal(server.requests.length, 0);
    await assert.rejects(stat(state));
  });

  void it("starts a no-argument chat only after checking the key of the selected provider", async () => {
    const done = await startNode([CLI], env, 20_000, "").result; // nothing saved: OpenAI by default
    assert.equal(done.code, 3);
  });
});

interface LiveChild {
  readonly child: ReturnType<typeof spawn>;
  readonly result: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
  waitFor(stream: "stdout" | "stderr", pattern: RegExp): Promise<void>;
  write(text: string): void;
}

function live(args: readonly string[]): LiveChild {
  const child = spawn(process.execPath, [...args], { env, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000, killSignal: "SIGKILL" });
  const buffers = { stdout: "", stderr: "" };
  const waiters: { stream: "stdout" | "stderr"; pattern: RegExp; resolve: () => void }[] = [];
  const check = (): void => {
    for (const waiter of [...waiters]) {
      if (waiter.pattern.test(buffers[waiter.stream])) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { buffers.stdout += chunk; check(); });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { buffers.stderr += chunk; check(); });
  child.stdin.on("error", () => undefined);
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { resolvePromise({ code, signal }); });
  });
  return {
    child,
    result,
    stdout: () => buffers.stdout,
    stderr: () => buffers.stderr,
    waitFor: (stream, pattern) => new Promise<void>((resolvePromise) => { waiters.push({ stream, pattern, resolve: resolvePromise }); check(); }),
    write: (text) => { child.stdin.write(text); },
  };
}

void describe("plain chat: real SIGINT in a child process", () => {
  void it("cancels the in-flight request, prints the notice, stays alive, and a later /exit gives 0 with nothing saved", async () => {
    const reached = deferred();
    const closed = deferred();
    server.expect(tags(plain), (_request, _response, raw) => {
      raw.socket.once("close", () => { closed.resolve(); });
      reached.resolve();
    }, ollamaChat("after"));
    const chat = live([CLI, "--provider", "ollama", "--model", "m1"]);
    await chat.waitFor("stdout", /YOU > $/);
    chat.write("slow\n");
    await reached.promise;
    chat.child.kill("SIGINT");
    await chat.waitFor("stderr", /Request cancelled\.\n/);
    await closed.promise; // the connection was torn down
    await chat.waitFor("stdout", /YOU > [\s\S]*YOU > $/);
    chat.write("next\n");
    await chat.waitFor("stdout", /AI > after\n/);
    chat.write("/exit\n");
    chat.child.stdin?.end();
    const done = await chat.result;
    assert.equal(done.code, 0);
    assert.equal(done.signal, null);
    const bodies = server.requests.filter((r) => r.path === "/api/chat").map(ollamaBody);
    assert.deepEqual(messagesOf(bodies[1] ?? assert.fail("no second chat")), ["user: next"]); // the cancelled prompt did not leak
    const [name] = await readdir(conversations());
    assert.ok(name);
    assert.deepEqual(decodeConversation(await readFile(join(conversations(), name))).messages.map((m) => m.content), ["next", "after"]);
  });

  void it("Ctrl+C at the idle prompt exits 130 without a signal death", async () => {
    server.expect(tags(plain));
    const chat = live([CLI, "--provider", "ollama", "--model", "m1"]);
    await chat.waitFor("stdout", /YOU > $/);
    chat.child.kill("SIGINT");
    const done = await chat.result;
    assert.equal(done.code, 130);
    assert.equal(done.signal, null);
    assert.match(chat.stdout(), /\nGoodbye\.\n$/);
    await assert.rejects(stat(conversations()));
  });
});
