import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { makeTree } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";
import { startNode } from "./helpers/spawn.js";

const ROOT = resolve(import.meta.dirname, "../..");
const POSIX = process.platform !== "win32";
const PURE_DIR = join(ROOT, "src", "storage");

void describe("the pure codec entry point", () => {
  void it("imports no Node filesystem/environment modules and nothing from the filesystem layer", () => {
    const sources = readdirSync(PURE_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
    assert.ok(sources.includes("index.ts") && sources.length >= 10);
    for (const name of sources) {
      const code = readFileSync(join(PURE_DIR, name), "utf8");
      const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
      for (const specifier of specifiers) {
        assert.ok(!specifier.startsWith("node:"), `${name} imports ${specifier}`);
        assert.ok(!specifier.includes("/fs/") && !specifier.endsWith("/fs"), `${name} imports the filesystem layer`);
      }
      assert.ok(!/process\.env|process\.cwd|homedir/.test(code), `${name} reads the environment`);
    }
  });

  void it("is the only thing the application entry points could import: nothing outside src/storage and tests uses the storage layer yet", () => {
    for (const dir of ["application", "domain", "providers"]) {
      for (const name of readdirSync(join(ROOT, "src", dir), { recursive: true, encoding: "utf8" })) {
        if (!name.endsWith(".ts")) continue;
        assert.ok(!readFileSync(join(ROOT, "src", dir, name), "utf8").includes("storage/"), `${dir}/${name}`);
      }
    }
    for (const name of ["main.ts", "cli.ts", "args.ts", "process-io.ts", "help.ts", "version.ts"]) {
      assert.ok(!readFileSync(join(ROOT, "src", name), "utf8").includes("storage"), name);
    }
  });
});

void describe("the filesystem entry point is inert", () => {
  let tree: Tree;
  before(async () => {
    tree = await makeTree();
  });
  after(async () => {
    await tree.cleanup();
  });

  void it("importing and constructing stores performs no filesystem access and prints nothing", async () => {
    // Node's permission model denies every read outside the allowed list: any access outside dist would throw.
    const script = `
      const fs = await import(${JSON.stringify(join(ROOT, "dist", "storage", "fs", "index.js"))});
      const pure = await import(${JSON.stringify(join(ROOT, "dist", "storage", "index.js"))});
      const store = new fs.HistoryStore(${JSON.stringify(tree.conversations)});
      const settings = new fs.SettingsStore(${JSON.stringify(tree.settings)});
      const paths = fs.resolveStoragePaths({ env: {}, home: "/h" });
      if (!store || !settings || !paths || typeof pure.encodeConversation !== "function") process.exitCode = 3;
    `;
    const done = await startNode(
      ["--permission", `--allow-fs-read=${join(ROOT, "dist")}`, "--input-type=module", "-e", script],
      { HOME: tree.root, XDG_STATE_HOME: join(tree.root, "must-not-be-read"), XDG_CONFIG_HOME: join(tree.root, "must-not-be-read") },
    ).result;
    assert.equal(done.stderr, "");
    assert.equal(done.stdout, "");
    assert.equal(done.code, 0);
  });
});

void describe("permissions under different umasks (isolated child processes)", { skip: !POSIX }, () => {
  const CHILD = join(ROOT, ".test-dist", "tests", "helpers", "umask-child.js");
  for (const umask of ["000", "022", "077"]) {
    void it(`produces 0700 directories and 0600 files with umask ${umask}`, async () => {
      const tree = await makeTree();
      try {
        const done = await startNode([CHILD, tree.root, umask], { HOME: tree.root }).result;
        assert.equal(done.code, 0, done.stderr);
        assert.deepEqual(JSON.parse(done.stdout), {
          app: "700",
          conversations: "700",
          conversation: "600",
          active: "600",
          settingsDir: "700",
          settings: "600",
        });
      } finally {
        await tree.cleanup();
      }
    });
  }
});
