import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { decodeConversation } from "../src/storage/index.js";
import { live } from "./helpers/live.js";
import { Loopback, NDJSON, SSE, completedBody, liveStream, sseEvent } from "./helpers/loopback.js";
import { bodyOf as ollamaBody, tag, tags } from "./helpers/ollama.js";
import { bodyOf as openaiBody } from "./helpers/openai.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const HARNESS = resolve(import.meta.dirname, "helpers", "harness.js");
const plain = tag("m1", { capabilities: ["completion"], details: { context_length: 4096 } });

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
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-stream-exe-"));
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

const nd = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const piece = (content: string): string => nd({ model: "m1", message: { role: "assistant", content }, done: false });
const finish = (extra: Record<string, unknown> = {}): string => nd({ model: "m1", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", ...extra });
const delta = (text: string): string => sseEvent("response.output_text.delta", { delta: text });
const savedMessages = async (): Promise<string[]> => {
  const directory = join(state, "neurobrau", "conversations");
  const [name] = await readdir(directory);
  assert.ok(name);
  return decodeConversation(await readFile(join(directory, name))).messages.map((m) => m.content);
};

void describe("one-shot --stream through dist/cli.js (Ollama loopback)", () => {
  void it("prints the first delta on stdout while the server still holds the rest, then finishes with usage", async () => {
    const stream = liveStream(NDJSON);
    server.expect(tags(plain), stream.responder);
    const child = live([CLI, "--provider", "ollama", "--model", "m1", "--stream", "--usage", "hi"], env);
    const remote = await stream.opened();
    await remote.write(piece("Hel"));
    await child.waitFor("stdout", /^Hel$/); // visible before the terminal record exists
    await remote.write(piece("lo") + finish({ prompt_eval_count: 2, eval_count: 3, total_duration: 2_000_000_000 }));
    remote.end();
    const done = await child.result;
    assert.equal(done.code, 0, child.stderr());
    assert.equal(child.stdout(), "Hello\n");
    assert.equal(child.stderr(), "Token usage: input=2, output=3, total=5\nDuration: 2.00 s\n");
    const chatBody = ollamaBody(remote.request);
    assert.equal(chatBody.stream, true);
  });

  void it("Ctrl+C after a partial answer: stdout line ended, interrupted, 130, connection closed", async () => {
    const stream = liveStream(NDJSON);
    server.expect(tags(plain), stream.responder);
    const child = live([CLI, "--provider", "ollama", "--model", "m1", "--stream", "hi"], env);
    const remote = await stream.opened();
    await remote.write(piece("part"));
    await child.waitFor("stdout", /^part$/);
    child.child.kill("SIGINT");
    const done = await child.result;
    assert.equal(done.code, 130);
    assert.equal(done.signal, null);
    assert.equal(child.stdout(), "part\n");
    assert.equal(child.stderr(), "neurobrau: interrupted\n");
    await remote.closed;
  });

  void it("a broken stdout pipe exits 141 quietly and drops the connection", async () => {
    const stream = liveStream(NDJSON);
    server.expect(tags(plain), stream.responder);
    const child = live([CLI, "--provider", "ollama", "--model", "m1", "--stream", "hi"], env);
    const remote = await stream.opened();
    await remote.write(piece("first"));
    await child.waitFor("stdout", /first/);
    child.child.stdout?.destroy(); // the reader went away
    for (let i = 0; i < 200; i += 1) {
      const alive = await remote.write(piece("more")).then(() => true, () => false);
      if (!alive) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
      if (child.child.exitCode !== null) break;
    }
    const done = await child.result;
    assert.equal(done.code, 141);
    assert.equal(child.stderr(), "");
    await remote.closed;
  });

  void it("an unclosed connection before done is a connection failure (exit 7) after the shown text", async () => {
    const stream = liveStream(NDJSON);
    server.expect(tags(plain), stream.responder);
    const child = live([CLI, "--provider", "ollama", "--model", "m1", "--stream", "hi"], env);
    const remote = await stream.opened();
    await remote.write(piece("cut"));
    remote.end();
    const done = await child.result;
    assert.equal(done.code, 7);
    assert.equal(child.stdout(), "cut\n");
    assert.match(child.stderr(), /^neurobrau: error: Ollama stream ended before the response was complete\.\n$/);
  });
});

void describe("one-shot --stream through the harness (OpenAI SDK, loopback)", () => {
  void it("streams SSE deltas incrementally with a synthetic key and store:false", async () => {
    const stream = liveStream(SSE);
    server.expect(stream.responder);
    const child = live([HARNESS, server.url, "--stream", "--usage", "hi"], env);
    const remote = await stream.opened();
    await remote.write(delta("Hel"));
    await child.waitFor("stdout", /^Hel$/);
    await remote.write(delta("lo") + sseEvent("response.completed", { response: completedBody("Hello", { usage: { input_tokens: 4, output_tokens: 5 } }) }));
    remote.end();
    const done = await child.result;
    assert.equal(done.code, 0, child.stderr());
    assert.equal(child.stdout(), "Hello\n");
    assert.equal(child.stderr(), "Token usage: input=4, output=5\n");
    const body = openaiBody(remote.request);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
  });

  void it("Ctrl+C mid-stream exits 130 and closes the SSE connection", async () => {
    const stream = liveStream(SSE);
    server.expect(stream.responder);
    const child = live([HARNESS, server.url, "--stream", "hi"], env);
    const remote = await stream.opened();
    await remote.write(delta("part"));
    await child.waitFor("stdout", /^part$/);
    child.child.kill("SIGINT");
    const done = await child.result;
    assert.equal(done.code, 130);
    assert.equal(child.stdout(), "part\n");
    await remote.closed;
  });
});

void describe("plain chat --stream: real SIGINT in a child process", () => {
  void it("Ollama: cancels after a delta, closes the connection, and the same chat then completes a new request", async () => {
    const first = liveStream(NDJSON);
    const second = liveStream(NDJSON);
    server.expect(tags(plain), first.responder, second.responder);
    const chat = live([CLI, "--provider", "ollama", "--model", "m1", "--stream"], env);
    await chat.waitFor("stdout", /YOU > $/);
    chat.write("slow question\n");
    const one = await first.opened();
    await one.write(piece("partial"));
    await chat.waitFor("stdout", /AI > partial$/);
    chat.child.kill("SIGINT");
    await chat.waitFor("stderr", /Request cancelled\. The partial response was not saved\.\n/);
    await one.closed;
    await chat.waitFor("stdout", /AI > partial\nYOU > $/);
    chat.write("next question\n");
    const two = await second.opened();
    await two.write(piece("fresh ") + piece("answer") + finish({ prompt_eval_count: 1, eval_count: 2 }));
    two.end();
    await chat.waitFor("stdout", /AI > fresh answer\nYOU > $/);
    chat.write("/exit\n");
    chat.child.stdin?.end();
    const done = await chat.result;
    assert.equal(done.code, 0);
    assert.equal(done.signal, null);
    const bodies = server.requests.filter((r) => r.path === "/api/chat").map(ollamaBody);
    assert.deepEqual(bodies.map((b) => (b.messages as { content: string }[]).map((m) => m.content)), [["slow question"], ["next question"]]);
    assert.deepEqual(await savedMessages(), ["next question", "fresh answer"]);
  });

  void it("OpenAI: the same cancel-then-continue sequence over SSE", async () => {
    const first = liveStream(SSE);
    const second = liveStream(SSE);
    server.expect(first.responder, second.responder);
    const chat = live([HARNESS, server.url, "--stream"], env);
    await chat.waitFor("stdout", /YOU > $/);
    chat.write("slow question\n");
    const one = await first.opened();
    await one.write(delta("partial"));
    await chat.waitFor("stdout", /AI > partial$/);
    chat.child.kill("SIGINT");
    await chat.waitFor("stderr", /Request cancelled\. The partial response was not saved\.\n/);
    await one.closed;
    await chat.waitFor("stdout", /AI > partial\nYOU > $/);
    chat.write("next question\n");
    const two = await second.opened();
    await two.write(delta("fresh") + sseEvent("response.completed", { response: completedBody("fresh", { usage: { input_tokens: 7, output_tokens: 1 } }) }));
    two.end();
    await chat.waitFor("stdout", /AI > fresh\nYOU > $/);
    chat.write("/exit\n");
    chat.child.stdin?.end();
    const done = await chat.result;
    assert.equal(done.code, 0);
    const bodies = server.requests.map(openaiBody);
    assert.deepEqual(bodies.map((b) => (b.input as { content: string }[]).map((m) => m.content)), [["slow question"], ["next question"]]);
    assert.deepEqual(await savedMessages(), ["next question", "fresh"]);
    const directory = join(state, "neurobrau", "conversations");
    const [name] = await readdir(directory);
    assert.ok(name);
    const saved = decodeConversation(await readFile(join(directory, name)));
    assert.equal(saved.requests.length, 1);
    assert.deepEqual(saved.requests[0]?.usage, { inputTokens: 7n, outputTokens: 1n });
  });

  void it("Ctrl+C at the idle prompt of a streaming chat exits 130", async () => {
    server.expect(tags(plain));
    const chat = live([CLI, "--provider", "ollama", "--model", "m1", "--stream"], env);
    await chat.waitFor("stdout", /YOU > $/);
    chat.child.kill("SIGINT");
    const done = await chat.result;
    assert.equal(done.code, 130);
    assert.equal(done.signal, null);
  });

  void it("a streamed incomplete reply keeps no messages; piped lines are processed in order", async () => {
    server.expect(
      tags(plain),
      (_request, response) => {
        response.statusCode = 200;
        response.write(piece("par") + finish({ done_reason: "length", prompt_eval_count: 4, eval_count: 5 }));
        response.end();
      },
      (_request, response) => {
        response.statusCode = 200;
        response.write(piece("ok") + finish());
        response.end();
      },
    );
    const done = live([CLI, "--provider", "ollama", "--model", "m1", "--stream", "--usage"], env);
    done.write("one\ntwo\n/exit\n");
    done.child.stdin?.end();
    const result = await done.result;
    assert.equal(result.code, 0);
    assert.match(done.stdout(), /YOU > AI > par\nYOU > AI > ok\nYOU > Goodbye\.\n$/);
    assert.match(done.stderr(), /warning: Response incomplete: the max output token limit was reached\. The partial response was not saved\.\nToken usage: input=4, output=5, total=9\n/);
    assert.deepEqual(await savedMessages(), ["two", "ok"]);
  });
});
