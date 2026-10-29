import assert from "node:assert/strict";
import { chmod, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { isAbortError } from "../src/domain/errors.js";
import { cleanupFailuresOf, nodeFs, StorageIoError, writeFileAtomic } from "../src/storage/fs/index.js";
import type { StorageFs } from "../src/storage/fs/index.js";
import { errno, faultyFiles, gate, makeTree, names, tempFiles, text, withFs } from "./helpers/storage-fs.js";
import type { Tree } from "./helpers/storage-fs.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const POSIX = process.platform !== "win32";

let tree: Tree;
let dir = "";
let target = "";

before(async () => {
  tree = await makeTree();
});
after(async () => {
  await tree.cleanup();
});
beforeEach(async () => {
  dir = join(tree.root, `case-${String(Math.random()).slice(2)}`);
  await mkdir(dir);
  target = join(dir, "doc.json");
  await writeFile(target, "OLD");
});

const write = (fs: StorageFs, data = "NEW", signal?: AbortSignal) => writeFileAtomic(fs, target, bytes(data), { subject: "settings", signal });

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  return assert.fail("expected a rejection");
}

void describe("atomic writer: success", () => {
  void it("replaces the file, leaves no temp file and returns a durable receipt", async () => {
    assert.deepEqual(await write(nodeFs), { directorySynced: true });
    assert.equal(await text(target), "NEW");
    assert.deepEqual(await names(dir), ["doc.json"]);
  });

  void it("creates a new file when none exists, owner-only", { skip: !POSIX }, async () => {
    const fresh = join(dir, "fresh.json");
    await writeFileAtomic(nodeFs, fresh, bytes("x"), { subject: "settings" });
    assert.equal((await stat(fresh)).mode & 0o777, 0o600);
    await chmod(target, 0o644);
    await write(nodeFs);
    assert.equal((await stat(target)).mode & 0o777, 0o600, "a lax old file is replaced by a 0600 one");
  });

  void it("handles partial writes by writing every byte", async () => {
    const lengths: number[] = [];
    const fs = faultyFiles({
      write: (inner, data, offset, length) => {
        lengths.push(length);
        return inner.write(data, offset, Math.min(length, 2));
      },
    });
    await write(fs, "0123456789");
    assert.equal(await text(target), "0123456789");
    assert.deepEqual(lengths, [10, 8, 6, 4, 2]);
  });

  void it("treats a write that makes no progress as an I/O failure, not an endless loop", async () => {
    const fs = faultyFiles({ write: () => Promise.resolve(0) });
    const error = await failure(write(fs));
    assert.ok(error instanceof StorageIoError);
    assert.equal(error.code, "EIO");
    assert.equal(await text(target), "OLD");
    assert.deepEqual(await tempFiles(dir), []);
  });

  void it("names temp files .<stem>.<random>.tmp in the destination directory", async () => {
    const seen: string[] = [];
    const fs = withFs({
      createExclusive: (path, mode) => {
        seen.push(path);
        return nodeFs.createExclusive(path, mode);
      },
    });
    await write(fs);
    const [temp] = seen;
    assert.ok(temp);
    assert.match(temp.slice(dir.length + 1), /^\.doc\.[0-9a-f]{16}\.tmp$/);
    assert.equal(temp.slice(0, dir.length), dir);
  });

  void it("retries a colliding temp name and never touches unrelated temp files", async () => {
    const other = join(dir, ".doc.fixed.tmp");
    await writeFile(other, "someone else's");
    const names2 = ["fixed", "fixed", "unique"];
    await writeFileAtomic(nodeFs, target, bytes("NEW"), { subject: "settings", randomSuffix: () => names2.shift() ?? "late" });
    assert.equal(await text(other), "someone else's");
    assert.equal(await text(target), "NEW");
    assert.deepEqual(await names(dir), [".doc.fixed.tmp", "doc.json"]);
  });
});

void describe("atomic writer: failures before the commit", () => {
  const cases: readonly { name: string; fs: () => StorageFs; code: string }[] = [
    { name: "write", fs: () => faultyFiles({ write: () => Promise.reject(errno("ENOSPC")) }), code: "ENOSPC" },
    { name: "fsync", fs: () => faultyFiles({ sync: () => Promise.reject(errno("EIO")) }), code: "EIO" },
    { name: "close", fs: () => faultyFiles({ close: async (inner) => { await inner.close(); throw errno("EIO"); } }), code: "EIO" },
    { name: "chmod", fs: () => faultyFiles({ chmod: () => Promise.reject(errno("EPERM")) }), code: "EPERM" },
    { name: "rename", fs: () => withFs({ rename: () => Promise.reject(errno("EXDEV")) }), code: "EXDEV" },
    { name: "temp creation", fs: () => withFs({ createExclusive: () => Promise.reject(errno("EACCES")) }), code: "EACCES" },
  ];
  for (const { name, fs, code } of cases) {
    void it(`keeps the old bytes and removes its own temp file when ${name} fails`, async (t) => {
      if (name === "chmod" && !POSIX) t.skip("POSIX only");
      const error = await failure(write(fs()));
      assert.ok(error instanceof StorageIoError, String(error));
      assert.equal(error.code, code);
      assert.equal(error.operation, "save");
      assert.equal(error.cleanupFailures.length, 0);
      assert.ok(!error.message.includes("sk-test"), "the cause's message is never forwarded");
      assert.match(error.message, new RegExp(`^Could not save settings at .*doc\\.json: .+\\.$`));
      assert.equal(await text(target), "OLD");
      assert.deepEqual(await names(dir), ["doc.json"]);
    });
  }

  void it("reports a cleanup failure without losing the primary failure", async () => {
    const fs = faultyFiles({ sync: () => Promise.reject(errno("EIO")), close: async (inner) => { await inner.close(); throw errno("EBADF"); } });
    const failing: StorageFs = { ...fs, unlink: () => Promise.reject(errno("EACCES")) };
    const error = await failure(write(failing));
    assert.ok(error instanceof StorageIoError);
    assert.equal(error.code, "EIO");
    assert.deepEqual(error.cleanupFailures, [
      { step: "close", code: "EBADF" },
      { step: "unlink", code: "EACCES" },
    ]);
    assert.equal(await text(target), "OLD");
    assert.equal((await tempFiles(dir)).length, 1, "the refused unlink leaves exactly this operation's temp file");
  });

  void it("treats a temp file that is already gone as cleaned up", async () => {
    const fs = faultyFiles({ sync: () => Promise.reject(errno("EIO")) });
    const failing: StorageFs = { ...fs, unlink: () => Promise.reject(errno("ENOENT")) };
    const error = await failure(write(failing));
    assert.ok(error instanceof StorageIoError && error.cleanupFailures.length === 0);
  });

  void it("refuses a non-regular destination without touching it", { skip: !POSIX }, async () => {
    const real = join(dir, "real.txt");
    await writeFile(real, "REAL");
    const link = join(dir, "link.json");
    await symlink(real, link);
    const dirDest = join(dir, "folder.json");
    await mkdir(dirDest);
    for (const [path, reason] of [
      [link, "Is a symbolic link"],
      [dirDest, "Not a regular file"],
    ] as const) {
      const error = await failure(writeFileAtomic(nodeFs, path, bytes("NEW"), { subject: "settings" }));
      assert.ok(error instanceof StorageIoError);
      assert.equal(error.reason, reason);
    }
    assert.equal(await text(real), "REAL");
    assert.equal((await stat(link)).isFile(), true);
    assert.deepEqual(await tempFiles(dir), []);
  });
});

void describe("atomic writer: simultaneous writes", () => {
  void it("use distinct temp files and leave one complete document", async () => {
    const created: string[] = [];
    const start = gate();
    const fs = withFs({
      async createExclusive(path, mode) {
        created.push(path);
        if (created.length === 4) start.release();
        await start.enter();
        return nodeFs.createExclusive(path, mode);
      },
    });
    const bodies = ["A".repeat(50_000), "B".repeat(50_000), "C".repeat(50_000), "D".repeat(50_000)];
    await Promise.all(bodies.map((body) => write(fs, body)));
    assert.equal(new Set(created).size, 4);
    const final = await text(target);
    assert.ok(bodies.includes(final), "the file is exactly one of the complete documents");
    assert.deepEqual(await names(dir), ["doc.json"]);
  });

  void it("snapshot the data at invocation: a later mutation of the caller's buffer changes nothing", async () => {
    const hold = gate();
    const fs = withFs({
      async createExclusive(path, mode) {
        await hold.enter();
        return nodeFs.createExclusive(path, mode);
      },
    });
    // The stores copy before the first await; the writer itself writes the bytes it was given.
    const data = bytes("SNAPSHOT");
    const pending = writeFileAtomic(fs, target, data, { subject: "settings" });
    await hold.reached;
    hold.release();
    await pending;
    assert.equal(await text(target), "SNAPSHOT");
  });
});

void describe("atomic writer: cancellation", () => {
  void it("rejects with the project's AbortError before starting, touching nothing", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error("custom reason"));
    const error = await failure(write(faultyFiles({}, log), "NEW", controller.signal));
    assert.ok(isAbortError(error));
    assert.equal(error instanceof Error && error.message === "custom reason", false, "the custom reason does not leak");
    assert.deepEqual(log, []);
    assert.equal(await text(target), "OLD");
    assert.deepEqual(await names(dir), ["doc.json"]);
  });

  const boundaries: readonly { name: string; step: "create" | "chmod" | "write" | "sync" | "close" }[] = [
    { name: "temp creation", step: "create" },
    { name: "chmod", step: "chmod" },
    { name: "write", step: "write" },
    { name: "fsync", step: "sync" },
    { name: "close", step: "close" },
  ];
  for (const { name, step } of boundaries) {
    void it(`aborting during ${name} rejects after cleanup, keeps the old bytes and does no further I/O`, async (t) => {
      if (step === "chmod" && !POSIX) t.skip("POSIX only");
      const controller = new AbortController();
      const hold = gate();
      const log: string[] = [];
      const gated = async <T>(run: () => Promise<T>): Promise<T> => {
        const result = await run();
        await hold.enter();
        return result;
      };
      const base = faultyFiles(
        {
          chmod: (inner, mode) => (step === "chmod" ? gated(() => inner.chmod(mode)) : inner.chmod(mode)),
          write: (inner, data, offset, length) => (step === "write" ? gated(() => inner.write(data, offset, length)) : inner.write(data, offset, length)),
          sync: (inner) => (step === "sync" ? gated(() => inner.sync()) : inner.sync()),
          close: (inner) => (step === "close" ? gated(() => inner.close()) : inner.close()),
        },
        log,
      );
      const fs: StorageFs =
        step === "create"
          ? { ...base, createExclusive: async (path, mode) => gated(() => base.createExclusive(path, mode)) }
          : base;
      const pending = write(fs, "NEW", controller.signal);
      const outcome = pending.then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      await hold.reached;
      controller.abort();
      hold.release();
      const error = await outcome;
      assert.ok(isAbortError(error), String(error));
      assert.equal(cleanupFailuresOf(error).length, 0);
      const calls = log.length;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(log.length, calls, "no handle operation continues after the rejection");
      assert.equal(await text(target), "OLD");
      assert.deepEqual(await names(dir), ["doc.json"]);
    });
  }

  void it("an abort that arrives while the rename is in flight still reports the committed save", async () => {
    const controller = new AbortController();
    const hold = gate();
    const fs = withFs({
      async rename(from, to) {
        await nodeFs.rename(from, to);
        await hold.enter(); // the rename has taken effect; the abort lands before it resolves to the caller
      },
    });
    const pending = write(fs, "NEW", controller.signal);
    await hold.reached;
    controller.abort();
    hold.release();
    assert.deepEqual(await pending, { directorySynced: true });
    assert.equal(await text(target), "NEW");
    assert.deepEqual(await names(dir), ["doc.json"]);
  });

  void it("an abort arriving after the last check but before the rename still cannot cancel the commit", async () => {
    const controller = new AbortController();
    const fs = withFs({
      rename(from, to) {
        controller.abort(); // the signal fires as the rename is submitted: it is past the point of no return
        return nodeFs.rename(from, to);
      },
    });
    await write(fs, "NEW", controller.signal);
    assert.equal(await text(target), "NEW");
  });

  void it("an abort between close and rename is honored", async () => {
    const controller = new AbortController();
    const fs = faultyFiles({
      close: async (inner) => {
        await inner.close();
        controller.abort();
      },
    });
    assert.ok(isAbortError(await failure(write(fs, "NEW", controller.signal))));
    assert.equal(await text(target), "OLD");
    assert.deepEqual(await tempFiles(dir), []);
  });

  void it("reports cleanup that a cancellation could not finish", async () => {
    const controller = new AbortController();
    const fs: StorageFs = {
      ...faultyFiles({ sync: async (inner) => { await inner.sync(); controller.abort(); } }),
      unlink: () => Promise.reject(errno("EBUSY")),
    };
    const error = await failure(write(fs, "NEW", controller.signal));
    assert.ok(isAbortError(error));
    assert.deepEqual(cleanupFailuresOf(error), [{ step: "unlink", code: "EBUSY" }]);
  });
});

void describe("atomic writer: directory sync after the commit", () => {
  void it("a failing directory fsync is not a failed save", async () => {
    const fs = withFs({ syncDirectory: () => Promise.reject(errno("EINVAL")) });
    assert.deepEqual(await write(fs), { directorySynced: false });
    assert.equal(await text(target), "NEW");
    assert.deepEqual(await readdir(dir), ["doc.json"]);
  });
});
