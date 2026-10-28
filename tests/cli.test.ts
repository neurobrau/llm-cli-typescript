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

function runNode(args: readonly string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise<Result>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd,
      env: { ...childEnv, ...extraEnv },
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

function runCli(args: readonly string[], cwd = ROOT, extraEnv: NodeJS.ProcessEnv = {}): Promise<Result> {
  return runNode([CLI, ...args], cwd, extraEnv);
}

function packageVersion(): string {
  const data = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  return data.version;
}

void describe("built CLI (dist/cli.js)", () => {
  void it("reports the one package.json version, which the lockfile agrees with and which is not a dev version", async () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    const version = packageVersion();
    assert.equal(lock.version, version);
    assert.equal(lock.packages[""]?.version, version);
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal((await runCli(["--version"])).stdout, `NeuroBräu TypeScript CLI ${version}\n`);
    assert.ok(!(await runCli(["--help"])).stdout.includes("-dev"));
  });

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
      { args: [""], pattern: /prompt must not be empty/ },
      { args: ["a", "b"], pattern: /unsupported positional arguments/ },
      { args: ["--usage"], pattern: /prompt is required/ },
      { args: ["--provider", "other", "p"], pattern: /invalid provider "other"/ },
      { args: ["--help", "--version"], pattern: /conflicting options/ },
      { args: ["--version", "x"], pattern: /invalid invocation/ },
      { args: ["--version=foo"], pattern: /invalid argument/ },
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

  void it("treats arguments after -- as prompt text, not as a version request", async () => {
    // No key in the sanitized environment: the prompt reaches the provider and fails on the missing key.
    const result = await runCli(["--", "--version"]);
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /OPENAI_API_KEY is not set/);
  });

  void it("reports a missing or blank key (exit 3) without any network use", async () => {
    const result = await runCli(["hello"]);
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "neurobrau: error: OPENAI_API_KEY is not set. Export it in your environment and try again.\n");
    const blank = await runCli(["hello"], ROOT, { OPENAI_API_KEY: "  \t " });
    assert.equal(blank.code, 3);
  });

  void it("does not read credentials for help, version or invalid invocations", async () => {
    // A key that would be rejected loudly if used; none of these invocations may touch it.
    const env = { OPENAI_API_KEY: "sk-synthetic-not-used-000000" };
    for (const args of [[], ["--version"], ["--bogus"], ["--provider", "other", "p"], ["--usage"]]) {
      const result = await runCli(args, ROOT, env);
      assert.ok(!result.stdout.includes("sk-synthetic") && !result.stderr.includes("sk-synthetic"));
    }
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
