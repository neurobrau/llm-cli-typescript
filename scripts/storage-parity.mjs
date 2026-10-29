// Optional development check (`npm run test:parity`): the TypeScript storage
// codecs against the real, read-only Python serializers/validators, on
// synthetic data in temporary directories. Not part of `npm run check`.
//
//   Python -> TS : files written by the Python writers decode in TS and the TS
//                  encoder reproduces them byte for byte.
//   TS -> Python : canonical files written by the TS encoder load in Python,
//                  and Python's own writer reproduces the same bytes.
//
// Configuration (environment): NEUROBRAU_PYTHON_SRC (the Python repository's
// `src` directory; default ../llm-cli-python/src) and NEUROBRAU_PYTHON (the
// interpreter; default python3). Exit codes: 0 all checks passed, 1 a check
// failed, 3 BLOCKED (reference or interpreter unavailable; nothing was checked).
// The temporary directory is always removed before the process ends: the exit
// status is only recorded (process.exitCode), never forced with process.exit().
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const PYTHON = process.env.NEUROBRAU_PYTHON ?? "python3";
const PYTHON_SRC = resolve(process.env.NEUROBRAU_PYTHON_SRC ?? join(ROOT, "..", "llm-cli-python", "src"));
const HELPER = join(ROOT, "scripts", "python_storage_parity.py");
const TIMEOUT_MS = 30_000;

class Blocked extends Error {}

function blocked(reason) {
  throw new Blocked(reason);
}

if (!existsSync(join(PYTHON_SRC, "neurobrau_cli", "storage.py"))) {
  console.error(`BLOCKED (not passed, nothing was checked): Python reference sources not found at ${PYTHON_SRC} (set NEUROBRAU_PYTHON_SRC)`);
  process.exit(3); // nothing to clean up yet
}
const scratch = mkdtempSync(join(tmpdir(), "neurobrau-parity-"));
const pythonEnv = {
  PATH: process.env.PATH ?? "",
  HOME: join(scratch, "home"),
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
};

function python(args) {
  return spawnSync(PYTHON, ["-B", "-I", ...args], {
    env: pythonEnv,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  await main();
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

async function main() {
  const version = python(["--version"]);
  if (version.error || version.status !== 0) {
    blocked(`interpreter "${PYTHON}" cannot run (${version.error?.message ?? `exit ${String(version.status)}`}); set NEUROBRAU_PYTHON`);
  }
  console.log(`interpreter: ${(version.stdout || version.stderr).trim()}; reference: ${PYTHON_SRC}`);

  const codecs = await import(pathToFileURL(join(ROOT, "dist", "storage", "index.js")).href).catch(() => {
    blocked("dist/storage is missing; run via `npm run test:parity` (it builds first)");
  });

  const roundTrip = (name, bytes) => {
    if (name.startsWith("conversation")) return codecs.encodeConversation(codecs.decodeConversation(bytes));
    if (name.startsWith("settings")) return codecs.encodeSettings(codecs.decodeSettings(bytes).settings);
    return codecs.encodeActiveSelection(codecs.decodeActiveSelection(bytes));
  };

  // 1. Files written by Python.
  const generated = join(scratch, "python-written");
  const made = python([HELPER, "generate", PYTHON_SRC, generated]);
  if (made.status !== 0) {
    console.error(made.stderr);
    throw new Error(`Python generate failed (exit ${String(made.status)})`);
  }
  const sources = [
    ["python-generated", generated],
    ["python fixtures", join(ROOT, "tests", "fixtures", "storage", "python")],
    ["ts fixtures", join(ROOT, "tests", "fixtures", "storage", "ts")],
  ];
  const failures = [];
  let checked = 0;
  const tsWritten = join(scratch, "ts-written");
  mkdirSync(tsWritten);
  for (const [label, dir] of sources) {
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
      const bytes = readFileSync(join(dir, name));
      const key = `${label}/${name}`;
      let encoded;
      try {
        encoded = roundTrip(name, bytes);
      } catch (error) {
        failures.push(`${key}: TS rejected a canonical file (${error.message})`);
        continue;
      }
      if (Buffer.compare(Buffer.from(encoded), bytes) !== 0) {
        failures.push(`${key}: TS output differs from the original bytes`);
      }
      writeFileSync(join(tsWritten, `${label.replace(/\W+/g, "-")}__${name}`), encoded);
      checked += 1;
    }
  }

  // 1b. Files produced by real TS chat sessions (fake provider, temporary state), and a
  //     Python-written conversation continued by a TS session. They join the TS -> Python check below.
  const liveConversation = join(generated, "conversation_py_big_counts.json");
  const pythonConversation = existsSync(liveConversation) ? liveConversation : join(ROOT, "tests", "fixtures", "storage", "python", "conversation_ollama_unicode.json");
  const { sessionFiles, sessionFailures } = await sessionChecks(codecs, pythonConversation);
  failures.push(...sessionFailures);
  for (const [name, bytes] of sessionFiles) {
    writeFileSync(join(tsWritten, `ts-session__${name}`), bytes);
    checked += 1;
  }

  // 2. TS-encoded bytes through the Python readers and writers.
  const names = readdirSync(tsWritten).sort();
  const forPython = join(scratch, "for-python");
  mkdirSync(forPython);
  // Python dispatches on the file-name prefix, so strip the label prefix again.
  const pythonNames = new Map();
  for (const name of names) {
    const original = name.replace(/^.*?__/, "");
    const unique = `${original.replace(/\.json$/, "")}.${String(pythonNames.size)}.json`;
    pythonNames.set(unique, name);
    writeFileSync(join(forPython, unique), readFileSync(join(tsWritten, name)));
  }
  const rewritten = python([HELPER, "check", PYTHON_SRC, forPython]);
  if (rewritten.status !== 0) {
    console.error(rewritten.stderr);
    throw new Error(`Python check failed (exit ${String(rewritten.status)})`);
  }
  const { rewritten: texts, problems } = JSON.parse(rewritten.stdout);
  for (const [unique, name] of pythonNames) {
    if (problems[unique] !== undefined) {
      failures.push(`${name}: Python rejected the TS output (${problems[unique]})`);
    } else if (texts[unique] !== readFileSync(join(tsWritten, name), "utf8")) {
      failures.push(`${name}: Python rewrote the TS output differently`);
    }
  }

  console.log(`checked ${String(checked)} files in both directions (Python -> TS -> Python, TS -> Python -> TS)`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS: byte-identical in every checked direction");
}

// ----- chat sessions -----

function fakeProvider(id, answers) {
  const seen = [];
  return {
    id,
    label: id,
    seen,
    async generate(request) {
      seen.push(request.messages.map((message) => `${message.role}:${message.content}`));
      return answers[seen.length - 1] ?? { kind: "completed", result: { text: `answer ${String(seen.length)}` } };
    },
    stream() {
      throw new Error("streaming is not part of this check");
    },
    async listModels() {
      return [];
    },
    async checkAvailability() {
      return { available: true, message: "" };
    },
    async defaultModel() {
      return "m";
    },
    async getCapabilities() {
      return { reasoning: { known: false, values: [], allowsModelDefault: true } };
    },
  };
}

async function runSession(main, root, argv, lines, provider) {
  const queue = [...lines];
  let ticks = 0;
  const code = await main.run(argv, { stdout: () => undefined, stderr: () => undefined }, {
    createProvider: () => provider,
    createInput: () => ({ readLine: async () => queue.shift(), dispose() {} }),
    storageEnvironment: { env: { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") } },
    clock: () => new Date(Date.UTC(2026, 9, 23, 10, 0, ticks++)),
    newId: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
  });
  return code;
}

async function sessionChecks(codecs, pythonConversation) {
  const main = await import(pathToFileURL(join(ROOT, "dist", "main.js")).href);
  const failures = [];
  const files = new Map();
  const collect = (root, prefix) => {
    const conversations = join(root, "state", "neurobrau", "conversations");
    for (const name of readdirSync(conversations).sort()) {
      files.set(`conversation_${prefix}_${name}`, readFileSync(join(conversations, name)));
    }
    files.set(`active_${prefix}.json`, readFileSync(join(root, "state", "neurobrau", "active.json")));
  };

  // A fresh session: unicode/control text, huge exact counts, an empty tier, an incomplete record, then /reset.
  const fresh = join(scratch, "session-fresh");
  const big = 2n ** 70n + 5n;
  const provider = fakeProvider("ollama", [
    { kind: "completed", result: { text: 'ctrl \u0001 \u001f "q" \\ \r\n\t \u{1F600} é', usage: { inputTokens: big, outputTokens: 0n, cachedInputTokens: 3n }, serviceTier: "" } },
    { kind: "incomplete", reason: "limit", partialText: "part", usage: { outputTokens: 9007199254740993n } },
  ]);
  const code = await runSession(main, fresh, ["--provider", "ollama", "--model", "hf.co/org/model:Q4_K_M"], ['q1 "x" \u{1F600}', "q2", "/reset", "/exit"], provider);
  if (code !== 0) failures.push(`TS session exited ${String(code)}`);
  collect(fresh, "fresh");

  // A Python-written conversation continued by TS: context sent, prior records kept exactly.
  const continued = join(scratch, "session-continued");
  const conversations = join(continued, "state", "neurobrau", "conversations");
  mkdirSync(conversations, { recursive: true });
  const original = readFileSync(pythonConversation);
  const decoded = codecs.decodeConversation(original);
  writeFileSync(join(conversations, `${decoded.id}.json`), original);
  const continuer = fakeProvider("ollama", [{ kind: "completed", result: { text: "ok", usage: { inputTokens: 5n } } }]);
  const code2 = await runSession(main, continued, [], ["continue please", "/exit"], continuer);
  if (code2 !== 0) failures.push(`TS continuation exited ${String(code2)}`);
  const expectedContext = [...decoded.messages.map((m) => `${m.role}:${m.content}`), "user:continue please"];
  if (JSON.stringify(continuer.seen[0]) !== JSON.stringify(expectedContext)) {
    failures.push("continuation: the request did not carry the Python conversation context");
  }
  const after = codecs.decodeConversation(readFileSync(join(conversations, `${decoded.id}.json`)));
  const keptRecords = after.requests.slice(0, decoded.requests.length);
  if (JSON.stringify(keptRecords, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)) !== JSON.stringify(decoded.requests, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))) {
    failures.push("continuation: prior usage records changed");
  }
  if (after.messages.length !== decoded.messages.length + 2 || after.requests.length !== decoded.requests.length + 1) {
    failures.push("continuation: unexpected message or record count");
  }
  collect(continued, "continued");
  return { sessionFiles: files, sessionFailures: failures };
}
