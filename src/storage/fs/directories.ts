import { basename, dirname } from "node:path";

import { codeOf, describeReason, displayPath, StoragePolicyError } from "./errors.js";
import type { EntryInfo, StorageFs } from "./node-fs.js";

export const APP_DIR_NAME = "neurobrau";
const DIR_MODE = 0o700;

const posix = (): boolean => process.platform !== "win32";

/** The conversations directory plus its parent when that is the `neurobrau` application directory. */
export function historyOwnedDirectories(conversations: string): string[] {
  const parent = dirname(conversations);
  return basename(parent) === APP_DIR_NAME ? [parent, conversations] : [conversations];
}

function requireDirectory(info: EntryInfo): void {
  if (info.kind === "symlink") throw new StoragePolicyError("NB_SYMLINK");
  if (info.kind !== "directory") throw new StoragePolicyError("NB_NOT_DIRECTORY");
}

async function lstatIfPresent(fs: StorageFs, path: string): Promise<EntryInfo | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error: unknown) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Makes `target` exist and, for the application-owned directories `owned`
 * (outermost first, the last being `target`), ensures they are real
 * directories (never symlinks) with mode 0700 despite the umask. Missing
 * ancestors above the first owned directory are created with default
 * permissions; existing ancestors are never changed. With nothing owned,
 * `target` is only created.
 */
export async function prepareDirectories(fs: StorageFs, target: string, owned: readonly string[]): Promise<void> {
  const first = owned[0];
  if (first === undefined) {
    await fs.mkdir(target, { recursive: true });
    return;
  }
  await fs.mkdir(dirname(first), { recursive: true });
  for (const directory of owned) {
    let info = await lstatIfPresent(fs, directory);
    if (info === undefined) {
      try {
        await fs.mkdir(directory, { recursive: false, mode: DIR_MODE });
      } catch (error: unknown) {
        if (codeOf(error) !== "EEXIST") throw error; // lost a race with another creator: verify below
      }
      info = await fs.lstat(directory);
    }
    requireDirectory(info);
    if (posix()) {
      await fs.chmod(directory, DIR_MODE);
    }
  }
}

/**
 * Tightens the owned directories that already exist to 0700; creates nothing.
 * Problems come back as warnings (reads can still proceed).
 */
export async function tightenExisting(fs: StorageFs, owned: readonly string[]): Promise<string[]> {
  const warnings: string[] = [];
  if (!posix()) {
    return warnings;
  }
  for (const directory of owned) {
    try {
      const info = await lstatIfPresent(fs, directory);
      if (info === undefined) continue;
      requireDirectory(info);
      await fs.chmod(directory, DIR_MODE);
    } catch (error: unknown) {
      warnings.push(`Could not tighten permissions on ${displayPath(directory)}: ${describeReason(error)}.`);
    }
  }
  return warnings;
}
