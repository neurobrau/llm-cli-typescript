// Runs the compiled tests. An explicit file list avoids the silent success
// that `node --test` reports when a glob matches nothing.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const testDir = ".test-dist/tests";
let files = [];
try {
  files = readdirSync(testDir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(testDir, name));
} catch (error) {
  console.error(`cannot read ${testDir}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`no compiled test files found in ${testDir}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
