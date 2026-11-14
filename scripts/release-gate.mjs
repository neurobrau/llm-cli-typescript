// `npm run test:release`: the consolidated, ordered, fail-fast gate.
//   1. npm run check            (typecheck, lint, build, compiled tests; self-contained)
//   2. storage parity           (real Python storage serializers)
//   3. pricing parity           (real Python pricing functions)
//   4. cross-language parity    (real Python AND Go references; storage, settings, pricing, sessions)
// Steps 2-4 reuse the `dist/` that step 1 just built (nothing changes the sources in between), so no
// build or clean runs in parallel or twice. Exit: 0 all passed; 1 a step failed; 3 BLOCKED (a required
// prerequisite is missing; nothing is claimed as passed). A blocked step is never skipped to a pass.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runSteps } from "./release-gate-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const steps = [
  { name: "default checks", command: "npm", args: ["run", "check"] },
  { name: "storage parity (Python)", command: node, args: [join(root, "scripts", "storage-parity.mjs")] },
  { name: "pricing parity (Python)", command: node, args: [join(root, "scripts", "pricing-parity.mjs")] },
  { name: "cross-language parity (Python + Go)", command: node, args: [join(root, "scripts", "cross-parity.mjs")] },
];
const { code, results } = runSteps(steps, { cwd: root, log: (line) => console.log(line) });
console.log(`\nrelease gate: ${results.map((r) => `${r.name}=${r.code === 0 ? "ok" : String(r.code)}`).join(", ")}${code === 0 ? "" : ` -> exit ${String(code)}`}`);
process.exitCode = code;
