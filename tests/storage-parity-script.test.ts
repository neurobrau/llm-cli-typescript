import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { startNode } from "./helpers/spawn.js";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "storage-parity.mjs");

// A stand-in interpreter (no real Python): answers --version, and for `generate`/`check` either succeeds
// trivially or reports a problem for every file, so the orchestrator's exit paths run without the reference.
const FAKE = `
import { mkdirSync, readdirSync } from "node:fs";
const args = process.argv.slice(2).filter((arg) => arg !== "-B" && arg !== "-I");
if (args[0] === "--version") { console.log("Python 0.0-fake"); process.exit(0); }
if (args[1] === "generate") { mkdirSync(args[3], { recursive: true }); process.exit(0); }
const problems = {};
for (const name of readdirSync(args[3])) problems[name] = "synthetic failure";
console.log(JSON.stringify({ rewritten: {}, problems }));
`;

let scratch = "";
let tmp = "";
let source = "";
let fakePython = "";

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-parity-test-"));
  tmp = join(scratch, "tmp");
  source = join(scratch, "src");
  await mkdir(tmp);
  await mkdir(join(source, "neurobrau_cli"), { recursive: true });
  await writeFile(join(source, "neurobrau_cli", "storage.py"), "");
  await writeFile(join(scratch, "fake.mjs"), FAKE);
  fakePython = join(scratch, "fake-python");
  await writeFile(fakePython, `#!/bin/sh\nexec "${process.execPath}" "${join(scratch, "fake.mjs")}" "$@"\n`);
  await chmod(fakePython, 0o755);
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runScript(python: string) {
  const env = { PATH: process.env.PATH ?? "", TMPDIR: tmp, NEUROBRAU_PYTHON: python, NEUROBRAU_PYTHON_SRC: source };
  return startNode([SCRIPT], env).result;
}

async function leftovers(): Promise<string[]> {
  return (await readdir(tmp)).filter((name) => name.startsWith("neurobrau-parity-"));
}

void describe("scripts/storage-parity.mjs exit codes and cleanup", () => {
  void it("exits 3 (BLOCKED) for an unavailable interpreter and leaves no temporary directory", async () => {
    const done = await runScript(join(scratch, "no-such-python"));
    assert.equal(done.code, 3, done.stderr);
    assert.match(done.stderr, /BLOCKED/);
    assert.doesNotMatch(done.stdout, /PASS/);
    assert.deepEqual(await leftovers(), []);
  });

  void it("exits 3 (BLOCKED) for a missing reference and leaves no temporary directory", async () => {
    const env = { PATH: process.env.PATH ?? "", TMPDIR: tmp, NEUROBRAU_PYTHON_SRC: join(scratch, "absent") };
    const done = await startNode([SCRIPT], env).result;
    assert.equal(done.code, 3, done.stderr);
    assert.deepEqual(await leftovers(), []);
  });

  void it("exits 1 when a check fails and leaves no temporary directory", async () => {
    const done = await runScript(fakePython);
    assert.equal(done.code, 1, done.stderr);
    assert.match(done.stderr, /FAIL .*Python rejected the TS output/);
    assert.doesNotMatch(done.stdout, /PASS/);
    assert.deepEqual(await leftovers(), []);
  });
});
