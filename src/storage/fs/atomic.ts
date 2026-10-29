import { randomBytes } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";

import { isAbortError } from "../../domain/errors.js";
import { codeOf, createStorageAbort, StorageIoError, StoragePolicyError } from "./errors.js";
import type { CleanupFailure, StorageSubject } from "./errors.js";
import type { StorageFs, WritableFile } from "./node-fs.js";
import { ensureNotAbortedSignal } from "./signal.js";

const FILE_MODE = 0o600;
const TEMP_ATTEMPTS = 10;

export interface AtomicWriteOptions {
  readonly subject: StorageSubject;
  readonly signal?: AbortSignal | undefined;
  /** Random part of the temporary file name; injectable for collision tests. */
  readonly randomSuffix?: (() => string) | undefined;
}

export interface AtomicWriteResult {
  /** False when syncing the directory after the (committed) rename was not possible. */
  readonly directorySynced: boolean;
}

interface TempFile {
  readonly path: string;
  readonly handle: WritableFile;
  open: boolean;
}

async function refuseNonRegularDestination(fs: StorageFs, path: string): Promise<void> {
  try {
    const info = await fs.lstat(path);
    if (info.kind === "symlink") throw new StoragePolicyError("NB_SYMLINK");
    if (info.kind !== "file") throw new StoragePolicyError("NB_NOT_REGULAR");
  } catch (error: unknown) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

async function createTemp(fs: StorageFs, path: string, suffix: () => string): Promise<TempFile> {
  const stem = basename(path, extname(path));
  for (let attempt = 1; ; attempt += 1) {
    const tempPath = join(dirname(path), `.${stem}.${suffix()}.tmp`);
    try {
      return { path: tempPath, handle: await fs.createExclusive(tempPath, FILE_MODE), open: true };
    } catch (error: unknown) {
      if (codeOf(error) !== "EEXIST" || attempt >= TEMP_ATTEMPTS) throw error;
    }
  }
}

async function removeOwnTemp(fs: StorageFs, temp: TempFile | undefined): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  if (temp === undefined) {
    return failures;
  }
  if (temp.open) {
    temp.open = false;
    try {
      await temp.handle.close();
    } catch (error: unknown) {
      failures.push({ step: "close", code: codeOf(error) });
    }
  }
  try {
    await fs.unlink(temp.path);
  } catch (error: unknown) {
    if (codeOf(error) !== "ENOENT") failures.push({ step: "unlink", code: codeOf(error) });
  }
  return failures;
}

/**
 * Replaces `path` with `data` so readers see the old or the new bytes, never a mix.
 *
 * Sequence: refuse a non-regular destination; create `.<stem>.<random>.tmp`
 * beside it exclusively (mode 0600, enforced against the umask); write every
 * byte; fsync; close; **rename** (the commit point); fsync the directory.
 * Cancellation is checked before starting and after every asynchronous step,
 * last of all immediately before rename. Once rename has been issued its
 * outcome decides: success is reported as success even if the signal aborted
 * meanwhile. Anything failing or cancelled before the commit closes the handle
 * and removes this operation's own temporary file only, leaving the
 * destination untouched; cleanup problems are reported on the error.
 * Already-submitted kernel I/O cannot be interrupted, so a cancellation takes
 * effect at the next boundary. The directory fsync after the rename is best
 * effort: its failure is reported in the result, never as a failed save.
 */
export async function writeFileAtomic(
  fs: StorageFs,
  path: string,
  data: Uint8Array,
  options: AtomicWriteOptions,
): Promise<AtomicWriteResult> {
  const { signal, subject } = options;
  const suffix = options.randomSuffix ?? ((): string => randomBytes(8).toString("hex"));
  let temp: TempFile | undefined;
  try {
    ensureNotAbortedSignal(signal);
    await refuseNonRegularDestination(fs, path);
    ensureNotAbortedSignal(signal);
    temp = await createTemp(fs, path, suffix);
    ensureNotAbortedSignal(signal);
    if (process.platform !== "win32") {
      await temp.handle.chmod(FILE_MODE); // the creation mode is reduced by the umask
      ensureNotAbortedSignal(signal);
    }
    for (let offset = 0; offset < data.length; ) {
      const written = await temp.handle.write(data, offset, data.length - offset);
      if (!Number.isInteger(written) || written <= 0) {
        throw Object.assign(new Error("write made no progress"), { code: "EIO" });
      }
      offset += written;
      ensureNotAbortedSignal(signal);
    }
    await temp.handle.sync();
    ensureNotAbortedSignal(signal);
    temp.open = false; // close() below ends the handle whether or not it throws
    await temp.handle.close();
    // No await between this check and the call: nothing can slip in before the rename is submitted.
    ensureNotAbortedSignal(signal);
    await fs.rename(temp.path, path);
  } catch (error: unknown) {
    const cleanupFailures = await removeOwnTemp(fs, temp);
    if (isAbortError(error)) {
      throw createStorageAbort(cleanupFailures);
    }
    throw new StorageIoError({ operation: "save", subject, path, cause: error, cleanupFailures });
  }
  try {
    await fs.syncDirectory(dirname(path));
    return { directorySynced: true };
  } catch {
    // Committed already; durability of the directory entry is best effort (documented), reported in the result.
    return { directorySynced: false };
  }
}
