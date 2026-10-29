import { prepareDirectories } from "./directories.js";
import { StorageIoError } from "./errors.js";
import type { StorageSubject } from "./errors.js";
import { writeFileAtomic } from "./atomic.js";
import type { AtomicWriteResult } from "./atomic.js";
import type { StorageFs } from "./node-fs.js";
import { ensureNotAbortedSignal } from "./signal.js";

export interface CommitRequest {
  readonly fs: StorageFs;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly subject: StorageSubject;
  /** The directory that must exist, and the application-owned directories to create/tighten (outermost first). */
  readonly target: string;
  readonly owned: readonly string[];
  readonly signal?: AbortSignal | undefined;
}

/** Prepares the directories (failing the save if that fails), then writes atomically. */
export async function commitFile(request: CommitRequest): Promise<AtomicWriteResult> {
  const { fs, path, subject, signal } = request;
  ensureNotAbortedSignal(signal);
  try {
    await prepareDirectories(fs, request.target, request.owned);
  } catch (error: unknown) {
    throw new StorageIoError({ operation: "save", subject, path, cause: error });
  }
  return writeFileAtomic(fs, path, request.bytes, { subject, signal });
}
