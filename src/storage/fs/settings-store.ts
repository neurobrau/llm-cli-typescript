import { Buffer } from "node:buffer";
import { dirname } from "node:path";

import { StorageCodecError } from "../errors.js";
import { decodeSettings, emptySettings, encodeSettings } from "../settings.js";
import type { StoredSettings } from "../types.js";
import { commitFile } from "./commit.js";
import { displayPath, StorageIoError, StoragePolicyError, codeOf } from "./errors.js";
import { nodeFs } from "./node-fs.js";
import type { StorageFs } from "./node-fs.js";
import { requireAbsolutePath } from "./paths.js";
import { OperationQueue } from "./queue.js";

export interface SettingsStoreOptions {
  readonly fs?: StorageFs;
}

export interface SettingsLoad {
  /** Defaults when the file is missing or unusable. */
  readonly settings: StoredSettings;
  /** Recoverable per-entry notices, or the single reason the whole file was not used. */
  readonly warnings: readonly string[];
  /** Whether `save` is permitted through this instance. */
  readonly saveEnabled: boolean;
}

export type SettingsSave =
  | { readonly saved: true; readonly directorySynced: boolean }
  | { readonly saved: false; readonly reason: "not-loaded" | "disabled" | "io-error"; readonly warning: string; readonly error?: StorageIoError };

type State = "unloaded" | "writable" | "disabled";

/**
 * `settings.json` with the reference's never-overwrite-an-unreadable-file
 * guarantee, made explicit as a state machine:
 *
 * - `unloaded`: nothing examined; `save` is refused (`not-loaded`).
 * - `writable`: the last load found no file or a usable document (recoverable
 *   notices do not matter); `save` writes.
 * - `disabled`: a load hit a whole-file codec failure, a non-regular entry or a
 *   read failure. Final for this instance: later loads return defaults and the
 *   same warning without touching the disk, and `save` is refused (`disabled`).
 *   Create a new instance after the file is fixed or removed.
 *
 * `load` and `save` run one at a time in invocation order, so a save queued
 * right behind a failing load sees `disabled`. Loading never creates the file.
 */
export class SettingsStore {
  readonly path: string;
  private readonly fs: StorageFs;
  private readonly queue = new OperationQueue();
  private state: State = "unloaded";
  private disabledWarning = "";

  constructor(path: string, options: SettingsStoreOptions = {}) {
    this.path = requireAbsolutePath(path);
    this.fs = options.fs ?? nodeFs;
  }

  get saveEnabled(): boolean {
    return this.state === "writable";
  }

  load(): Promise<SettingsLoad> {
    return this.queue.run(() => this.doLoad());
  }

  /** Encodes immediately (a snapshot), then writes in order. Invalid values throw `StorageCodecError`. */
  save(settings: StoredSettings, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<SettingsSave> {
    const bytes = Buffer.from(encodeSettings(settings), "utf8");
    return this.queue.run(async () => {
      if (this.state === "unloaded") {
        return { saved: false, reason: "not-loaded", warning: `Settings not saved: ${displayPath(this.path)} has not been loaded yet.` } as const;
      }
      if (this.state === "disabled") {
        return { saved: false, reason: "disabled", warning: `Settings not saved: ${displayPath(this.path)} could not be read at startup.` } as const;
      }
      const target = dirname(this.path);
      try {
        const result = await commitFile({ fs: this.fs, path: this.path, bytes, subject: "settings", target, owned: [target], signal: options.signal });
        return { saved: true, directorySynced: result.directorySynced } as const;
      } catch (error: unknown) {
        if (!(error instanceof StorageIoError)) throw error; // cancellation (AbortError) rejects
        return { saved: false, reason: "io-error", warning: error.message, error } as const;
      }
    }, options.signal);
  }

  private async doLoad(): Promise<SettingsLoad> {
    if (this.state === "disabled") {
      return { settings: emptySettings(), warnings: [this.disabledWarning], saveEnabled: false };
    }
    const path = displayPath(this.path);
    let bytes: Uint8Array;
    try {
      const info = await this.fs.lstat(this.path);
      if (info.kind !== "file") {
        throw new StoragePolicyError(info.kind === "symlink" ? "NB_SYMLINK" : "NB_NOT_REGULAR");
      }
      bytes = await this.fs.readFile(this.path);
    } catch (error: unknown) {
      if (codeOf(error) === "ENOENT") {
        this.state = "writable";
        return { settings: emptySettings(), warnings: [], saveEnabled: true };
      }
      const reason = new StorageIoError({ operation: "read", subject: "settings", path: this.path, cause: error }).reason;
      return this.disable(`Could not read settings at ${path}: ${reason}. Using defaults; changes will not be saved.`);
    }
    try {
      const decoded = decodeSettings(bytes);
      this.state = "writable";
      return { settings: decoded.settings, warnings: decoded.notices, saveEnabled: true };
    } catch (error: unknown) {
      if (!(error instanceof StorageCodecError)) throw error;
      return this.disable(
        `Ignoring invalid settings file ${path}: ${error.message}. Using defaults; changes will not be saved until the file is fixed or removed.`,
      );
    }
  }

  private disable(warning: string): SettingsLoad {
    this.state = "disabled";
    this.disabledWarning = warning;
    return { settings: emptySettings(), warnings: [warning], saveEnabled: false };
  }
}
