// Optional development check (`npm run test:pricing-parity`): the TypeScript
// pricing module against the real, read-only pinned Python pricing functions
// (neurobrau_cli.pricing) over the shared deterministic case list
// (scripts/pricing-cases.mjs): per-record status/amount/notes, aggregate
// status/amount/notes and the money/short/long formatting. Not part of
// `npm run check`; it does not cover the Go implementation (Task 011).
//
// Environment: NEUROBRAU_PYTHON_SRC (default ../llm-cli-python/src) and
// NEUROBRAU_PYTHON (default python3). Exit codes: 0 passed, 1 failed, 3 BLOCKED
// (reference or interpreter unavailable; nothing was checked). The temporary
// directory is removed in `finally`; the status is only recorded in
// process.exitCode, never forced with process.exit().
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CASES, MONEY } from "./pricing-cases.mjs";
import { compare, computeTs, corrupt } from "./pricing-parity-lib.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PYTHON = process.env.NEUROBRAU_PYTHON ?? "python3";
const PYTHON_SRC = resolve(process.env.NEUROBRAU_PYTHON_SRC ?? join(ROOT, "..", "llm-cli-python", "src"));
const HELPER = join(ROOT, "scripts", "python_pricing_parity.py");
const TIMEOUT_MS = 60_000;

class Blocked extends Error {}

if (!existsSync(join(PYTHON_SRC, "neurobrau_cli", "pricing.py"))) {
  console.error(`BLOCKED (not passed, nothing was checked): Python reference sources not found at ${PYTHON_SRC} (set NEUROBRAU_PYTHON_SRC)`);
  process.exitCode = 3;
} else {
  const scratch = mkdtempSync(join(tmpdir(), "neurobrau-pricing-parity-"));
  try {
    await main(scratch);
  } catch (error) {
    if (error instanceof Blocked) {
      console.error(`BLOCKED (not passed, nothing was checked): ${error.message}`);
      process.exitCode = 3;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(scratch) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(scratch, "home"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  const python = (args) =>
    spawnSync(PYTHON, ["-B", "-I", ...args], { env, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

  const version = python(["--version"]);
  if (version.error || version.status !== 0) {
    throw new Blocked(`interpreter "${PYTHON}" cannot run (${version.error?.message ?? `exit ${String(version.status)}`}); set NEUROBRAU_PYTHON`);
  }
  console.log(`interpreter: ${(version.stdout || version.stderr).trim()}; reference: ${PYTHON_SRC}`);

  let pricing;
  let money;
  try {
    pricing = await import(pathToFileURL(join(ROOT, "dist", "pricing", "index.js")).href);
    money = await import(pathToFileURL(join(ROOT, "dist", "pricing", "money.js")).href);
  } catch {
    throw new Blocked("dist/pricing is missing; run via `npm run test:pricing-parity` (it builds first)");
  }

  const casesFile = join(scratch, "cases.json");
  writeFileSync(casesFile, JSON.stringify({ cases: CASES, money: MONEY }));
  const ran = python([HELPER, PYTHON_SRC, casesFile]);
  if (ran.error || ran.status !== 0) {
    const missing = /ModuleNotFoundError|ImportError/.test(ran.stderr ?? "");
    if (missing) throw new Blocked(`the reference's Python dependencies are missing: ${(ran.stderr ?? "").trim().split("\n").pop()}`);
    console.error(ran.stderr);
    throw new Error(`Python helper failed (exit ${String(ran.status)})`);
  }
  let reference;
  try {
    reference = JSON.parse(ran.stdout);
  } catch {
    throw new Error("Python helper printed invalid JSON");
  }

  const ts = computeTs(pricing, money.USD_DENOMINATOR, CASES, MONEY);
  const problems = compare(ts, reference);
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 40)) console.error(`FAIL ${problem}`);
    throw new Error(`${String(problems.length)} difference(s) between TypeScript and Python pricing`);
  }

  // Negative control: a changed expected result must be detected.
  if (compare(ts, corrupt(reference)).length === 0) {
    throw new Error("negative control failed: a corrupted Python result was not detected");
  }
  const records = CASES.reduce((sum, item) => sum + item.records.length, 0);
  console.log(`PASS pricing parity: ${String(CASES.length)} cases, ${String(records)} records, ${String(MONEY.length)} money fixtures identical to the real Python functions; negative control detected a corrupted expectation (catalog ${reference.version})`);
}
