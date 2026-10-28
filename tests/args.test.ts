import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCliArgs } from "../src/args.js";
import type { PromptInvocation } from "../src/args.js";

function errorMessage(argv: readonly string[]): string {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "error") {
    assert.fail(`expected an error for ${JSON.stringify(argv)}`);
  }
  return parsed.message;
}

function invocation(argv: readonly string[]): PromptInvocation {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "prompt") {
    assert.fail(`expected a prompt for ${JSON.stringify(argv)}, got ${JSON.stringify(parsed)}`);
  }
  return parsed.invocation;
}

void describe("parseCliArgs: help and version", () => {
  void it("shows help without arguments and for bare --", () => {
    assert.deepEqual(parseCliArgs([]), { kind: "help" });
    assert.deepEqual(parseCliArgs(["--"]), { kind: "help" });
  });

  void it("accepts --help, -h and --version", () => {
    assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
    assert.deepEqual(parseCliArgs(["-h"]), { kind: "help" });
    assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
  });

  void it("treats repeated identical switches as idempotent", () => {
    assert.deepEqual(parseCliArgs(["--help", "-h", "--help"]), { kind: "help" });
    assert.deepEqual(parseCliArgs(["--version", "--version"]), { kind: "version" });
  });

  void it("rejects conflicting help and version", () => {
    assert.match(errorMessage(["--help", "--version"]), /conflicting options/);
    assert.match(errorMessage(["--version", "-h"]), /conflicting options/);
  });

  void it("rejects help or version combined with any other argument", () => {
    const cases = [
      ["--help", "text"],
      ["--version", "--bogus"],
      ["-h", "--stream"],
      ["text", "--version"],
      ["--help", "--usage"],
      ["--version", "--model", "m"],
      ["-h", "--provider", "openai"],
    ];
    for (const argv of cases) {
      assert.match(errorMessage(argv), /invalid invocation/, JSON.stringify(argv));
    }
  });

  void it("rejects values supplied to boolean flags", () => {
    assert.match(errorMessage(["--version=foo"]), /invalid argument/);
    assert.match(errorMessage(["--help="]), /invalid argument/);
    assert.match(errorMessage(["--usage=yes", "p"]), /invalid argument/);
  });
});

void describe("parseCliArgs: unsupported and unknown options", () => {
  void it("rejects unknown options", () => {
    assert.match(errorMessage(["--bogus"]), /unknown option "--bogus"/);
    assert.match(errorMessage(["-x"]), /unknown option "-x"/);
  });

  void it("rejects future options explicitly, before looking at values", () => {
    for (const argv of [["--stream", "p"], ["--plain", "p"], ["--no-history", "p"], ["--transcript-on-exit", "p"]]) {
      assert.match(errorMessage(argv), /unsupported option/, JSON.stringify(argv));
    }
  });

  void it("keeps control characters out of diagnostics", () => {
    assert.ok(!errorMessage(["--bad\u001b[31m"]).includes("\u001b"));
  });
});

void describe("parseCliArgs: one-shot prompts", () => {
  void it("parses a prompt with defaults", () => {
    assert.deepEqual(invocation(["hello"]), { provider: "openai", usage: false, prompt: "hello" });
  });

  void it("parses every option, before or after the prompt", () => {
    const expected = {
      provider: "openai",
      model: "gpt-5",
      reasoning: "high",
      maxOutputTokens: 600,
      answerStyle: "brief",
      usage: true,
      prompt: "What?",
    };
    assert.deepEqual(
      invocation(["--provider", "openai", "--model", "gpt-5", "--reasoning-effort", "high", "--max-output-tokens", "600", "--answer-style", "brief", "--usage", "What?"]),
      expected,
    );
    assert.deepEqual(
      invocation(["What?", "--usage", "--answer-style=brief", "--max-output-tokens=600", "--reasoning-effort=high", "--model=gpt-5"]),
      expected,
    );
  });

  void it("accepts every effort and model-default, and nothing else", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "model-default"]) {
      assert.equal(invocation(["--reasoning-effort", effort, "p"]).reasoning, effort);
    }
    for (const effort of ["off", "on", "", "HIGH", "default"]) {
      assert.match(errorMessage(["--reasoning-effort", effort, "p"]), /invalid (reasoning effort|argument)/, effort);
    }
  });

  void it("accepts answer styles and rejects other spellings", () => {
    for (const style of ["brief", "normal", "detailed"]) {
      assert.equal(invocation(["--answer-style", style, "p"]).answerStyle, style);
    }
    assert.match(errorMessage(["--answer-style", "long", "p"]), /invalid answer style/);
  });

  void it("accepts only positive decimal safe-integer token counts", () => {
    assert.equal(invocation(["--max-output-tokens", "1", "p"]).maxOutputTokens, 1);
    assert.equal(invocation(["--max-output-tokens", "9007199254740991", "p"]).maxOutputTokens, 9007199254740991);
    for (const bad of ["0", "-5", "1.5", "1e3", "abc", "", " 5", "+5", "0x10", "9007199254740992", "99999999999999999999"]) {
      assert.match(errorMessage([`--max-output-tokens=${bad}`, "p"]), /invalid (max output tokens|argument)/, bad);
    }
  });

  void it("accepts the openai provider and rejects ollama and others before any work", () => {
    assert.equal(invocation(["--provider", "openai", "p"]).provider, "openai");
    assert.match(errorMessage(["--provider", "ollama", "p"]), /unsupported provider "ollama"/);
    assert.match(errorMessage(["--provider", "other", "p"]), /invalid provider/);
  });

  void it("rejects an empty model and options without a value", () => {
    assert.match(errorMessage(["--model=", "p"]), /invalid model/);
    assert.match(errorMessage(["p", "--model"]), /requires a value/);
    assert.match(errorMessage(["--model", "--usage", "p"]), /requires a value/);
  });

  void it("rejects repeated value options", () => {
    assert.match(errorMessage(["--model", "a", "--model", "b", "p"]), /more than once/);
  });

  void it("allows --usage to be repeated", () => {
    assert.equal(invocation(["--usage", "--usage", "p"]).usage, true);
  });

  void it("requires exactly one nonblank prompt, preserving its whitespace", () => {
    assert.match(errorMessage([""]), /prompt must not be empty/);
    assert.match(errorMessage(["  \n\t"]), /prompt must not be empty/);
    assert.match(errorMessage(["one", "two"]), /exactly one prompt/);
    assert.equal(invocation(["  keep  spaces\n"]).prompt, "  keep  spaces\n");
  });

  void it("requires a prompt when generation options are given", () => {
    for (const argv of [["--usage"], ["--model", "m"], ["--provider", "openai"], ["--answer-style", "brief"]]) {
      assert.match(errorMessage(argv), /prompt is required/, JSON.stringify(argv));
    }
  });

  void it("treats everything after -- as prompt text", () => {
    assert.equal(invocation(["--", "--version"]).prompt, "--version");
    assert.equal(invocation(["--usage", "--", "--help"]).prompt, "--help");
    assert.match(errorMessage(["--", "--help", "x"]), /exactly one prompt/);
  });
});
