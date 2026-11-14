import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import { startNode } from "./helpers/spawn.js";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "cross-parity.mjs");
const url = (...parts: string[]): string => pathToFileURL(join(ROOT, ...parts)).href;

interface Lib {
  coverageProblems(label: string, expected: string[], actual: string[]): string[];
  fractionFromDecimal(text: string): [bigint, bigint];
  fractionFromParts(num: string, den: string): [bigint, bigint];
  runBounded(file: string, args: string[], options?: Record<string, unknown>): Promise<{ error?: Error; code: number | null; stdout: Buffer; timedOut: boolean; truncated: boolean }>;
  compareSettings(item: unknown, py: unknown, go: unknown, ts: unknown, sibling?: unknown): { problems: string[]; rules: string[] };
}
interface Gate {
  runSteps(steps: { name: string; command: string; args: string[] }[], options: { spawn: (command: string, args: string[]) => { status: number | null; error?: Error } }): { code: number; results: { name: string; code: number }[] };
}
interface Pricing {
  comparePricing(label: string, names: string[], money: string[], ts: unknown, ref: unknown, skip?: Set<string>): string[];
}
interface Storage {
  compareBytes(label: string, expected: Map<string, Buffer>, result: { rewritten: Map<string, Buffer>; problems: Map<string, string> }): string[];
}

let lib: Lib;
let gate: Gate;

before(async () => {
  lib = (await import(url("scripts", "xparity", "lib.mjs"))) as Lib;
  gate = (await import(url("scripts", "release-gate-lib.mjs"))) as Gate;
});

void describe("cross-parity protocol checks", () => {
  void it("requires every expected id exactly once and nothing else", () => {
    const ids = ["a", "b", "c"];
    assert.deepEqual(lib.coverageProblems("x", ids, ["c", "b", "a"]), []);
    assert.match(lib.coverageProblems("x", ids, ["a", "b"]).join(), /missing result for "c"/);
    assert.match(lib.coverageProblems("x", ids, ["a", "b", "c", "b"]).join(), /duplicate result for "b"/);
    assert.match(lib.coverageProblems("x", ids, ["a", "b", "c", "d"]).join(), /unexpected result "d"/);
    assert.match(lib.coverageProblems("x", [], []).join(), /empty case set/);
  });

  void it("compares exact rationals without floating point", () => {
    assert.deepEqual(lib.fractionFromDecimal("0.0060000"), lib.fractionFromDecimal("0.006"));
    assert.deepEqual(lib.fractionFromParts("6", "1000"), lib.fractionFromDecimal("0.006"));
    assert.notDeepEqual(lib.fractionFromDecimal("0.0021650000000001"), lib.fractionFromDecimal("0.002165"));
    assert.throws(() => lib.fractionFromDecimal("1e-3"), /not a plain decimal/);
    assert.throws(() => lib.fractionFromParts("1", "0"), /bad rational/);
    const huge = lib.fractionFromDecimal(`${(2n ** 80n).toString()}.5`);
    assert.equal(huge[1], 2n);
  });

  void it("accepts only the documented settings differences, each under its own condition", () => {
    const item = { id: "t", support: { known: true, values: ["low"], default: "", allows_default: true }, support_error: "", prefs: { reasoning: null, max_set: false, max: null }, overrides: { reasoning: null, max: null } };
    const ok = { effective: "", explicit: false, max: 0, notices: [] };
    assert.deepEqual(lib.compareSettings(item, ok, ok, ok).problems, []);
    // a genuine difference is reported
    assert.match(lib.compareSettings(item, ok, ok, { ...ok, max: 5 }).problems.join(), /Python\/TypeScript differ/);
    // the explicit-bit rule needs a model-default choice and the exact Python=false/Go=TS=true shape
    const kept = { ...ok, explicit: true };
    assert.ok(lib.compareSettings(item, ok, kept, kept).problems.length > 0, "no default choice: the explicit difference is a failure");
    const chosen = { ...item, prefs: { reasoning: "default", max_set: false, max: null } };
    const result = lib.compareSettings(chosen, ok, kept, kept);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.rules, ["python-drops-explicit-bit-when-nothing-is-sent"]);
    assert.ok(lib.compareSettings(chosen, kept, ok, kept).problems.length > 0, "the opposite direction is not accepted");
    // the lenient wording rule rewrites only the exact TypeScript suffix
    const refNotice = { ...ok, notices: ["m supports reasoning: Low; 'x' is not available; using the default."] };
    const tsNotice = { ...ok, notices: ["m supports reasoning: Low; 'x' is not available; ignoring the command-line value."] };
    assert.deepEqual(lib.compareSettings(item, refNotice, refNotice, tsNotice).problems, []);
    assert.ok(lib.compareSettings(item, refNotice, refNotice, { ...ok, notices: ["something else; ignoring the command-line value."] }).problems.length > 0);
    // a capability lookup notice must be present in both references and absent in TypeScript
    const failing = { ...item, support_error: "network is unreachable", support: { known: false, values: [], default: "", allows_default: true } };
    const withNotice = { ...ok, notices: ["Could not check reasoning support for m: network is unreachable"] };
    assert.deepEqual(lib.compareSettings(failing, withNotice, withNotice, ok).problems, []);
    assert.ok(lib.compareSettings(failing, ok, withNotice, ok).problems.length > 0);
    // Go ignoring a non-positive CLI max requires Go to equal the case without it
    const zero = { ...item, overrides: { reasoning: null, max: 0 } };
    const rejected = { ...ok, notices: ["Max output tokens must be a positive whole number, not 0. Using the default."] };
    assert.deepEqual(lib.compareSettings(zero, rejected, ok, rejected, ok).problems, []);
    assert.ok(lib.compareSettings(zero, rejected, ok, rejected, { ...ok, max: 9 }).problems.length > 0);
    assert.ok(lib.compareSettings(zero, rejected, ok, rejected).problems.length > 0);
  });

  void it("storage byte comparison reports corrupted, rejected and missing files", async () => {
    const storage = (await import(url("scripts", "xparity", "stage-storage.mjs"))) as Storage;
    const expected = new Map([["a.json", Buffer.from("x\n")], ["b.json", Buffer.from("y\n")]]);
    const good = { rewritten: new Map(expected), problems: new Map<string, string>() };
    assert.deepEqual(storage.compareBytes("t", expected, good), []);
    assert.match(storage.compareBytes("t", expected, { ...good, rewritten: new Map([["a.json", Buffer.from("x\n")], ["b.json", Buffer.from("y")]]) }).join(), /b\.json was rewritten with different bytes/);
    assert.match(storage.compareBytes("t", expected, { rewritten: new Map([["a.json", Buffer.from("x\n")]]), problems: new Map([["b.json", "bad"]]) }).join(), /b\.json was rejected \(bad\)/);
    assert.match(storage.compareBytes("t", expected, { rewritten: new Map([["a.json", Buffer.from("x\n")]]), problems: new Map() }).join(), /b\.json was rejected \(undefined\)/);
  });

  void it("pricing comparison catches altered amounts and every kind of missing or extra result", async () => {
    const stagePricing = (await import(url("scripts", "xparity", "stage-pricing.mjs"))) as Pricing;
    const cost = (amount: [bigint, bigint] | null, notes: string[] = []) => ({ status: amount === null ? "unavailable" : "estimated", amount, notes });
    const ref = {
      version: "2026-10-22",
      sources: ["s"],
      cases: [{ name: "c1", estimates: [cost([1n, 1000n])], total: cost([1n, 1000n]), short: "$0.001000", describe: "d" }, { name: "c2", estimates: [], total: null, short: "-", describe: "e" }],
      money: [{ amount: "0.5", text: "$0.5000" }, { amount: "1", text: "$1.0000" }],
    };
    const copy = <T>(value: T): T => ({ ...(value as object) }) as T;
    const ts = copy(ref);
    const names = ["c1", "c2"];
    const money = ["0.5", "1"];
    assert.deepEqual(stagePricing.comparePricing("x", names, money, ts, ref), []);
    const bumped = { ...ref, cases: [{ ...ref.cases[0], estimates: [cost([2n, 1000n])] }, ref.cases[1]] };
    assert.match(stagePricing.comparePricing("x", names, money, ts, bumped).join(), /c1\[0\]/);
    assert.match(stagePricing.comparePricing("x", names, money, ts, { ...ref, cases: ref.cases.slice(0, 1) }).join(), /missing result for "c2"/);
    assert.match(stagePricing.comparePricing("x", names, money, ts, { ...ref, money: ref.money.slice(0, 1) }).join(), /missing result for "1"/);
    assert.match(stagePricing.comparePricing("x", names, money, ts, { ...ref, money: [...ref.money, ref.money[0]] }).join(), /duplicate result for "0.5"/);
    assert.match(stagePricing.comparePricing("x", names, money, ts, { ...ref, cases: [...ref.cases, { ...ref.cases[0], name: "extra" }] }).join(), /unexpected result "extra"/);
    assert.match(stagePricing.comparePricing("x", names, money, ts, { ...ref, money: [{ amount: "0.5", text: "$0.50" }, ref.money[1]] }).join(), /money 0.5/);
    assert.match(stagePricing.comparePricing("x", [], money, ts, ref).join(), /empty case set/);
    // an out-of-domain case is skipped only when explicitly named
    assert.deepEqual(stagePricing.comparePricing("x", names, money, ts, { ...ref, cases: [{ name: "c1", estimates: [], total: null, short: "?", describe: "?" }, ref.cases[1]] }, new Set(["c1"])), []);
  });
});

void describe("bounded subprocesses", () => {
  void it("kills a child that outlives its deadline and settles", async () => {
    const done = await lib.runBounded(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { timeoutMs: 150, env: {} });
    assert.equal(done.timedOut, true);
    assert.notEqual(done.code, 0);
  });

  void it("stops a child that exceeds the output bound", async () => {
    const done = await lib.runBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(5_000_000)); setInterval(() => undefined, 1000)"], { maxBytes: 1000, timeoutMs: 20_000, env: {} });
    assert.equal(done.truncated, true);
  });

  void it("reports a missing executable and never interprets arguments through a shell", async () => {
    const missing = await lib.runBounded(join(tmpdir(), "no-such-binary-xyz"), [], { env: {} });
    assert.ok(missing.error !== undefined);
    const echoed = await lib.runBounded(process.execPath, ["-p", "process.argv[1]", "$(echo pwned); `x` | y"], { env: {} });
    assert.equal(echoed.stdout.toString("utf8").trim(), "$(echo pwned); `x` | y");
  });
});

void describe("release gate order and exit codes", () => {
  const steps = ["a", "b", "c", "d"].map((name) => ({ name, command: name, args: [] as string[] }));

  void it("runs every step in order and returns 0 when all pass", () => {
    const seen: string[] = [];
    const result = gate.runSteps(steps, { spawn: (command) => { seen.push(command); return { status: 0 }; } });
    assert.deepEqual(seen, ["a", "b", "c", "d"]);
    assert.equal(result.code, 0);
  });

  void it("stops at the first failure and keeps BLOCKED (3) as 3", () => {
    for (const code of [1, 3]) {
      const seen: string[] = [];
      const result = gate.runSteps(steps, { spawn: (command) => { seen.push(command); return { status: command === "b" ? code : 0 }; } });
      assert.deepEqual(seen, ["a", "b"], "later steps must not run");
      assert.equal(result.code, code);
    }
  });

  void it("treats a step that could not start or was killed as a failure", () => {
    assert.equal(gate.runSteps(steps, { spawn: () => ({ status: null }) }).code, 1);
    assert.equal(gate.runSteps(steps, { spawn: () => ({ status: 0, error: new Error("spawn") }) }).code, 1);
  });
});

// ----- the runner end to end, with stand-in interpreters and temporary Git repositories -----

let scratch = "";
let tmp = "";
let pythonRepo = "";
let goRepo = "";
let pythonCommit = "";
let goCommit = "";

function git(cwd: string, args: string[]): string {
  const done = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout.trim();
}

async function makeRepo(name: string, files: Record<string, string>): Promise<{ dir: string; commit: string }> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "synthetic"]);
  return { dir, commit: git(dir, ["rev-parse", "HEAD"]) };
}

/** A Python stand-in (answers --version; otherwise misbehaves in the given mode). */
async function fakePython(mode: string): Promise<string> {
  const script = join(scratch, `py-${mode}.mjs`);
  await writeFile(script, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2).filter((a) => a !== "-B" && a !== "-I");
if (args[0] === "--version") { console.log("Python 0.0-fake"); process.exit(0); }
const mode = ${JSON.stringify(mode)};
if (mode === "garbage") { console.log("not json"); process.exit(0); }
if (mode === "empty") { process.exit(0); }
if (mode === "crash") { console.error("boom"); process.exit(2); }
if (mode === "hang") { setInterval(() => undefined, 1000); }
if (mode === "touch") { writeFileSync(${JSON.stringify(join(pythonRepo, "stray.txt"))}, "oracle wrote here"); console.log("{}"); process.exit(0); }
if (mode === "missing-module") { console.error("ModuleNotFoundError: x"); process.exit(1); }
console.log("{}");
`);
  const wrapper = join(scratch, `python-${mode}`);
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

/** A Go stand-in: `go version`, `go env GOMODCACHE` and `go build -o <path>` (writing a misbehaving adapter). */
async function fakeGo(mode: string): Promise<string> {
  const adapter = join(scratch, `adapter-${mode}.mjs`);
  await writeFile(adapter, `
if (${JSON.stringify(mode)} === "crash") { console.error("go oracle failed"); process.exit(2); }
console.log("not json");
`);
  const script = join(scratch, `go-${mode}.mjs`);
  await writeFile(script, `
import { writeFileSync, chmodSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "version") { console.log("go version stand-in"); process.exit(0); }
if (args[0] === "env") { console.log("/nonexistent-modcache"); process.exit(0); }
if (args[0] === "build") {
  if (${JSON.stringify(mode)} === "no-modules") { console.error("go: module lookup disabled by GOPROXY=off"); process.exit(1); }
  if (${JSON.stringify(mode)} === "build-error") { console.error("cmd/xparity/main.go:1:1: syntax error"); process.exit(1); }
  const out = args[args.indexOf("-o") + 1];
  writeFileSync(out, "#!/bin/sh\\nexec '" + process.execPath + "' '" + ${JSON.stringify(adapter)} + "' \\"$@\\"\\n");
  chmodSync(out, 0o755);
  process.exit(0);
}
process.exit(9);
`);
  const wrapper = join(scratch, `go-${mode}`);
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-cross-test-"));
  tmp = join(scratch, "tmp");
  await mkdir(tmp);
  const py = await makeRepo("py-repo", { "src/neurobrau_cli/pricing.py": "# stand-in\n" });
  const go = await makeRepo("go-repo", { "go.mod": "module example.invalid/ref\n", "main.go": "package main\n" });
  [pythonRepo, pythonCommit, goRepo, goCommit] = [py.dir, py.commit, go.dir, go.commit];
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runner(extra: Record<string, string>, timeoutMs = 60_000) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    TMPDIR: tmp,
    NEUROBRAU_PYTHON_REPO: pythonRepo,
    NEUROBRAU_GO_REPO: goRepo,
    NEUROBRAU_XPARITY_TEST_COMMITS: "1",
    NEUROBRAU_PYTHON_COMMIT: pythonCommit,
    NEUROBRAU_GO_COMMIT: goCommit,
    NEUROBRAU_XPARITY_TIMEOUT_MS: "3000",
    ...extra,
  };
  return startNode([SCRIPT], env, timeoutMs).result;
}

async function leftovers(): Promise<string[]> {
  return (await readdir(tmp)).filter((name) => name.startsWith("neurobrau-cross-parity-"));
}

void describe("scripts/cross-parity.mjs exit codes and cleanup", () => {
  void it("BLOCKED (3), never a pass: missing interpreter, missing Go, missing repository", async () => {
    const python = await fakePython("garbage");
    const go = await fakeGo("garbage");
    const cases: [string, Record<string, string>, RegExp][] = [
      ["no Python", { NEUROBRAU_PYTHON: join(scratch, "absent-python"), NEUROBRAU_GO: go }, /Python interpreter .* cannot run/],
      ["no Go", { NEUROBRAU_PYTHON: python, NEUROBRAU_GO: join(scratch, "absent-go") }, /Go toolchain .* cannot run/],
      ["no Python repository", { NEUROBRAU_PYTHON: python, NEUROBRAU_GO: go, NEUROBRAU_PYTHON_REPO: join(scratch, "absent-repo") }, /Python reference repository not found/],
      ["no Go repository", { NEUROBRAU_PYTHON: python, NEUROBRAU_GO: go, NEUROBRAU_GO_REPO: join(scratch, "absent-repo") }, /Go reference repository not found/],
    ];
    for (const [name, env, pattern] of cases) {
      const done = await runner(env);
      assert.equal(done.code, 3, `${name}: ${done.stderr}`);
      assert.match(done.stderr, /BLOCKED/);
      assert.match(done.stderr, pattern, name);
      assert.doesNotMatch(done.stdout + done.stderr, /PASS cross-language/);
    }
    assert.deepEqual(await leftovers(), []);
  });

  void it("BLOCKED when a reference is not the pinned commit (a different or missing commit is never accepted)", async () => {
    const python = await fakePython("garbage");
    const go = await fakeGo("garbage");
    // without the test seam the pinned ids are required, and these repositories do not contain them
    const done = await runner({ NEUROBRAU_PYTHON: python, NEUROBRAU_GO: go, NEUROBRAU_XPARITY_TEST_COMMITS: "0" });
    assert.equal(done.code, 3, done.stderr);
    assert.match(done.stderr, /commit 0a6d045c022b850371a1c51a1df30f11d9d4c60e is not available/);
    // a commit that does not exist in the Go repository
    const missing = await runner({ NEUROBRAU_PYTHON: python, NEUROBRAU_GO: go, NEUROBRAU_GO_COMMIT: "1".repeat(40) });
    assert.equal(missing.code, 3, missing.stderr);
    assert.match(missing.stderr, /is not available in .*go-repo/);
    assert.deepEqual(await leftovers(), []);
  });

  void it("BLOCKED when the Go module cache lacks the reference's dependencies; a genuine build error is a failure", async () => {
    const python = await fakePython("garbage");
    const noModules = await runner({ NEUROBRAU_PYTHON: python, NEUROBRAU_GO: await fakeGo("no-modules") });
    assert.equal(noModules.code, 3, noModules.stderr);
    assert.match(noModules.stderr, /not in the local module cache/);
    const broken = await runner({ NEUROBRAU_PYTHON: python, NEUROBRAU_GO: await fakeGo("build-error") });
    assert.equal(broken.code, 1, broken.stderr);
    assert.match(broken.stderr, /does not build/);
    assert.deepEqual(await leftovers(), []);
  });

  void it("fails (1) on malformed, empty, crashing or hanging oracles, and never passes", async () => {
    const go = await fakeGo("garbage");
    for (const mode of ["garbage", "empty", "crash"]) {
      const done = await runner({ NEUROBRAU_PYTHON: await fakePython(mode), NEUROBRAU_GO: go });
      assert.equal(done.code, 1, `${mode}: ${done.stderr}`);
      assert.match(done.stderr, /FAIL (storage|settings|pricing|sessions)/, mode);
      assert.doesNotMatch(done.stdout + done.stderr, /PASS cross-language/);
    }
    const hung = await runner({ NEUROBRAU_PYTHON: await fakePython("hang"), NEUROBRAU_GO: go, NEUROBRAU_XPARITY_TIMEOUT_MS: "150" });
    assert.equal(hung.code, 1, hung.stderr);
    assert.match(hung.stderr, /timed out/);
    const crashingGo = await runner({ NEUROBRAU_PYTHON: await fakePython("garbage"), NEUROBRAU_GO: await fakeGo("crash") });
    assert.equal(crashingGo.code, 1, crashingGo.stderr);
    assert.deepEqual(await leftovers(), []);
  });

  void it("fails when an oracle modifies the reference worktree", async () => {
    const done = await runner({ NEUROBRAU_PYTHON: await fakePython("touch"), NEUROBRAU_GO: await fakeGo("garbage") });
    assert.equal(done.code, 1, done.stderr);
    assert.match(done.stderr, /python reference worktree changed/);
    assert.deepEqual(await leftovers(), []);
  });
});
