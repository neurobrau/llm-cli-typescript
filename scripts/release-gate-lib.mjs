// Ordered, fail-fast release gate: each step runs only if every earlier step
// passed, in sequence (never in parallel, so builds cannot race). The first
// non-zero exit status is returned unchanged, so BLOCKED (3) stays 3.
import { spawnSync } from "node:child_process";

/** `steps`: [{ name, command, args }]. Returns { code, results }. */
export function runSteps(steps, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const log = options.log ?? (() => undefined);
  const results = [];
  for (const step of steps) {
    log(`\n=== ${step.name}: ${step.command} ${step.args.join(" ")} ===`);
    const done = spawn(step.command, step.args, { stdio: "inherit", env: options.env ?? process.env, cwd: options.cwd });
    const code = done.error !== undefined || done.status === null ? 1 : done.status;
    results.push({ name: step.name, code });
    if (code !== 0) {
      log(`\n${code === 3 ? "BLOCKED" : "FAILED"} at step "${step.name}" (exit ${String(code)}); later steps were not run`);
      return { code, results };
    }
  }
  return { code: 0, results };
}
