import { constants } from "node:fs";
import * as fsp from "node:fs/promises";

import { StoragePolicyError } from "./errors.js";

export type EntryKind = "file" | "directory" | "symlink" | "other";

/** `lstat` result: never follows links; the modification time keeps full nanosecond precision. */
export interface EntryInfo {
  readonly kind: EntryKind;
  readonly mtimeNs: bigint;
}

export interface WritableFile {
  /** Writes `length` bytes from `data` at `offset` at the current position; resolves with the count written. */
  write(data: Uint8Array, offset: number, length: number): Promise<number>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The narrow filesystem seam the stores use. Production code uses `nodeFs`;
 * tests wrap it to inject deterministic failures. Not a general abstraction.
 */
export interface StorageFs {
  lstat(path: string): Promise<EntryInfo>;
  /** Entry names only. */
  readdir(path: string): Promise<string[]>;
  /** Reads a regular file; refuses anything else (and symlinks) without blocking. */
  readFile(path: string): Promise<Uint8Array>;
  mkdir(path: string, options: { readonly recursive: boolean; readonly mode?: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Creates a new file (never opens an existing one) with the given mode. */
  createExclusive(path: string, mode: number): Promise<WritableFile>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Flushes a directory entry change; unsupported on some platforms. */
  syncDirectory(path: string): Promise<void>;
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

// O_NONBLOCK keeps an unexpected FIFO from blocking open(); O_NOFOLLOW refuses a symlink swapped in after lstat.
// Both are undefined on Windows.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW as number | undefined ?? 0) | (constants.O_NONBLOCK as number | undefined ?? 0);

export const nodeFs: StorageFs = {
  async lstat(path) {
    const stats = await fsp.lstat(path, { bigint: true });
    return { kind: kindOf(stats), mtimeNs: stats.mtimeNs };
  },
  readdir: (path) => fsp.readdir(path),
  async readFile(path) {
    const handle = await fsp.open(path, READ_FLAGS);
    try {
      if (!(await handle.stat()).isFile()) {
        throw new StoragePolicyError("NB_NOT_REGULAR");
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  },
  async mkdir(path, options) {
    await fsp.mkdir(path, options);
  },
  chmod: (path, mode) => fsp.chmod(path, mode),
  async createExclusive(path, mode) {
    const handle = await fsp.open(path, "wx", mode);
    return {
      async write(data, offset, length) {
        return (await handle.write(data, offset, length, null)).bytesWritten;
      },
      chmod: (next) => handle.chmod(next),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
  async syncDirectory(path) {
    const handle = await fsp.open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};
