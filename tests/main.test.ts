import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../src/main.js";
import type { Io } from "../src/main.js";
import { readPackageVersion } from "../src/version.js";

interface Captured {
  readonly io: Io;
  readonly out: string[];
  readonly err: string[];
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    },
  };
}

function epipe(): Error {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

void describe("run", () => {
  void it("prints help on stdout for --help and -h", async () => {
    for (const argv of [["--help"], ["-h"]]) {
      const { io, out, err } = capture();
      assert.equal(await run(argv, io), 0);
      assert.equal(err.length, 0);
      const text = out.join("");
      assert.match(text, /^usage: neurobrau /);
      assert.match(text, /--version/);
      assert.match(text, /Without a prompt, starts a line-oriented chat/);
    }
  });

  void it("prints the version derived from package.json", async () => {
    const { io, out, err } = capture();
    assert.equal(await run(["--version"], io), 0);
    assert.equal(out.join(""), `NeuroBräu TypeScript CLI ${readPackageVersion()}\n`);
    assert.equal(err.length, 0);
  });

  void it("reports invalid invocations on stderr with exit code 2", async () => {
    const cases: readonly (readonly string[])[] = [
      ["--bogus"],
      [""],
      ["   "],
      ["a", "b"],
      ["--plain", "p"],
      ["--stream", "p"],
      ["--provider", "other", "p"],
      ["--help", "--version"],
      ["--version", "x"],
      ["--version=foo"],
    ];
    for (const argv of cases) {
      const { io, out, err } = capture();
      assert.equal(await run(argv, io), 2, JSON.stringify(argv));
      assert.equal(out.length, 0);
      const text = err.join("");
      assert.match(text, /^neurobrau: error: /);
      assert.match(text, /Try 'neurobrau --help' for usage\.\n$/);
    }
  });

  void it("maps EPIPE on stdout to 141 without any diagnostic", async () => {
    const err: string[] = [];
    const code = await run(["--help"], {
      stdout: () => Promise.reject(epipe()),
      stderr: (text) => {
        err.push(text);
      },
    });
    assert.equal(code, 141);
    assert.equal(err.length, 0);
  });

  void it("maps EPIPE on stderr to 141", async () => {
    const code = await run(["--bogus"], {
      stdout: () => undefined,
      stderr: () => {
        throw epipe();
      },
    });
    assert.equal(code, 141);
  });

  void it("maps other output failures to 1 with a safe diagnostic", async () => {
    const err: string[] = [];
    const code = await run(["--version"], {
      stdout: () => Promise.reject(new Error("disk full")),
      stderr: (text) => {
        err.push(text);
      },
    });
    assert.equal(code, 1);
    assert.equal(err.join(""), "neurobrau: error: cannot write output\n");
  });

  void it("returns 1 when both streams fail", async () => {
    const code = await run(["--version"], {
      stdout: () => Promise.reject(new Error("a")),
      stderr: () => Promise.reject(new Error("b")),
    });
    assert.equal(code, 1);
  });
});
