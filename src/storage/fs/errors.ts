import { createAbortError } from "../../domain/errors.js";

export type StorageOperation = "read" | "save" | "delete";
export type StorageSubject = "conversation history" | "settings";

/** A cleanup step that failed after the primary failure (or cancellation). */
export interface CleanupFailure {
  readonly step: "close" | "unlink";
  readonly code: string | undefined;
}

/** Codes of the storage layer's own policy refusals (no OS error involved). */
export type PolicyCode = "NB_NOT_REGULAR" | "NB_NOT_DIRECTORY" | "NB_SYMLINK";

export class StoragePolicyError extends Error {
  readonly code: PolicyCode;

  constructor(code: PolicyCode) {
    super(code);
    this.name = "StoragePolicyError";
    this.code = code;
  }
}

/** A path or id that cannot be used; messages never include the offending value. */
export class StoragePathError extends Error {
  readonly kind: "home-required" | "invalid-path" | "invalid-id";

  constructor(kind: StoragePathError["kind"], message: string) {
    super(message);
    this.name = "StoragePathError";
    this.kind = kind;
  }
}

const REASONS: Readonly<Record<string, string>> = {
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENOENT: "No such file or directory",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ENOSPC: "No space left on device",
  EDQUOT: "Disk quota exceeded",
  EROFS: "Read-only file system",
  EIO: "Input/output error",
  EMFILE: "Too many open files",
  ENFILE: "Too many open files in system",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
  ENOTEMPTY: "Directory not empty",
  EBUSY: "Resource busy",
  EXDEV: "Cross-device link",
  EFBIG: "File too large",
  NB_NOT_REGULAR: "Not a regular file",
  NB_NOT_DIRECTORY: "Not a directory",
  NB_SYMLINK: "Is a symbolic link",
};

/** The `code` property of an error-like value, if it is a string. */
export function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** A fixed, user-presentable reason; never the error's own message (which may quote paths or content). */
export function describeReason(error: unknown): string {
  const code = codeOf(error);
  if (code === undefined) {
    return "I/O error";
  }
  return REASONS[code] ?? (/^E[A-Z0-9]{1,20}$/.test(code) ? `I/O error (${code})` : "I/O error");
}

/** Makes a path safe to print on one terminal line: control characters are shown as escapes. */
export function displayPath(path: string): string {
  let out = "";
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? (code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`) : char;
  }
  return out;
}

export interface StorageIoErrorInit {
  readonly operation: StorageOperation;
  readonly subject: StorageSubject;
  readonly path: string;
  readonly cause: unknown;
  readonly cleanupFailures?: readonly CleanupFailure[];
  readonly deleted?: number;
}

/**
 * An explicit operation that could not complete. The message follows the
 * references (`Could not <op> <subject> at <path>: <reason>.`) and is built
 * from a sanitized path and a fixed reason; `cause`, `code` and `path` keep the
 * structured details for callers, not for printing.
 */
export class StorageIoError extends Error {
  readonly operation: StorageOperation;
  readonly subject: StorageSubject;
  readonly path: string;
  readonly code: string | undefined;
  readonly reason: string;
  readonly cleanupFailures: readonly CleanupFailure[];
  /** For `delete`: how many files were removed before the failure. */
  readonly deleted: number | undefined;

  constructor(init: StorageIoErrorInit) {
    const reason = describeReason(init.cause);
    super(`Could not ${init.operation} ${init.subject} at ${displayPath(init.path)}: ${reason}.`, { cause: init.cause });
    this.name = "StorageIoError";
    this.operation = init.operation;
    this.subject = init.subject;
    this.path = init.path;
    this.code = codeOf(init.cause);
    this.reason = reason;
    this.cleanupFailures = init.cleanupFailures ?? [];
    this.deleted = init.deleted;
  }
}

/** The project's AbortError, plus any cleanup that could not be completed. */
export function createStorageAbort(cleanupFailures: readonly CleanupFailure[]): Error {
  const error = createAbortError();
  if (cleanupFailures.length > 0) {
    Object.defineProperty(error, "cleanupFailures", { value: cleanupFailures, enumerable: false });
  }
  return error;
}

/** Cleanup problems recorded on a storage error or on an AbortError from an atomic save. */
export function cleanupFailuresOf(error: unknown): readonly CleanupFailure[] {
  if (error instanceof StorageIoError) {
    return error.cleanupFailures;
  }
  if (typeof error === "object" && error !== null && "cleanupFailures" in error && Array.isArray(error.cleanupFailures)) {
    return error.cleanupFailures as readonly CleanupFailure[];
  }
  return [];
}
