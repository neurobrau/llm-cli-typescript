import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Io } from "../src/main.js";
import { run } from "../src/main.js";
import { OpenAIProvider } from "../src/providers/openai/provider.js";
import { OllamaProvider } from "../src/providers/ollama/provider.js";
import { createOpenAiApi } from "../src/providers/openai/sdk.js";
import { deferred } from "./helpers/deferred.js";
import { Loopback, completedBody, json } from "./helpers/loopback.js";
import { KEY } from "./helpers/openai.js";
import { bodyOf, chat, paths, show, tag, tags, thinkingShowBody } from "./helpers/ollama.js";
import { startNode } from "./helpers/spawn.js";

const CLI = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");

let server: Loopback;
let scratch = "";
let env: NodeJS.ProcessEnv = {};

before(async () => {
  server = await Loopback.start();
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-ollama-cli-"));
  // Allowlisted environment: no keys, temporary HOME/XDG.
  env = {
    HOME: join(scratch, "home"),
    XDG_STATE_HOME: join(scratch, "state"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    OLLAMA_HOST: server.origin.replace("http://", ""),
  };
});
after(async () => {
  await server.close();
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  assert.equal(server.pending, 0, "previous test left unconsumed responders");
  server.requests.length = 0;
  server.unexpected.length = 0;
});

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    },
    out,
    err,
  };
}

const plain = tag("m1", { capabilities: ["completion"], details: { context_length: 4096 } });

void describe("one-shot with --provider ollama through dist/cli.js (loopback, OLLAMA_HOST)", () => {
  void it("uses the first local model, needs no OpenAI key, and prints the answer and usage", async () => {
    server.expect(tags(tag("cloudy:cloud"), plain, tag("z", { capabilities: ["completion"] })), chat("Hello", { prompt_eval_count: 2, eval_count: 3 }));
    const done = await startNode([CLI, "--provider", "ollama", "--usage", "--answer-style", "brief", "Say hi"], env).result;
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout, "Hello\n");
    assert.equal(done.stderr, "Token usage: input=2, output=3, total=5\n");
    assert.deepEqual(paths(server), ["GET /api/tags", "POST /api/chat"]);
    const body = bodyOf(server.requests[1] ?? assert.fail("no chat"));
    assert.equal(body.model, "m1");
    assert.equal(body.stream, false);
    assert.match(String((body.messages as { content: string }[])[0]?.content), /^Answer briefly/);
    assert.deepEqual((body.messages as unknown[]).at(-1), { role: "user", content: "Say hi" });
  });

  void it("sends think:false by default for off/on models and honors --model, effort and the output limit", async () => {
    server.expect(tags(plain, tag("q", { capabilities: ["completion", "thinking"], details: { context_length: 4096 } })), show(thinkingShowBody([false, true])), chat("ok"));
    const done = await startNode([CLI, "--provider", "ollama", "--model", "q", "--max-output-tokens", "50", "p"], env).result;
    assert.equal(done.code, 0, done.stderr);
    const body = bodyOf(server.requests[2] ?? assert.fail("no chat"));
    assert.equal(body.think, false);
    assert.deepEqual(body.options, { num_predict: 50 });
  });

  void it("exits 2 before chat for settings the model cannot take, and for limits above the context ceiling", async () => {
    server.expect(tags(plain));
    const effort = await startNode([CLI, "--provider", "ollama", "--reasoning-effort", "high", "p"], env).result;
    assert.equal(effort.code, 2);
    assert.match(effort.stderr, /m1 does not support reasoning/);
    server.expect(tags(plain));
    const limit = await startNode([CLI, "--provider", "ollama", "--max-output-tokens", "5000", "p"], env).result;
    assert.equal(limit.code, 2);
    assert.match(limit.stderr, /exceeds the limit of 4096 output tokens for m1/);
    assert.ok(!paths(server).includes("POST /api/chat"));
  });

  void it("exits 8 with the partial answer when the output limit is hit", async () => {
    server.expect(tags(plain), chat("part", { done_reason: "length" }));
    const done = await startNode([CLI, "--provider", "ollama", "p"], env).result;
    assert.equal(done.code, 8);
    assert.equal(done.stdout, "part\n");
    assert.equal(done.stderr, "neurobrau: warning: response incomplete: the max output token limit was reached.\n");
  });

  void it("exits 1 with the manual install hint for a missing model and never contacts a pull endpoint", async () => {
    server.expect(tags(plain), tags(plain));
    const done = await startNode([CLI, "--provider", "ollama", "--model", "qwen3.5:4b", "p"], env).result;
    assert.equal(done.code, 1);
    assert.equal(done.stdout, "");
    assert.equal(done.stderr, "neurobrau: error: Ollama model 'qwen3.5:4b' is not installed locally. Install it yourself with: ollama pull qwen3.5:4b\n");
    assert.deepEqual(paths(server), ["GET /api/tags", "GET /api/tags"]);
  });

  void it("exits 1 when only cloud or non-chat models exist, and refuses a cloud model before any request", async () => {
    server.expect(tags(tag("a:cloud"), tag("emb", { capabilities: ["embedding"] })));
    const none = await startNode([CLI, "--provider", "ollama", "p"], env).result;
    assert.equal(none.code, 1);
    assert.match(none.stderr, /No local Ollama models are installed/);
    server.requests.length = 0;
    const cloud = await startNode([CLI, "--provider", "ollama", "--model", "glm-4.7:cloud", "p"], env).result;
    assert.equal(cloud.code, 1);
    assert.match(cloud.stderr, /cloud model that runs on a remote service/);
    assert.equal(server.requests.length, 0);
  });

  void it("exits 7 when the server is not running", async () => {
    const dead = await Loopback.start();
    const host = dead.origin.replace("http://", "");
    await dead.close();
    const done = await startNode([CLI, "--provider", "ollama", "p"], { ...env, OLLAMA_HOST: host }).result;
    assert.equal(done.code, 7);
    assert.match(done.stderr, /^neurobrau: error: Could not connect to Ollama at http:\/\/127\.0\.0\.1:\d+\. Is the Ollama service running\?\n$/);
  });

  void it("cancels the in-flight chat on SIGINT with exit 130 and no output", async () => {
    const reached = deferred();
    const closed = deferred();
    server.expect(tags(plain), (_request, _response, raw) => {
      raw.socket.once("close", () => {
        closed.resolve();
      });
      reached.resolve();
    });
    const { child, result } = startNode([CLI, "--provider", "ollama", "slow"], env);
    await reached.promise;
    child.kill("SIGINT");
    const done = await result;
    assert.equal(done.code, 130);
    assert.equal(done.signal, null);
    assert.equal(done.stdout, "");
    assert.equal(done.stderr, "neurobrau: interrupted\n");
    await closed.promise;
  });

  void it("an invalid OLLAMA_HOST is a safe settings error (exit 2) with no request and no echo", async () => {
    for (const host of ["ftp://x", "http://user:hunter2@host", "host:99999", "http://h?q=hunter2"]) {
      const done = await startNode([CLI, "--provider", "ollama", "p"], { ...env, OLLAMA_HOST: host }).result;
      assert.equal(done.code, 2, host);
      assert.match(done.stderr, /^neurobrau: error: Invalid OLLAMA_HOST: .+\.\n$/);
      assert.ok(!done.stderr.includes("hunter2"));
    }
    assert.equal(server.requests.length, 0);
  });

  void it("OLLAMA_HOST is not read for help, version or invalid arguments, nor for OpenAI", async () => {
    const bad = { ...env, OLLAMA_HOST: "ftp://never-read" };
    for (const args of [[], ["--version"], ["--bogus"], ["--provider", "other", "p"]]) {
      const done = await startNode([CLI, ...args], bad).result;
      assert.ok(!done.stderr.includes("OLLAMA_HOST"), JSON.stringify(args));
    }
    // OpenAI without a key: the missing-key error (3), not the broken Ollama configuration (2).
    const openai = await startNode([CLI, "p"], bad).result;
    assert.equal(openai.code, 3);
    assert.match(openai.stderr, /OPENAI_API_KEY is not set/);
  });

  void it("OPENAI_API_KEY is irrelevant to Ollama and is never sent to it", async () => {
    server.expect(tags(plain), chat("fine"));
    const done = await startNode([CLI, "--provider", "ollama", "p"], { ...env, OPENAI_API_KEY: KEY }).result;
    assert.equal(done.code, 0, done.stderr);
    for (const sent of server.requests) {
      assert.equal(sent.headers.authorization, undefined);
      assert.ok(!sent.body.includes(KEY));
    }
  });

  void it("ignores hostile proxy variables, including NODE_USE_ENV_PROXY, for a loopback server", async () => {
    const proxy = await Loopback.start(); // would answer 599 and record anything routed to it
    try {
      server.expect(tags(plain), chat("direct"));
      const hostile = {
        ...env,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: proxy.origin,
        http_proxy: proxy.origin,
        HTTPS_PROXY: proxy.origin,
        https_proxy: proxy.origin,
        ALL_PROXY: proxy.origin,
        all_proxy: proxy.origin,
        NO_PROXY: "",
        no_proxy: "",
      };
      // Control: Node's own global agent really does honor these variables here.
      const control = await startNode(
        ["-e", `process.getBuiltinModule("node:http").get(${JSON.stringify(`${server.origin}/control`)}, (r) => r.resume()).on("error", () => {})`],
        hostile,
      ).result;
      assert.equal(control.code, 0);
      assert.ok(proxy.requests.length >= 1, "premise: the global agent routes through the proxy variables");
      proxy.requests.length = 0;
      server.requests.length = 0;

      const done = await startNode([CLI, "--provider", "ollama", "p"], hostile).result;
      assert.equal(done.code, 0, done.stderr);
      assert.equal(done.stdout, "direct\n");
      assert.equal(proxy.requests.length, 0, "no request may reach the proxy");
      assert.deepEqual(paths(server), ["GET /api/tags", "POST /api/chat"]);
    } finally {
      await proxy.close();
    }
  });
});

void describe("provider-factory separation (in-process)", () => {
  void it("Ollama works with an API-key getter that throws if touched", async () => {
    server.expect(tags(plain), chat("hi"));
    const captured = capture();
    const code = await run(["--provider", "ollama", "p"], captured.io, {
      createProvider: (id) =>
        id === "ollama"
          ? new OllamaProvider({ baseUrl: server.origin })
          : new OpenAIProvider({
              getApiKey: () => {
                throw new Error("OpenAI key must not be read");
              },
            }),
    });
    assert.equal(code, 0);
    assert.deepEqual(captured.out, ["hi\n"]);
  });

  void it("OpenAI works when the Ollama configuration reader would throw", async () => {
    server.expect(json(200, completedBody("from openai")));
    const captured = capture();
    const code = await run(["p"], captured.io, {
      createProvider: (id) => {
        if (id === "ollama") {
          throw new Error("Ollama configuration must not be read");
        }
        return new OpenAIProvider({
          getApiKey: () => KEY,
          createApi: (apiKey) => createOpenAiApi({ apiKey, baseURL: server.url }),
        });
      },
    });
    assert.equal(code, 0, captured.err.join(""));
    assert.deepEqual(captured.out, ["from openai\n"]);
  });

  void it("without a factory, Ollama is never reached", async () => {
    const captured = capture();
    const code = await run(["--provider", "ollama", "p"], captured.io);
    assert.equal(code, 1);
    assert.match(captured.err.join(""), /Ollama is not configured/);
    assert.equal(server.requests.length, 0);
  });

  void it("a SettingsError from the factory is exit 2", async () => {
    const { SettingsError } = await import("../src/domain/errors.js");
    const captured = capture();
    const code = await run(["--provider", "ollama", "p"], captured.io, {
      createProvider: () => {
        throw new SettingsError("Invalid OLLAMA_HOST: nope.");
      },
    });
    assert.equal(code, 2);
    assert.deepEqual(captured.err, ["neurobrau: error: Invalid OLLAMA_HOST: nope.\n"]);
  });
});
