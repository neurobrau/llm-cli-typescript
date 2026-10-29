import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoredConversation } from "../../src/storage/index.js";
import { nodeFs } from "../../src/storage/fs/index.js";
import type { StorageFs, WritableFile } from "../../src/storage/fs/index.js";
import { deferred } from "./deferred.js";

export const ID_A = "11111111-1111-4111-8111-111111111111";
export const ID_B = "22222222-2222-4222-8222-222222222222";
export const ID_C = "33333333-3333-4333-8333-333333333333";

export function conversation(id = ID_A, updatedAt = "2026-10-21T08:00:00.000Z", extra: Partial<StoredConversation> = {}): StoredConversation {
  return {
    id,
    createdAt: new Date("2026-10-21T07:00:00.000Z"),
    updatedAt: new Date(updatedAt),
    provider: "openai",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    requests: [],
    ...extra,
  };
}

/** A fresh temporary tree shaped like `<root>/state/neurobrau/conversations`. */
export interface Tree {
  readonly root: string;
  readonly state: string;
  readonly app: string;
  readonly conversations: string;
  readonly active: string;
  readonly config: string;
  readonly settings: string;
  cleanup(): Promise<void>;
}

export async function makeTree(): Promise<Tree> {
  const root = await mkdtemp(join(tmpdir(), "neurobrau-fs-test-"));
  const state = join(root, "state");
  const app = join(state, "neurobrau");
  const config = join(root, "config", "neurobrau");
  return {
    root,
    state,
    app,
    conversations: join(app, "conversations"),
    active: join(app, "active.json"),
    config,
    settings: join(config, "settings.json"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

export async function put(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

export const text = (path: string): Promise<string> => readFile(path, "utf8");

export function errno(code: string): Error {
  return Object.assign(new Error(`synthetic ${code} with a secret-looking message sk-test-0000`), { code });
}

/** A copy of the real filesystem with some operations replaced. */
export function withFs(overrides: Partial<StorageFs>): StorageFs {
  return { ...nodeFs, ...overrides };
}

export interface FileFaults {
  write?: (inner: WritableFile, data: Uint8Array, offset: number, length: number) => Promise<number>;
  chmod?: (inner: WritableFile, mode: number) => Promise<void>;
  sync?: (inner: WritableFile) => Promise<void>;
  close?: (inner: WritableFile) => Promise<void>;
}

/** Wraps `createExclusive` so tests can fail or gate individual handle operations; `log` records operation names. */
export function faultyFiles(faults: FileFaults, log: string[] = []): StorageFs {
  return withFs({
    async createExclusive(path, mode) {
      const inner = await nodeFs.createExclusive(path, mode);
      log.push("create");
      const handle: WritableFile = {
        write: (data, offset, length) => {
          log.push("write");
          return faults.write ? faults.write(inner, data, offset, length) : inner.write(data, offset, length);
        },
        chmod: (m) => {
          log.push("chmod");
          return faults.chmod ? faults.chmod(inner, m) : inner.chmod(m);
        },
        sync: () => {
          log.push("sync");
          return faults.sync ? faults.sync(inner) : inner.sync();
        },
        close: () => {
          log.push("close");
          return faults.close ? faults.close(inner) : inner.close();
        },
      };
      return handle;
    },
  });
}

/** Holds an operation until released; `reached` resolves when it has been entered. */
export function gate() {
  const reached = deferred();
  const release = deferred();
  return {
    reached: reached.promise,
    release: () => {
      release.resolve();
    },
    enter: async (): Promise<void> => {
      reached.resolve();
      await release.promise;
    },
  };
}

export async function tempFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

/** A conversation as older writers produced it: without the named optional metadata. */
export function without(value: StoredConversation, ...keys: ("provider" | "model")[]): StoredConversation {
  const copy = Object.fromEntries(Object.entries(value).filter(([key]) => !keys.some((omitted) => omitted === key)));
  return copy as unknown as StoredConversation;
}
