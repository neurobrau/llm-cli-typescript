import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCliArgs } from "../src/args.js";

function errorMessage(argv: readonly string[]): string {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "error") {
    assert.fail(`expected an error for ${JSON.stringify(argv)}`);
  }
  return parsed.message;
}

void describe("parseCliArgs", () => {
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

  void it("rejects unknown options", () => {
    assert.match(errorMessage(["--bogus"]), /unknown option "--bogus"/);
    assert.match(errorMessage(["-x"]), /unknown option "-x"/);
  });

  void it("rejects future options explicitly, with or without values", () => {
    for (const argv of [["--provider", "openai"], ["--provider=openai"], ["--stream"], ["--model=x"]]) {
      assert.match(errorMessage(argv), /unsupported option/);
    }
  });

  void it("rejects prompt text, including the empty string", () => {
    assert.match(errorMessage(["hello"]), /prompt mode is not implemented/);
    assert.match(errorMessage([""]), /prompt mode is not implemented/);
    assert.match(errorMessage(["-"]), /prompt mode is not implemented/);
  });

  void it("rejects extra positional arguments", () => {
    assert.match(errorMessage(["one", "two"]), /unsupported positional arguments/);
  });

  void it("rejects help or version combined with other arguments", () => {
    for (const argv of [["--help", "text"], ["--version", "--bogus"], ["-h", "--stream"], ["text", "--version"]]) {
      assert.match(errorMessage(argv), /invalid invocation/);
    }
  });

  void it("rejects values supplied to boolean flags", () => {
    assert.match(errorMessage(["--version=foo"]), /invalid argument/);
    assert.match(errorMessage(["--help="]), /invalid argument/);
  });

  void it("treats everything after -- as positional text", () => {
    assert.match(errorMessage(["--", "--version"]), /prompt mode is not implemented/);
    assert.match(errorMessage(["--", "--help", "x"]), /unsupported positional arguments/);
  });

  void it("keeps control characters out of diagnostics", () => {
    assert.ok(!errorMessage(["--bad\u001b[31m"]).includes("\u001b"));
  });
});
