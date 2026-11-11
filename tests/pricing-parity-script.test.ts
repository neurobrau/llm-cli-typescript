import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import { settingsPanelRows } from "../src/tui/panel.js";
import type { PanelStats } from "../src/tui/panel.js";
import type { ResolvedSettings } from "../src/domain/settings.js";
import { startNode } from "./helpers/spawn.js";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "pricing-parity.mjs");
const LIB = pathToFileURL(join(ROOT, "scripts", "pricing-parity-lib.mjs")).href;
const PRICING = pathToFileURL(join(ROOT, "dist", "pricing", "index.js")).href;
const MONEY = pathToFileURL(join(ROOT, "dist", "pricing", "money.js")).href;
const CASES = pathToFileURL(join(ROOT, "scripts", "pricing-cases.mjs")).href;

// Stand-in interpreters (no real Python): `--version` answers; the helper call prints the TypeScript
// results (optionally corrupted), or fails like a missing dependency. This exercises the exit paths
// and cleanup without the reference; the real Python run is `npm run test:pricing-parity`.
const fake = (mode: string): string => `
import { computeTs, corrupt } from ${JSON.stringify(LIB)};
import * as pricing from ${JSON.stringify(PRICING)};
import { USD_DENOMINATOR } from ${JSON.stringify(MONEY)};
import { CASES, MONEY } from ${JSON.stringify(CASES)};
const args = process.argv.slice(2).filter((arg) => arg !== "-B" && arg !== "-I");
if (args[0] === "--version") { console.log("Python 0.0-fake"); process.exit(0); }
const mode = ${JSON.stringify(mode)};
if (mode === "missing-module") { console.error("ModuleNotFoundError: No module named 'httpx'"); process.exit(1); }
if (mode === "crash") { console.error("boom"); process.exit(2); }
if (mode === "garbage") { console.log("not json"); process.exit(0); }
const result = computeTs(pricing, USD_DENOMINATOR, CASES, MONEY);
console.log(JSON.stringify(mode === "mismatch" ? corrupt(result) : mode === "version" ? { ...result, version: "2000-01-01" } : result));
`;

let scratch = "";
let tmp = "";
let source = "";

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "neurobrau-pricing-parity-test-"));
  tmp = join(scratch, "tmp");
  source = join(scratch, "src");
  await mkdir(tmp);
  await mkdir(join(source, "neurobrau_cli"), { recursive: true });
  await writeFile(join(source, "neurobrau_cli", "pricing.py"), "");
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function stand(mode: string): Promise<string> {
  const script = join(scratch, `${mode}.mjs`);
  await writeFile(script, fake(mode));
  const wrapper = join(scratch, `python-${mode}`);
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function runScript(python: string, src = source) {
  const env = { PATH: process.env.PATH ?? "", TMPDIR: tmp, NEUROBRAU_PYTHON: python, NEUROBRAU_PYTHON_SRC: src };
  return startNode([SCRIPT], env, 60_000).result;
}

async function leftovers(): Promise<string[]> {
  return (await readdir(tmp)).filter((name) => name.startsWith("neurobrau-pricing-parity-"));
}

void describe("scripts/pricing-parity.mjs exit codes and cleanup", () => {
  void it("exits 0 when the (stand-in) reference agrees, after the negative control, and cleans up", async () => {
    const done = await runScript(await stand("match"));
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /PASS pricing parity: \d+ cases/);
    assert.match(done.stdout, /negative control detected/);
    assert.deepEqual(await leftovers(), []);
  });

  void it("exits 1 on a deliberate mismatch or a catalog version difference, and cleans up", async () => {
    for (const mode of ["mismatch", "version", "crash", "garbage"]) {
      const done = await runScript(await stand(mode));
      assert.equal(done.code, 1, `${mode}: ${done.stderr}`);
      assert.doesNotMatch(done.stdout, /PASS/);
      assert.deepEqual(await leftovers(), [], mode);
    }
    const mismatch = await runScript(await stand("mismatch"));
    assert.match(mismatch.stderr, /FAIL .*TS .* vs Python/);
  });

  void it("exits 3 (BLOCKED, not passed) for a missing interpreter, reference or reference dependency", async () => {
    const results = [
      await runScript(join(scratch, "no-such-python")),
      await runScript(await stand("match"), join(scratch, "absent")),
      await runScript(await stand("missing-module")),
    ];
    for (const done of results) {
      assert.equal(done.code, 3, done.stderr);
      assert.match(done.stderr, /BLOCKED/);
      assert.doesNotMatch(done.stdout, /PASS/);
    }
    assert.deepEqual(await leftovers(), []);
  });
});

interface Lib {
  computeTs(pricing: unknown, denominator: bigint, cases: unknown, money: unknown): Record<string, unknown>;
  compare(ts: unknown, py: unknown): string[];
  corrupt(result: unknown): unknown;
}

void describe("pricing parity comparison", () => {
  void it("negative control: any changed expectation (amount, note, text, money) is detected", async () => {
    const lib = (await import(LIB)) as Lib;
    const pricing: unknown = await import(PRICING);
    const money = (await import(MONEY)) as { USD_DENOMINATOR: bigint };
    const cases = ((await import(CASES)) as { CASES: unknown; MONEY: unknown });
    const ts = lib.computeTs(pricing, money.USD_DENOMINATOR, cases.CASES, cases.MONEY);
    assert.deepEqual(lib.compare(ts, structuredClone(ts)), []);
    assert.ok(lib.compare(ts, lib.corrupt(ts)).length > 0);
    const edits: ((copy: { cases: Record<string, { estimates: { notes: string[] }[]; short: string; describe: string; total: { status: string } | null }>; money: Record<string, string> }) => void)[] = [
      (copy) => { copy.cases["standard example"]?.estimates[0]?.notes.push("x"); },
      (copy) => { const entry = copy.cases["standard example"]; if (entry !== undefined) entry.short = "$0.002166"; },
      (copy) => { const entry = copy.cases["standard example"]; if (entry !== undefined) entry.describe += " "; },
      (copy) => { const entry = copy.cases["partial unknown model"]; if (entry?.total) entry.total.status = "estimated"; },
      (copy) => { copy.money["0.0099995"] = "$0.009999"; },
    ];
    for (const [index, edit] of edits.entries()) {
      const copy = structuredClone(ts) as Parameters<(typeof edits)[number]>[0];
      edit(copy);
      assert.ok(lib.compare(ts, copy).length > 0, `edit ${String(index)} must be detected`);
    }
  });
});

void describe("settings panel cost row", () => {
  const settings: ResolvedSettings = {
    provider: "openai",
    model: "gpt-6-luna",
    reasoning: { explicit: false, source: "builtin" },
    maxOutputTokens: { explicit: false, source: "builtin" },
    answerStyle: { value: "normal", source: "builtin" },
  };
  const stats = (cost: string): PanelStats => ({ input: 1n, output: 1n, total: 2n, cached: undefined, reasoning: undefined, context: 1n, cost, any: true });

  void it("shows the precomputed text unchanged (frames never reprice) and clips long amounts", () => {
    const rows = settingsPanelRows(settings, stats("~$0.5000")).map((row) => row.text);
    assert.deepEqual(rows.slice(-2), ["COST (EST.)", " ~$0.5000"]);
    const huge = settingsPanelRows(settings, stats(`>=$${"9".repeat(60)}.0000`)).map((row) => row.text);
    assert.ok(huge.every((row) => Array.from(row).length <= 18));
    assert.ok(huge.at(-1)?.startsWith(" >=$999"));
  });
});
