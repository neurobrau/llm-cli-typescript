// Shared machinery of `npm run test:cross-parity`: bounded subprocesses,
// reference export, protocol validation and the comparison rules. Pure
// functions where possible so the default test suite can exercise them with
// stand-ins; nothing here touches a reference worktree.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

/** A missing prerequisite or a wrong reference: exit 3, never a pass. */
export class Blocked extends Error {}
/** A compatibility or protocol failure: exit 1. */
export class Failure extends Error {}

export const PINNED = Object.freeze({
  python: "0a6d045c022b850371a1c51a1df30f11d9d4c60e",
  go: "b064decc66cad7d9656488bdf7749650b52cf309",
});

const MAX_OUTPUT = 256 * 1024 * 1024;
/** Test seam: a tighter global deadline (milliseconds) so timeout paths run without slow waits. */
const DEADLINE_CAP = Number(process.env.NEUROBRAU_XPARITY_TIMEOUT_MS) > 0 ? Number(process.env.NEUROBRAU_XPARITY_TIMEOUT_MS) : Infinity;

/**
 * Runs a command with an argument array (never a shell), a deadline and a
 * bounded stdout/stderr capture. The child is killed on timeout or when the
 * bound is exceeded; the promise always settles after the child is gone.
 */
export function runBounded(file, args, options = {}) {
  const { env = {}, cwd, maxBytes = MAX_OUTPUT, input } = options;
  const timeoutMs = Math.min(options.timeoutMs ?? 120_000, DEADLINE_CAP);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (error) {
      resolve({ error, code: null, signal: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, truncated: false });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    let truncated = false;
    let spawnError;
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const take = (target) => (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        stop();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        error: spawnError,
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8").slice(-4000),
        timedOut,
        truncated,
      });
    });
    child.stdin.end(input);
  });
}

/** Safe, inheritable-key-free environment for oracle subprocesses. */
export function oracleEnv(scratch, extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(scratch, "home"),
    XDG_CONFIG_HOME: join(scratch, "home", "config"),
    XDG_STATE_HOME: join(scratch, "home", "state"),
    TMPDIR: scratch,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...extra,
  };
}

/** Throws a Failure naming the oracle when a bounded run did not end cleanly. */
export function expectClean(result, what) {
  if (result.error !== undefined) throw new Failure(`${what}: could not run (${result.error.message})`);
  if (result.timedOut) throw new Failure(`${what}: timed out`);
  if (result.truncated) throw new Failure(`${what}: output exceeded the bound`);
  if (result.code !== 0) throw new Failure(`${what}: exit ${String(result.code)}${result.stderr === "" ? "" : `: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`}`);
  return result.stdout.toString("utf8");
}

export function parseOracleJson(text, what) {
  if (text.trim() === "") throw new Failure(`${what}: empty output`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure(`${what}: output is not valid JSON`);
  }
}

// ----- references -----

const git = (repo, args, options = {}) =>
  runBounded("git", ["--no-optional-locks", "-C", repo, ...args], { env: { PATH: process.env.PATH ?? "", HOME: options.home ?? "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" }, timeoutMs: 60_000, ...options });

/** Worktree state as text; used before/after to prove the reference was not touched. */
export async function referenceState(repo) {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const status = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (head.code !== 0 || status.code !== 0) throw new Blocked(`${repo} is not a readable Git repository`);
  return { head: head.stdout.toString("utf8").trim(), status: status.stdout.toString("utf8") };
}

/**
 * Verifies that `commit` exists in `repo` and exports `paths` of that exact
 * commit into `dest` with `git archive | tar -x`. Nothing is written to the
 * repository; a missing commit is BLOCKED (never fetched).
 */
export async function exportCommit(repo, commit, dest, paths, scratch) {
  const exists = await git(repo, ["cat-file", "-e", `${commit}^{commit}`]);
  if (exists.code !== 0) throw new Blocked(`commit ${commit} is not available in ${repo}; fetch it in a clone of your own (this tool never downloads)`);
  const resolved = await git(repo, ["rev-parse", `${commit}^{commit}`]);
  if (resolved.stdout.toString("utf8").trim() !== commit) throw new Blocked(`${repo}: ${commit} does not resolve to itself (use the full 40-digit id)`);
  mkdirSync(dest, { recursive: true });
  const archive = await git(repo, ["archive", "--format=tar", commit, ...paths], { maxBytes: 512 * 1024 * 1024 });
  if (archive.code !== 0) throw new Blocked(`git archive failed for ${repo}@${commit}: ${archive.stderr.trim()}`);
  const untar = await runBounded("tar", ["-x", "-C", dest], { env: { PATH: process.env.PATH ?? "" }, input: archive.stdout, timeoutMs: 120_000 });
  if (untar.code !== 0) throw new Blocked(`could not extract ${repo}@${commit}: ${untar.stderr.trim()}`);
  void scratch;
}

// ----- protocol validation -----

/** Exactly-once id coverage in both directions; returns problem strings (empty = complete). */
export function coverageProblems(label, expectedIds, actualIds) {
  const problems = [];
  const expected = new Set(expectedIds);
  const counts = new Map();
  for (const id of actualIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of expected) {
    const n = counts.get(id) ?? 0;
    if (n === 0) problems.push(`${label}: missing result for ${JSON.stringify(id)}`);
    else if (n > 1) problems.push(`${label}: duplicate result for ${JSON.stringify(id)} (${String(n)}x)`);
  }
  for (const id of counts.keys()) if (!expected.has(id)) problems.push(`${label}: unexpected result ${JSON.stringify(id)}`);
  if (expected.size === 0) problems.push(`${label}: empty case set`);
  return problems;
}

// ----- exact numbers -----

/** "0.0060000" / "12" -> [numerator, denominator] BigInts (exact, reduced); throws on anything else. */
export function fractionFromDecimal(text) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) throw new Failure(`not a plain decimal amount: ${String(text)}`);
  const fraction = match[2] ?? "";
  return reduce(BigInt(match[1] + fraction), 10n ** BigInt(fraction.length));
}

export function fractionFromParts(num, den) {
  if (!/^\d+$/.test(num) || !/^[1-9]\d*$/.test(den)) throw new Failure(`bad rational ${String(num)}/${String(den)}`);
  return reduce(BigInt(num), BigInt(den));
}

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reduce(n, d) {
  const g = gcd(n, d) || 1n;
  return [n / g, d / g];
}

export const sameFraction = (a, b) => a[0] === b[0] && a[1] === b[1];
export const showFraction = (f) => `${f[0].toString()}/${f[1].toString()}`;

// ----- settings comparison -----

const TS_LENIENT = "; ignoring the command-line value.";
const REF_LENIENT = "; using the default.";
const LOOKUP_NOTICE = "Could not check reasoning support for m: ";

const normalizeSettings = (r) =>
  r.error ? { error: r.error } : { effective: r.effective, explicit: r.explicit, max: r.max, notices: [...(r.notices ?? [])] };

/**
 * Compares the three resolver results of one case. Each accepted difference is
 * a specific, checked rule (documented policy: docs/parity.md "Settings
 * resolution"); anything else is returned as a problem. `goWithoutCliMax` is
 * Go's result for the sibling case without the command-line max (used only
 * for the non-positive-max rule).
 */
export function compareSettings(item, py, go, ts, goWithoutCliMax) {
  const problems = [];
  const rules = [];
  const used = (name) => {
    if (!rules.includes(name)) rules.push(name);
  };
  const a = normalizeSettings(py);
  const b = normalizeSettings(go);
  const c = normalizeSettings(ts);

  // Capability lookup failure: Python and Go add a notice; the pure TS resolver never does (its caller adds it).
  if (item.support_error !== "") {
    for (const [name, r] of [["Python", a], ["Go", b]]) {
      if (r.notices === undefined) continue;
      const first = r.notices[0];
      if (first === undefined || first !== `${LOOKUP_NOTICE}${item.support_error}`) problems.push(`${item.id}: ${name} lacks the lookup notice (${String(first)})`);
      else {
        r.notices = r.notices.slice(1);
        used("ts-has-no-capability-lookup-notice");
      }
    }
  }
  // Lenient CLI reasoning fallback wording (the saved value is tried before the built-in default in TS).
  if (c.notices !== undefined && c.notices.some((n) => n.endsWith(TS_LENIENT))) {
    c.notices = c.notices.map((n) => (n.endsWith(TS_LENIENT) ? n.slice(0, -TS_LENIENT.length) + REF_LENIENT : n));
    used("ts-lenient-cli-reasoning-wording");
  }
  // Unconfirmed support is described differently (Go/Python: "does not support reasoning" for empty values).
  if (!item.support.known && c.notices !== undefined) {
    const mapped = c.notices.map((n) => n.replace(/ reasoning support is not confirmed/g, " does not support reasoning"));
    if (JSON.stringify(mapped) !== JSON.stringify(c.notices)) {
      c.notices = mapped;
      used("ts-unconfirmed-support-wording");
    }
  }
  // Python loses the explicit bit whenever an explicit choice sends nothing (the user-chosen model default,
  // or "none"/"off" on a model without reasoning); Go and TypeScript keep it.
  const defaultChoice = item.prefs.reasoning === "default" || item.overrides.reasoning === "model-default";
  const noReasoningChoice = item.support.known && item.support.values.length === 0 && ["none", "off"].includes(item.overrides.reasoning ?? "");
  if ((defaultChoice || noReasoningChoice) && a.explicit === false && b.explicit === true && c.explicit === true && a.effective === "") {
    a.explicit = true;
    used("python-drops-explicit-bit-when-nothing-is-sent");
  }
  // Go treats a non-positive CLI max as "not given"; Python and TS reject it like any invalid value.
  let goComparable = true;
  if (item.overrides.max !== null && item.overrides.max <= 0) {
    if (goWithoutCliMax === undefined || JSON.stringify(normalizeSettings(goWithoutCliMax)) !== JSON.stringify(b)) {
      problems.push(`${item.id}: Go's result differs from the same case without the CLI max`);
    }
    goComparable = false;
    used("go-ignores-non-positive-cli-max");
  }
  const same = (x, y, label) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) problems.push(`${item.id}: ${label} differ: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  };
  same(a, c, "Python/TypeScript");
  if (goComparable) {
    same(a, b, "Python/Go");
    same(b, c, "Go/TypeScript");
  }
  return { problems, rules };
}
