// Optional development check (`npm run test:cross-parity`): the consolidated
// Python <-> Go <-> TypeScript compatibility gate. It EXECUTES the real pinned
// reference code (Python storage/settings/pricing, Go storage/settings/pricing
// through a private adapter) against synthetic data and compares it with the
// real TypeScript codecs, settings resolver, pricing module and application
// sessions. Not part of `npm run check`.
//
// Environment (all optional):
//   NEUROBRAU_PYTHON        Python executable (default python3)
//   NEUROBRAU_PYTHON_REPO   Python reference Git repository (default ../llm-cli-python)
//   NEUROBRAU_GO            go executable (default go)
//   NEUROBRAU_GO_REPO       Go reference Git repository (default ../llm-cli-go)
//   NEUROBRAU_GO_MODCACHE   Go module cache to read (default: `go env GOMODCACHE`)
// The pinned commits are exported with `git archive` into a private temporary
// tree; reference worktrees, indexes and caches are never written. Exit codes:
// 0 PASS, 1 compatibility/check failure, 3 BLOCKED (prerequisite missing or a
// reference is not the pinned commit; nothing is claimed). The temporary tree
// is removed in `finally`; the status is only recorded in process.exitCode.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Blocked, Failure, PINNED, exportCommit, oracleEnv, referenceState, runBounded } from "./xparity/lib.mjs";
import { stageStorage } from "./xparity/stage-storage.mjs";
import { stageSettings } from "./xparity/stage-settings.mjs";
import { stagePricing } from "./xparity/stage-pricing.mjs";
import { stageSessions } from "./xparity/stage-sessions.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const env = process.env;
const cfg = {
  python: env.NEUROBRAU_PYTHON ?? "python3",
  pythonRepo: resolve(env.NEUROBRAU_PYTHON_REPO ?? join(ROOT, "..", "llm-cli-python")),
  go: env.NEUROBRAU_GO ?? "go",
  goRepo: resolve(env.NEUROBRAU_GO_REPO ?? join(ROOT, "..", "llm-cli-go")),
  goModCache: env.NEUROBRAU_GO_MODCACHE,
  // Test-only seam: stand-in repositories cannot contain the pinned commits.
  pythonCommit: env.NEUROBRAU_XPARITY_TEST_COMMITS === "1" ? (env.NEUROBRAU_PYTHON_COMMIT ?? PINNED.python) : PINNED.python,
  goCommit: env.NEUROBRAU_XPARITY_TEST_COMMITS === "1" ? (env.NEUROBRAU_GO_COMMIT ?? PINNED.go) : PINNED.go,
};

const scratch = mkdtempSync(join(tmpdir(), "neurobrau-cross-parity-"));
try {
  await main();
} catch (error) {
  if (error instanceof Blocked) {
    console.error(`BLOCKED (not passed, nothing was claimed): ${error.message}`);
    process.exitCode = 3;
  } else {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

async function main() {
  const dist = (name) => pathToFileURL(join(ROOT, "dist", name)).href;
  const modules = {};
  try {
    modules.codecs = await import(dist("storage/index.js"));
    modules.pricing = await import(dist("pricing/index.js"));
    modules.money = await import(dist("pricing/money.js"));
    modules.settings = await import(dist("application/resolve-settings.js"));
    modules.usageReport = await import(dist("application/usage-report.js"));
    modules.main = await import(dist("main.js"));
  } catch {
    throw new Blocked("dist/ is missing or incomplete; run via `npm run test:cross-parity` (it builds first)");
  }
  mkdirSync(join(scratch, "home"), { recursive: true });
  const safeEnv = oracleEnv(scratch);

  // ----- prerequisites and reference identities -----
  const pyVersion = await runBounded(cfg.python, ["--version"], { env: safeEnv, timeoutMs: 20_000, uncapped: true });
  if (pyVersion.error !== undefined || pyVersion.code !== 0) throw new Blocked(`Python interpreter "${cfg.python}" cannot run; set NEUROBRAU_PYTHON`);
  const goVersion = await runBounded(cfg.go, ["version"], { env: { PATH: env.PATH ?? "", HOME: join(scratch, "home") }, timeoutMs: 20_000, uncapped: true });
  if (goVersion.error !== undefined || goVersion.code !== 0) throw new Blocked(`Go toolchain "${cfg.go}" cannot run; install Go or set NEUROBRAU_GO (nothing is installed automatically)`);
  for (const [name, repo] of [["Python", cfg.pythonRepo], ["Go", cfg.goRepo]]) {
    if (!existsSync(repo)) throw new Blocked(`${name} reference repository not found at ${repo}; set NEUROBRAU_${name.toUpperCase()}_REPO`);
  }
  if (cfg.pythonCommit !== PINNED.python || cfg.goCommit !== PINNED.go) {
    console.log("NOTE: test-only commit override in effect; this run is not an audit of the pinned references");
  }
  const before = { python: await referenceState(cfg.pythonRepo), go: await referenceState(cfg.goRepo) };
  const identities = {
    python: { commit: cfg.pythonCommit, worktreeHead: before.python.head, version: (pyVersion.stdout.toString("utf8") || pyVersion.stderr).trim() },
    go: { commit: cfg.goCommit, worktreeHead: before.go.head, version: goVersion.stdout.toString("utf8").trim() },
  };
  console.log(`Python ${identities.python.version}; reference ${identities.python.commit} (worktree HEAD ${identities.python.worktreeHead})`);
  console.log(`${identities.go.version}; reference ${identities.go.commit} (worktree HEAD ${identities.go.worktreeHead})`);
  console.log(`Node ${process.version} (${process.execPath})`);

  const refs = join(scratch, "refs");
  await exportCommit(cfg.pythonRepo, cfg.pythonCommit, join(refs, "python"), ["src"], scratch);
  const pySrc = join(refs, "python", "src");
  if (!existsSync(join(pySrc, "neurobrau_cli", "pricing.py"))) throw new Blocked(`${cfg.pythonCommit} does not contain src/neurobrau_cli/pricing.py`);
  const goTree = join(refs, "go");
  await exportCommit(cfg.goRepo, cfg.goCommit, goTree, [], scratch);
  if (!existsSync(join(goTree, "go.mod"))) throw new Blocked(`${cfg.goCommit} does not contain go.mod`);

  // ----- the Go adapter: built from a private copy of the pinned module -----
  mkdirSync(join(goTree, "cmd", "xparity"), { recursive: true });
  cpSync(join(ROOT, "scripts", "xparity", "xparity.go"), join(goTree, "cmd", "xparity", "main.go"));
  let modCache = cfg.goModCache;
  if (modCache === undefined) {
    const asked = await runBounded(cfg.go, ["env", "GOMODCACHE"], { env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }, timeoutMs: 20_000 });
    modCache = asked.stdout.toString("utf8").trim();
  }
  const goEnv = { PATH: env.PATH ?? "", HOME: join(scratch, "home"), GOCACHE: join(scratch, "gocache"), GOMODCACHE: modCache, GOPATH: join(scratch, "gopath"), GOPROXY: "off", GOSUMDB: "off", GOFLAGS: "-mod=readonly", GOTOOLCHAIN: "local", GOWORK: "off", CGO_ENABLED: "0", TMPDIR: scratch };
  const adapter = join(scratch, "xparity");
  const built = await runBounded(cfg.go, ["build", "-o", adapter, "./cmd/xparity"], { env: goEnv, cwd: goTree, timeoutMs: 300_000 });
  if (built.error !== undefined) throw new Blocked(`cannot run the Go toolchain: ${built.error.message}`);
  if (built.code !== 0) {
    if (/module lookup disabled|no required module|missing go\.sum|cannot find module|GOPROXY=off|go: downloading|toolchain/.test(built.stderr)) {
      throw new Blocked(`the Go reference's dependencies are not in the local module cache (${modCache}); run \`go mod download\` in a clone of your own or set NEUROBRAU_GO_MODCACHE. Detail: ${built.stderr.trim().split("\n")[0]}`);
    }
    throw new Failure(`the Go adapter does not build against ${cfg.goCommit}: ${built.stderr.trim().split("\n").slice(0, 4).join(" | ")}`);
  }

  const ctx = {
    root: ROOT,
    scratch,
    modules,
    py: { exe: cfg.python, src: pySrc, env: safeEnv },
    go: { exe: adapter, env: { PATH: env.PATH ?? "", HOME: join(scratch, "home"), TMPDIR: scratch } },
    identities,
    report: [],
  };

  const stages = [
    ["storage", stageStorage],
    ["settings", stageSettings],
    ["pricing", stagePricing],
    ["sessions", stageSessions],
  ];
  const failures = [];
  for (const [name, stage] of stages) {
    try {
      const summary = await stage(ctx);
      ctx.report.push([name, "PASS", summary]);
      console.log(`PASS ${name}: ${summary}`);
    } catch (error) {
      if (error instanceof Blocked) throw error;
      ctx.report.push([name, "FAIL", error instanceof Error ? error.message : String(error)]);
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      if (process.env.NEUROBRAU_XPARITY_DEBUG === "1" && error instanceof Error) console.error(error.stack);
      failures.push(name);
    }
  }

  // ----- the references must be exactly as they were -----
  const after = { python: await referenceState(cfg.pythonRepo), go: await referenceState(cfg.goRepo) };
  for (const key of ["python", "go"]) {
    if (after[key].head !== before[key].head || after[key].status !== before[key].status) {
      throw new Failure(`the ${key} reference worktree changed during the run`);
    }
  }
  console.log("references unchanged: HEAD and `git status --porcelain` identical before and after (both repositories)");
  if (failures.length > 0) throw new Failure(`${failures.join(", ")} failed`);
  console.log("PASS cross-language parity: storage, settings, pricing and session interoperability (see docs/parity.md for the scoped matrix and intentional differences)");
}

