import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCliArgs } from "../src/args.js";
import type { ChatInvocation } from "../src/args.js";

function chat(argv: readonly string[]): ChatInvocation {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "chat") assert.fail(`expected chat for ${JSON.stringify(argv)}, got ${JSON.stringify(parsed)}`);
  return parsed.invocation;
}

function error(argv: readonly string[]): string {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "error") assert.fail(`expected an error for ${JSON.stringify(argv)}`);
  return parsed.message;
}

void describe("parseCliArgs: chat dispatch", () => {
  void it("no arguments, --plain and bare -- start the same plain chat", () => {
    const expected = { usage: false, noHistory: false };
    assert.deepEqual(chat([]), expected);
    assert.deepEqual(chat(["--plain"]), expected);
    assert.deepEqual(chat(["--"]), expected);
    assert.deepEqual(chat(["--plain", "--plain"]), expected); // idempotent
  });

  void it("tracks whether the provider was given explicitly", () => {
    assert.equal("provider" in chat([]), false);
    assert.equal("provider" in chat(["--model", "m"]), false); // a model alone is resolved to OpenAI later
    assert.equal(chat(["--provider", "openai"]).provider, "openai");
    assert.equal(chat(["--provider=ollama"]).provider, "ollama");
    assert.equal("provider" in chat(["--usage"]), false);
  });

  void it("carries every generation option and --no-history", () => {
    assert.deepEqual(
      chat(["--no-history", "--no-history", "--provider", "ollama", "--model", "q", "--reasoning-effort", "low", "--max-output-tokens", "9", "--answer-style", "brief", "--usage"]),
      { provider: "ollama", model: "q", reasoning: "low", maxOutputTokens: 9, answerStyle: "brief", usage: true, noHistory: true },
    );
  });

  void it("keeps strict parsing: repeated value options, boolean values, bad values, unknown options", () => {
    assert.match(error(["--model", "a", "--model", "b"]), /more than once/);
    assert.match(error(["--plain=yes"]), /does not take a value/);
    assert.match(error(["--no-history=1"]), /does not take a value/);
    assert.match(error(["--provider", "x"]), /invalid provider/);
    assert.match(error(["--max-output-tokens", "0"]), /positive whole number/);
    assert.match(error(["--bogus"]), /unknown option/);
    assert.match(error(["a", "b"]), /exactly one prompt/);
    assert.match(error(["--stream"]), /unsupported option "--stream"/);
    assert.match(error(["--transcript-on-exit"]), /unsupported option/);
  });

  void it("help and version conflict with chat switches; --help stays help", () => {
    assert.match(error(["--help", "--plain"]), /cannot be combined/);
    assert.match(error(["--version", "--no-history"]), /cannot be combined/);
    assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
    assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
  });

  void it("rejects --plain and --no-history with a positional prompt, and a prompt after -- stays a prompt", () => {
    assert.match(error(["--plain", "hello"]), /cannot be used with a prompt/);
    assert.match(error(["hello", "--no-history"]), /cannot be used with a prompt/);
    assert.equal(parseCliArgs(["--", "--plain"]).kind, "prompt");
    assert.match(error(["--plain", "  "]), /must not be empty/);
  });

  void it("one-shot prompts keep their exact parsed shape", () => {
    assert.deepEqual(parseCliArgs(["  spaced  "]), { kind: "prompt", invocation: { provider: "openai", usage: false, prompt: "  spaced  " } });
  });
});
