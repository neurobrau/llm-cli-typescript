import { Buffer } from "node:buffer";
import { basename, dirname, join } from "node:path";

import { decodeActiveSelection, encodeActiveSelection } from "../active.js";
import { decodeConversation, encodeConversation, isValidConversationId } from "../conversation.js";
import { StorageCodecError } from "../errors.js";
import { compareCodePoints } from "../json.js";
import type { ActiveSelection, StoredConversation } from "../types.js";
import { commitFile } from "./commit.js";
import { APP_DIR_NAME, historyOwnedDirectories, tightenExisting } from "./directories.js";
import { codeOf, describeReason, displayPath, StorageIoError, StoragePathError, StoragePolicyError } from "./errors.js";
import { nodeFs } from "./node-fs.js";
import type { EntryInfo, StorageFs } from "./node-fs.js";
import { requireAbsolutePath } from "./paths.js";
import { OperationQueue } from "./queue.js";

export interface HistoryStoreOptions {
  /** Filesystem seam; defaults to Node's. Intended for deterministic failure tests. */
  readonly fs?: StorageFs;
}

export interface SaveOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface SaveReceipt {
  readonly path: string;
  /** False when the directory could not be synced after the rename; the file itself is committed. */
  readonly directorySynced: boolean;
}

export type ConversationLoad =
  | { readonly kind: "loaded"; readonly path: string; readonly conversation: StoredConversation }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "unusable"; readonly path: string; readonly warning: string };

export interface LatestConversation {
  readonly conversation: StoredConversation | undefined;
  /** The file the conversation came from. */
  readonly path: string | undefined;
  /** Ordered: directory tightening problems first, then per-file problems in path order. */
  readonly warnings: readonly string[];
}

export interface ActiveLoad {
  readonly selection: ActiveSelection | undefined;
  readonly warning: string | undefined;
}

export interface DeleteResult {
  readonly deleted: number;
  /** Set when deletion stopped early; `deleted` files were already removed. */
  readonly error: StorageIoError | undefined;
}

interface Candidate {
  readonly path: string;
  readonly info: EntryInfo | undefined;
  readonly error: unknown;
}

const SUBJECT = "conversation history";
const ACTIVE_FILE = "active.json";

/**
 * Conversation files in one directory plus `active.json` beside it. Inert
 * until a method is called. Only regular files directly inside the directory
 * are ever considered: subdirectories, symlinks and special files are ignored
 * (a deliberate restriction of the references, which look at every `*.json`
 * entry). Writes (save, saveActive, deleteAll) run one at a time in
 * invocation order per instance; independent instances are last-rename-wins.
 */
export class HistoryStore {
  readonly directory: string;
  readonly activePath: string;
  private readonly fs: StorageFs;
  private readonly writes = new OperationQueue();

  constructor(conversationsDirectory: string, options: HistoryStoreOptions = {}) {
    this.directory = requireAbsolutePath(conversationsDirectory);
    this.activePath = join(dirname(this.directory), ACTIVE_FILE);
    this.fs = options.fs ?? nodeFs;
  }

  /** `<directory>/<id>.json` for a canonical lowercase UUID; anything else is rejected. */
  pathFor(id: string): string {
    if (!isValidConversationId(id)) {
      throw new StoragePathError("invalid-id", "a conversation id must be a canonical lowercase UUID");
    }
    return join(this.directory, `${id}.json`);
  }

  /** Tightens already-existing application directories to 0700; creates nothing. Returns warnings. */
  tightenExistingDirectories(): Promise<string[]> {
    return tightenExisting(this.fs, historyOwnedDirectories(this.directory));
  }

  /** Direct regular `*.json` files in code-point order. A missing directory is empty and is not created. */
  async listPaths(): Promise<string[]> {
    const candidates = await this.scan();
    return candidates.map((candidate) => {
      if (candidate.error !== undefined) {
        throw new StorageIoError({ operation: "read", subject: SUBJECT, path: candidate.path, cause: candidate.error });
      }
      return candidate.path;
    });
  }

  /** Loads one listed file (a path directly inside the directory). It is never modified. */
  async loadFile(path: string): Promise<ConversationLoad> {
    if (dirname(path) !== this.directory || !basename(path).endsWith(".json")) {
      throw new StoragePathError("invalid-path", "the file is not a conversation file of this store");
    }
    let info: EntryInfo;
    try {
      info = await this.fs.lstat(path);
    } catch (error: unknown) {
      if (codeOf(error) === "ENOENT") return { kind: "missing", path };
      return { kind: "unusable", path, warning: readWarning(path, error) };
    }
    if (info.kind !== "file") {
      return { kind: "unusable", path, warning: readWarning(path, new StoragePolicyError(info.kind === "symlink" ? "NB_SYMLINK" : "NB_NOT_REGULAR")) };
    }
    return this.readConversation(path);
  }

  loadById(id: string): Promise<ConversationLoad> {
    return this.loadFile(this.pathFor(id));
  }

  /**
   * The valid conversation (accepted by `accepts`) with the greatest
   * `updatedAt`; ties go to the greatest modification time (bigint
   * nanoseconds), then to the first in path order. Invalid or unreadable
   * files give warnings and stay untouched. Existing application directories
   * are tightened first. Exceptions from `accepts` propagate.
   */
  async loadLatest(accepts: (conversation: StoredConversation) => boolean = () => true): Promise<LatestConversation> {
    const warnings = await this.tightenExistingDirectories();
    let candidates: Candidate[];
    try {
      candidates = await this.scan();
    } catch (error: unknown) {
      if (error instanceof StorageIoError) {
        return { conversation: undefined, path: undefined, warnings: [...warnings, error.message] };
      }
      throw error;
    }
    let best: { conversation: StoredConversation; path: string; mtimeNs: bigint } | undefined;
    for (const candidate of candidates) {
      if (candidate.info === undefined) {
        warnings.push(readWarning(candidate.path, candidate.error));
        continue;
      }
      const loaded = await this.readConversation(candidate.path);
      if (loaded.kind === "unusable") {
        warnings.push(loaded.warning);
        continue;
      }
      if (loaded.kind === "missing" || !accepts(loaded.conversation)) {
        continue;
      }
      const time = loaded.conversation.updatedAt.getTime();
      const newer =
        best === undefined ||
        time > best.conversation.updatedAt.getTime() ||
        (time === best.conversation.updatedAt.getTime() && candidate.info.mtimeNs > best.mtimeNs);
      if (newer) {
        best = { conversation: loaded.conversation, path: candidate.path, mtimeNs: candidate.info.mtimeNs };
      }
    }
    return { conversation: best?.conversation, path: best?.path, warnings };
  }

  /** Writes `<id>.json` atomically with the supplied snapshot; nothing is generated or updated. */
  save(conversation: StoredConversation, options: SaveOptions = {}): Promise<SaveReceipt> {
    // Validated, encoded and copied before the first await: later caller mutation cannot change the write.
    const path = this.pathFor(conversation.id);
    const bytes = Buffer.from(encodeConversation(conversation), "utf8");
    const owned = historyOwnedDirectories(this.directory);
    return this.writes.run(async () => {
      const result = await commitFile({ fs: this.fs, path, bytes, subject: SUBJECT, target: this.directory, owned, signal: options.signal });
      return { path, directorySynced: result.directorySynced };
    }, options.signal);
  }

  /** Number of files `deleteAll` would remove, including corrupt and non-UUID-named regular `.json` files. */
  async countConversations(): Promise<number> {
    return (await this.listPaths()).length;
  }

  /**
   * Deletes every direct regular `*.json` file (corrupt ones too) and nothing else.
   * Explicit and unconditional: the caller must have obtained confirmation.
   * Stops at the first failure and reports it with the count already deleted.
   */
  deleteAll(): Promise<DeleteResult> {
    return this.writes.run(async () => {
      let candidates: Candidate[];
      try {
        candidates = await this.scan();
      } catch (error: unknown) {
        if (error instanceof StorageIoError) return { deleted: 0, error };
        throw error;
      }
      let deleted = 0;
      for (const candidate of candidates) {
        try {
          if (candidate.info === undefined) throw candidate.error;
          const now = await this.fs.lstat(candidate.path);
          if (now.kind !== "file") continue; // replaced by something that is not ours to delete
          await this.fs.unlink(candidate.path);
        } catch (error: unknown) {
          if (codeOf(error) === "ENOENT") continue; // disappeared meanwhile
          return { deleted, error: new StorageIoError({ operation: "delete", subject: SUBJECT, path: candidate.path, cause: error, deleted }) };
        }
        deleted += 1;
      }
      return { deleted, error: undefined };
    });
  }

  /** The saved selection. Missing: none, no warning. Unusable (also unsupported provider): none plus a warning; the file is kept. */
  async loadActive(): Promise<ActiveLoad> {
    const path = this.activePath;
    let bytes: Uint8Array;
    try {
      const info = await this.fs.lstat(path);
      if (info.kind !== "file") {
        throw new StoragePolicyError(info.kind === "symlink" ? "NB_SYMLINK" : "NB_NOT_REGULAR");
      }
      bytes = await this.fs.readFile(path);
    } catch (error: unknown) {
      if (codeOf(error) === "ENOENT") return { selection: undefined, warning: undefined };
      return { selection: undefined, warning: `Ignoring unreadable ${displayPath(path)}: ${describeReason(error)}.` };
    }
    try {
      return { selection: decodeActiveSelection(bytes), warning: undefined };
    } catch (error: unknown) {
      if (!(error instanceof StorageCodecError)) throw error;
      const warning =
        error.kind === "document" || error.kind === "field"
          ? `Ignoring invalid ${displayPath(path)}.`
          : `Ignoring unreadable ${displayPath(path)}: ${error.message}.`;
      return { selection: undefined, warning };
    }
  }

  /** Writes `active.json` atomically; creates only the state application directory. Conversation files are not touched. */
  saveActive(selection: ActiveSelection, options: SaveOptions = {}): Promise<SaveReceipt> {
    const path = this.activePath;
    const bytes = Buffer.from(encodeActiveSelection(selection), "utf8");
    const target = dirname(path);
    const owned = basename(target) === APP_DIR_NAME ? [target] : [];
    return this.writes.run(async () => {
      const result = await commitFile({ fs: this.fs, path, bytes, subject: SUBJECT, target, owned, signal: options.signal });
      return { path, directorySynced: result.directorySynced };
    }, options.signal);
  }

  private async scan(): Promise<Candidate[]> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.directory);
    } catch (error: unknown) {
      if (codeOf(error) === "ENOENT") return [];
      throw new StorageIoError({ operation: "read", subject: SUBJECT, path: this.directory, cause: error });
    }
    const candidates: Candidate[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort(compareCodePoints)) {
      const path = join(this.directory, name);
      try {
        const info = await this.fs.lstat(path);
        if (info.kind === "file") candidates.push({ path, info, error: undefined });
      } catch (error: unknown) {
        if (codeOf(error) !== "ENOENT") candidates.push({ path, info: undefined, error });
      }
    }
    return candidates;
  }

  private async readConversation(path: string): Promise<ConversationLoad> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFile(path);
    } catch (error: unknown) {
      if (codeOf(error) === "ENOENT") return { kind: "missing", path };
      return { kind: "unusable", path, warning: readWarning(path, error) };
    }
    try {
      return { kind: "loaded", path, conversation: decodeConversation(bytes) };
    } catch (error: unknown) {
      if (!(error instanceof StorageCodecError)) throw error;
      return {
        kind: "unusable",
        path,
        warning: `Ignoring unreadable conversation file ${displayPath(path)}: ${error.message}. The file was left unchanged.`,
      };
    }
  }
}

function readWarning(path: string, cause: unknown): string {
  return new StorageIoError({ operation: "read", subject: SUBJECT, path, cause }).message;
}
