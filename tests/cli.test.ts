import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "dist", "cli.js");
const TIMEOUT_MS = 15_000;

interface Result {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

let scratch = "";
let childEnv: NodeJS.ProcessEnv = {};

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-cli-test-"));
  // Allowlisted environment: no API keys, no real HOME or XDG directories.
  childEnv = {
    HOME: join(scratch, "home"),
    XDG_STATE_HOME: join(scratch, "state"),
    XDG_CONFIG_HOME: join(scratch, "config"),
  };
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function runNode(args: readonly string[], cwd: string): Promise<Result> {
  return new Promise<Result>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function runCli(args: readonly string[], cwd = ROOT): Promise<Result> {
  return runNode([CLI, ...args], cwd);
}

function packageVersion(): string {
  const data = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  return data.version;
}

void describe("built CLI (dist/cli.js)", () => {
  void it("is emitted at dist/cli.js, not dist/src/cli.js", () => {
    assert.ok(existsSync(CLI));
    assert.ok(!existsSync(join(ROOT, "dist", "src")));
  });

  void it("shows help for no arguments and for --help / -h", async () => {
    for (const args of [[], ["--help"], ["-h"]]) {
      const result = await runCli(args);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /^usage: neurobrau /);
    }
  });

  void it("prints the exact version from package.json", async () => {
    const result = await runCli(["--version"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `NeuroBräu TypeScript CLI ${packageVersion()}\n`);
  });

  void it("works by absolute path from another cwd", async () => {
    const version = await runCli(["--version"], scratch);
    assert.equal(version.code, 0);
    assert.equal(version.stdout, `NeuroBräu TypeScript CLI ${packageVersion()}\n`);
    const help = await runCli(["--help"], scratch);
    assert.equal(help.code, 0);
    assert.ok(help.stdout.includes(packageVersion()));
  });

  void it("rejects invalid invocations with exit 2 and empty stdout", async () => {
    const cases: readonly { args: readonly string[]; pattern: RegExp }[] = [
      { args: ["--bogus"], pattern: /unknown option "--bogus"/ },
      { args: ["hello"], pattern: /prompt mode is not implemented/ },
      { args: [""], pattern: /prompt mode is not implemented/ },
      { args: ["a", "b"], pattern: /unsupported positional arguments/ },
      { args: ["--help", "--version"], pattern: /conflicting options/ },
      { args: ["--version", "x"], pattern: /invalid invocation/ },
      { args: ["--version=foo"], pattern: /invalid argument/ },
      { args: ["--provider", "openai"], pattern: /unsupported option "--provider"/ },
      { args: ["--stream"], pattern: /unsupported option "--stream"/ },
    ];
    for (const { args, pattern } of cases) {
      const result = await runCli(args);
      assert.equal(result.code, 2, JSON.stringify(args));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, pattern);
      assert.match(result.stderr, /Try 'neurobrau --help' for usage\./);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    }
  });

  void it("treats arguments after -- as prompt text", async () => {
    const result = await runCli(["--", "--version"]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /prompt mode is not implemented/);
  });
});

void describe("module imports", () => {
  void it("have no output or process side effects", async () => {
    const urls = ["args", "help", "main", "version"].map((name) =>
      pathToFileURL(join(ROOT, "dist", `${name}.js`)).href,
    );
    const script = `
      const before = {
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
        exit: process.listenerCount("exit"),
      };
      for (const url of ${JSON.stringify(urls)}) await import(url);
      const after = {
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
        exit: process.listenerCount("exit"),
      };
      if (JSON.stringify(before) !== JSON.stringify(after)) process.exitCode = 3;
      if (process.exitCode === undefined && process.stdin.listenerCount("data") !== 0) process.exitCode = 4;
    `;
    const result = await runNode(["--input-type=module", "-e", script], scratch);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
