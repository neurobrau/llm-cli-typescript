import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { deferred } from "./helpers/deferred.js";
import { Loopback, completedBody, json } from "./helpers/loopback.js";
import { KEY, bodyOf } from "./helpers/openai.js";
import { startNode } from "./helpers/spawn.js";

const HARNESS = resolve(import.meta.dirname, "helpers", "harness.js");

let server: Loopback;
let scratch = "";
let env: NodeJS.ProcessEnv = {};

before(async () => {
  server = await Loopback.start();
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-oneshot-test-"));
  env = {
    HOME: join(scratch, "home"),
    XDG_STATE_HOME: join(scratch, "state"),
    XDG_CONFIG_HOME: join(scratch, "config"),
  };
});

after(async () => {
  await server.close();
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  server.requests.length = 0;
  server.unexpected.length = 0;
});

// The harness is the real run() + real SDK + real SIGINT wiring against the loopback server; no egress.
void describe("one-shot through the executable composition (loopback, synthetic key)", () => {
  void it("prints the answer, usage and exits 0", async () => {
    server.expect(json(200, completedBody("Hello there", { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } })));
    const { result } = startNode([HARNESS, server.url, "--usage", "--answer-style", "brief", "Say hi"], env);
    const done = await result;
    assert.equal(done.code, 0);
    assert.equal(done.stdout, "Hello there\n");
    assert.equal(done.stderr, "Token usage: input=3, output=4, total=7\n");
    assert.equal(server.requests.length, 1);
    const [sent] = server.requests;
    assert.ok(sent);
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
    const body = bodyOf(sent);
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.store, false);
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.deepEqual(body.input, [{ role: "user", content: "Say hi" }]);
    assert.match(String(body.instructions), /^Answer briefly/);
  });

  void it("exits 8 with the partial answer for an incomplete response", async () => {
    server.expect(json(200, completedBody("part", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })));
    const done = await startNode([HARNESS, server.url, "--max-output-tokens", "5", "go"], env).result;
    assert.equal(done.code, 8);
    assert.equal(done.stdout, "part\n");
    assert.equal(done.stderr, "neurobrau: warning: response incomplete: the max output token limit was reached.\n");
  });

  void it("exits 4 with the fixed authentication message", async () => {
    server.expect(json(401, { error: { message: `bad key ${KEY}` } }));
    const done = await startNode([HARNESS, server.url, "go"], env).result;
    assert.equal(done.code, 4);
    assert.equal(done.stdout, "");
    assert.equal(done.stderr, "neurobrau: error: OpenAI authentication failed. Check that OPENAI_API_KEY is valid.\n");
  });

  void it("exits 2 before any request for settings the table rules out", async () => {
    const done = await startNode([HARNESS, server.url, "--model", "gpt-4o", "--reasoning-effort", "high", "go"], env).result;
    assert.equal(done.code, 2);
    assert.match(done.stderr, /gpt-4o does not support reasoning/);
    assert.equal(server.requests.length, 0);
  });

  void it("cancels the in-flight request on SIGINT and exits 130 without output", async () => {
    const reached = deferred();
    const closed = deferred();
    server.expect((_request, _response, raw) => {
      raw.socket.once("close", () => {
        closed.resolve();
      });
      reached.resolve();
    });
    const { child, result } = startNode([HARNESS, server.url, "slow question"], env);
    await reached.promise;
    child.kill("SIGINT");
    const done = await result;
    assert.equal(done.code, 130);
    assert.equal(done.signal, null);
    assert.equal(done.stdout, "");
    assert.equal(done.stderr, "neurobrau: interrupted\n");
    await closed.promise; // the connection was torn down by the child
  });
});
