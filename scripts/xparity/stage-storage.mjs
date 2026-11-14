// Storage compatibility matrix over the REAL Python and Go readers/writers and
// the TypeScript codecs: canonical byte identity (producer and consumer in every
// direction, both full chains), normalization, rejection, and the documented
// differences outside the common domain. Out-of-domain fixtures are counted
// separately from the all-three-language PASS count.
import { Buffer } from "node:buffer";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { commonFixtures, differenceFixtures, normalizationFixtures, rejectionFixtures } from "./storage-fixtures.mjs";
import { Failure, coverageProblems, expectClean, parseOracleJson, runBounded } from "./lib.mjs";

const PREFIXES = ["conversation", "settings", "active"];
const prefixOf = (name) => PREFIXES.find((p) => name.startsWith(p));

/** Bytes -> bytes through the TypeScript codecs; throws StorageCodecError for unusable files. */
export function tsRewrite(codecs, name, bytes) {
  const buffer = Buffer.from(bytes);
  switch (prefixOf(name)) {
    case "conversation":
      return codecs.encodeConversation(codecs.decodeConversation(buffer));
    case "settings":
      return codecs.encodeSettings(codecs.decodeSettings(buffer).settings);
    default:
      return codecs.encodeActiveSelection(codecs.decodeActiveSelection(buffer));
  }
}

/** A JSON-safe, bigint-exact dump of what the TypeScript decoder understood. */
export function semantic(codecs, name, bytes) {
  const buffer = Buffer.from(bytes);
  const value = prefixOf(name) === "conversation" ? codecs.decodeConversation(buffer) : prefixOf(name) === "settings" ? codecs.decodeSettings(buffer).settings : codecs.decodeActiveSelection(buffer);
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v instanceof Map ? [...v] : v));
}

function writeAll(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
}

/** Runs one reference's reader+writer over a directory; every file is answered exactly once. */
async function oracle(ctx, who, dir, names) {
  const run =
    who === "Python"
      ? await runBounded(ctx.py.exe, ["-B", "-I", join(ctx.root, "scripts", "python_storage_parity.py"), "check", ctx.py.src, dir], { env: ctx.py.env })
      : await runBounded(ctx.go.exe, ["storage-check", dir], { env: ctx.go.env });
  const out = parseOracleJson(expectClean(run, `${who} storage oracle`), `${who} storage oracle`);
  if (typeof out.rewritten !== "object" || out.rewritten === null || typeof out.problems !== "object" || out.problems === null) throw new Failure(`${who} storage oracle output is malformed`);
  const answered = [...Object.keys(out.rewritten), ...Object.keys(out.problems)];
  const gaps = coverageProblems(`${who} storage`, names, answered);
  if (gaps.length > 0) throw new Failure(gaps.join("; "));
  return { rewritten: new Map(Object.entries(out.rewritten).map(([k, v]) => [k, Buffer.from(v, "utf8")])), problems: new Map(Object.entries(out.problems)), warnings: out.warnings ?? {} };
}

/** Compares oracle output with expected bytes; returns problem strings. */
export function compareBytes(label, expected, result) {
  const problems = [];
  for (const [name, bytes] of expected) {
    const got = result.rewritten.get(name);
    if (got === undefined) problems.push(`${label}: ${name} was rejected (${String(result.problems.get(name))})`);
    else if (Buffer.compare(got, Buffer.from(bytes)) !== 0) problems.push(`${label}: ${name} was rewritten with different bytes`);
  }
  return problems;
}

export async function stageStorage(ctx) {
  const { codecs } = ctx.modules;
  const dirs = join(ctx.scratch, "storage");
  const problems = [];
  const counts = { common: 0, chains: 0, produced: 0, normalized: 0, rejected: 0, differences: 0 };

  // ----- common domain: canonical bytes from the TypeScript encoder -----
  const common = commonFixtures();
  const original = new Map();
  for (const f of common) {
    const bytes = Buffer.from(f.kind === "conversation" ? codecs.encodeConversation(f.value) : f.kind === "settings" ? codecs.encodeSettings(f.value) : codecs.encodeActiveSelection(f.value), "utf8");
    original.set(f.file, bytes);
  }
  const names = [...original.keys()];
  const d0 = join(dirs, "ts");
  writeAll(d0, original);
  // TS -> TS (decode, re-encode) is the identity
  for (const [name, bytes] of original) if (tsRewrite(codecs, name, bytes) !== bytes.toString("utf8")) problems.push(`TypeScript: ${name} does not round-trip`);

  // producers as consumers: Python and Go read what TypeScript wrote and write it back
  const py0 = await oracle(ctx, "Python", d0, names);
  const go0 = await oracle(ctx, "Go", d0, names);
  problems.push(...compareBytes("TS -> Python", original, py0), ...compareBytes("TS -> Go", original, go0));
  counts.common = names.length;

  // full chains: TS -> Python -> Go -> TS and TS -> Go -> Python -> TS
  const chain = async (first, second, tag) => {
    const firstResult = first === "Python" ? py0 : go0;
    if (firstResult.problems.size > 0) return;
    const d1 = join(dirs, `chain-${tag}-1`);
    writeAll(d1, firstResult.rewritten);
    const r2 = await oracle(ctx, second, d1, names);
    problems.push(...compareBytes(`TS -> ${first} -> ${second}`, original, r2));
    const d2 = join(dirs, `chain-${tag}-2`);
    writeAll(d2, r2.rewritten);
    for (const [name, bytes] of original) {
      const written = readFileSync(join(d2, name));
      if (tsRewrite(codecs, name, written) !== bytes.toString("utf8")) problems.push(`TS -> ${first} -> ${second} -> TS: ${name} differs after the TypeScript round trip`);
      else if (semantic(codecs, name, written) !== semantic(codecs, name, bytes)) problems.push(`TS -> ${first} -> ${second} -> TS: ${name} changed meaning`);
    }
    counts.chains += names.length;
  };
  await chain("Python", "Go", "pg");
  await chain("Go", "Python", "gp");

  // files produced by the references' own writers from a semantic spec (not from a loaded file)
  const spec = seedSpec();
  const specFile = join(dirs, "spec.json");
  mkdirSync(dirs, { recursive: true });
  writeFileSync(specFile, JSON.stringify(spec));
  const pyMade = join(dirs, "python-made");
  const goMade = join(dirs, "go-made");
  expectClean(await runBounded(ctx.py.exe, ["-B", "-I", join(ctx.root, "scripts", "xparity", "py_storage_write.py"), ctx.py.src, specFile, pyMade], { env: ctx.py.env }), "Python storage writer");
  expectClean(await runBounded(ctx.go.exe, ["storage-write", specFile, goMade], { env: ctx.go.env }), "Go storage writer");
  const goGenerated = join(dirs, "go-generated");
  expectClean(await runBounded(ctx.go.exe, ["storage-generate", goGenerated], { env: ctx.go.env }), "Go fixture generator");
  const pyGenerated = join(dirs, "python-generated");
  expectClean(await runBounded(ctx.py.exe, ["-B", "-I", join(ctx.root, "scripts", "python_storage_parity.py"), "generate", ctx.py.src, pyGenerated], { env: ctx.py.env }), "Python fixture generator");
  const readDir = (dir, keep) => new Map(readdirSync(dir).filter(keep).sort().map((n) => [n, readFileSync(join(dir, n))]));
  const sets = [
    ["Python writer", readDir(pyMade, () => true), ["Python", "Go"]],
    ["Go writer", readDir(goMade, () => true), ["Python", "Go"]],
    ["Go generator", readDir(goGenerated, (n) => PREFIXES.some((p) => n.startsWith(p))), ["Python", "Go"]],
    // The Python generator also writes values above signed 64 bits and an unknown provider: only the TypeScript and Python readers apply (see the difference table).
    ["Python generator", readDir(pyGenerated, (n) => PREFIXES.some((p) => n.startsWith(p))), ["Python"]],
  ];
  for (const [label, files, readers] of sets) {
    for (const [name, bytes] of files) {
      let rewritten;
      try {
        rewritten = tsRewrite(codecs, name, bytes);
      } catch (error) {
        problems.push(`${label} -> TypeScript: ${name} rejected (${error.message})`);
        continue;
      }
      if (rewritten !== bytes.toString("utf8")) problems.push(`${label} -> TypeScript: ${name} rewritten differently`);
    }
    const dir = join(dirs, `consume-${label.replace(/\W+/g, "-")}`);
    writeAll(dir, files);
    const nm = [...files.keys()];
    if (readers.includes("Python")) problems.push(...compareBytes(`${label} -> Python`, files, await oracle(ctx, "Python", dir, nm)));
    if (readers.includes("Go")) problems.push(...compareBytes(`${label} -> Go`, files, await oracle(ctx, "Go", dir, nm)));
    counts.produced += files.size;
  }

  // ----- normalization: raw files rewritten to the TypeScript canonical result -----
  const norm = normalizationFixtures();
  const normFiles = new Map(norm.map((f) => [f.file, Buffer.from(f.text, "utf8")]));
  const canonical = new Map();
  for (const f of norm) {
    const text = tsRewrite(codecs, f.file, normFiles.get(f.file));
    canonical.set(f.file, Buffer.from(text, "utf8"));
    for (const must of f.contains ?? []) if (!text.includes(must)) problems.push(`normalization ${f.file}: canonical result lacks ${must}`);
    for (const must of f.lacks ?? []) if (text.includes(must)) problems.push(`normalization ${f.file}: canonical result still contains ${must}`);
    if (f.ordered !== undefined && !(text.indexOf(f.ordered[0]) >= 0 && text.indexOf(f.ordered[0]) < text.indexOf(f.ordered[1]))) problems.push(`normalization ${f.file}: keys are not ordered`);
    if (f.exact !== undefined && text !== f.exact) problems.push(`normalization ${f.file}: canonical result is ${JSON.stringify(text)}`);
  }
  const dn = join(dirs, "normalization");
  writeAll(dn, normFiles);
  const nn = [...normFiles.keys()];
  problems.push(...compareBytes("normalization Python", canonical, await oracle(ctx, "Python", dn, nn)), ...compareBytes("normalization Go", canonical, await oracle(ctx, "Go", dn, nn)));
  counts.normalized = norm.length;

  // ----- rejection: nobody may produce a result from these -----
  const rej = rejectionFixtures();
  const rejFiles = new Map(rej.map((f) => [f.file, Buffer.from(f.text, "utf8")]));
  const dr = join(dirs, "rejection");
  writeAll(dr, rejFiles);
  const rn = [...rejFiles.keys()];
  const pyRej = await oracle(ctx, "Python", dr, rn);
  const goRej = await oracle(ctx, "Go", dr, rn);
  for (const f of rej) {
    let tsAccepted = true;
    try {
      tsRewrite(codecs, f.file, rejFiles.get(f.file));
    } catch {
      tsAccepted = false;
    }
    if (tsAccepted) problems.push(`rejection ${f.file} (${f.why}): TypeScript accepted it`);
    if (pyRej.rewritten.has(f.file)) problems.push(`rejection ${f.file} (${f.why}): Python accepted it`);
    if (goRej.rewritten.has(f.file)) problems.push(`rejection ${f.file} (${f.why}): Go accepted it`);
  }
  counts.rejected = rej.length;

  // ----- documented differences outside the common domain -----
  const diffs = differenceFixtures();
  const diffFiles = new Map(diffs.map((f) => [f.file, Buffer.from(f.text ?? codecs.encodeConversation(f.value), "utf8")]));
  const dd = join(dirs, "differences");
  writeAll(dd, diffFiles);
  const dn2 = [...diffFiles.keys()];
  const results = { python: await oracle(ctx, "Python", dd, dn2), go: await oracle(ctx, "Go", dd, dn2) };
  for (const f of diffs) {
    const source = diffFiles.get(f.file);
    const outcomes = {
      ts: (() => {
        try {
          return Buffer.from(tsRewrite(codecs, f.file, source), "utf8");
        } catch {
          return undefined;
        }
      })(),
      python: results.python.rewritten.get(f.file),
      go: results.go.rewritten.get(f.file),
    };
    for (const who of ["ts", "python", "go"]) {
      const expected = f.expect[who];
      const got = outcomes[who];
      const where = `difference ${f.file} [${f.group}] ${who}`;
      if (expected === "reject") {
        if (got !== undefined) problems.push(`${where}: expected rejection (${f.why}) but a rewrite was produced`);
      } else if (expected === "canonical") {
        if (got === undefined || Buffer.compare(got, source) !== 0) problems.push(`${where}: expected the canonical bytes`);
      } else if (expected === "canonical-with-escaped-separators") {
        const want = source.toString("utf8").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
        if (got === undefined || got.toString("utf8") !== want) problems.push(`${where}: expected the canonical bytes with U+2028/U+2029 escaped`);
        else if (tsRewrite(codecs, f.file, got) !== source.toString("utf8")) problems.push(`${where}: the escaped form does not normalize back to the canonical bytes`);
      } else {
        const want = expected.bytes(codecs);
        if (got === undefined || got.toString("utf8") !== want) problems.push(`${where}: expected ${JSON.stringify(want.slice(0, 120))}... (${f.why})`);
        if (expected.warns && !(results.go.warnings[f.file]?.length > 0)) problems.push(`${where}: expected a warning`);
      }
    }
  }
  counts.differences = diffs.length;

  if (problems.length > 0) throw new Failure(`${String(problems.length)} storage problem(s):\n  ${problems.slice(0, 30).join("\n  ")}`);

  // ----- negative controls: corrupted bytes, a dropped file, a duplicated answer -----
  const control = (name, found) => {
    if (found.length === 0) throw new Failure(`storage negative control "${name}" was not detected`);
  };
  const [firstName, firstBytes] = [...original][0];
  control("corrupted oracle bytes", compareBytes("control", original, { rewritten: new Map([...py0.rewritten, [firstName, Buffer.concat([firstBytes, Buffer.from(" ")])]]), problems: new Map() }));
  control("dropped oracle file", compareBytes("control", original, { rewritten: new Map([...py0.rewritten].slice(1)), problems: new Map() }));
  control("dropped coverage", coverageProblems("control", names, names.slice(0, -1)));
  control("duplicated coverage", coverageProblems("control", names, [...names, names[0]]));
  control("extra coverage", coverageProblems("control", names, [...names, "conversation_surprise.json"]));
  control("a changed value", [semantic(codecs, firstName, firstBytes) === semantic(codecs, firstName, Buffer.from(firstBytes.toString("utf8").replace("\"id\": \"0", "\"id\": \"1"))) ? [] : ["differs"]].flat());

  const outOfDomain = diffs.length;
  return `${String(counts.common)} canonical common-domain files byte-identical in TS<->Python<->Go (both chains: ${String(counts.chains)} file passes; ${String(counts.produced)} files from the references' own writers/generators); ${String(counts.normalized)} normalization, ${String(counts.rejected)} rejection fixtures; ${String(outOfDomain)} out-of-domain differences asserted per implementation (separate from the common count); 6 negative controls detected`;
}

/** Conversations written by the references' own writers (spec: counts as decimal strings, signed-64-bit-safe). */
export function seedSpec() {
  const id = (n) => `5eed0000-0000-4000-8000-00000000000${n}`;
  const at = (s) => `2026-10-21T12:00:0${s}.000Z`;
  return [
    {
      file: "conversation_seed_ollama.json", id: id(1), created_at: at(0), updated_at: at(1), provider: "ollama", model: "m",
      messages: [{ role: "user", content: "hello \u{1F600}" }, { role: "assistant", content: "world \"q\" \\ \u00e9" }],
      requests: [{ at: at(1), provider: "ollama", model: "m", status: "completed", usage: { input_tokens: "9007199254740993", output_tokens: "7", total_tokens: "9007199254741000" } }],
    },
    {
      file: "conversation_seed_openai.json", id: id(2), created_at: at(0), updated_at: at(2), provider: "openai", model: "gpt-6-luna",
      messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
      requests: [
        { at: at(1), provider: "openai", model: "gpt-6-luna", status: "completed", tier: "default", usage: { input_tokens: "11", output_tokens: "5", total_tokens: "16", cached_input_tokens: "0", cache_write_tokens: "0", reasoning_tokens: "0" } },
        { at: at(2), provider: "openai", model: "gpt-6-luna", status: "incomplete", tier: "", usage: { input_tokens: "4611686018427387904" } },
      ],
    },
    { file: "conversation_seed_legacy.json", id: id(3), created_at: at(0), updated_at: at(0), messages: [], requests: [] },
  ];
}
