/**
 * The committed state of one chat conversation and its lifecycle (Python
 * `session.py`, Go `internal/session`). It prints nothing, reads no clock,
 * environment or random source of its own, and never calls a provider: the
 * caller sends requests and tells the session what came back.
 *
 * Mutations that change memory (`applyCompleted`, `applyIncomplete`) are
 * synchronous, so a caller can decide "accepted or cancelled" and commit with
 * no await in between. Everything that touches storage (`persist`, `reset`,
 * `cleanup`, `countSaved`) is serialized in call order and awaited; the
 * session never leaves a write running after its promise settled. A storage
 * failure is returned as a warning and never undoes the in-memory state.
 */
import type { GenerationResult, IncompleteGeneration, Message, TokenUsage } from "../domain/generation.js";
import { StorageCodecError } from "../storage/errors.js";
import { StorageIoError, StoragePathError } from "../storage/fs/errors.js";
import type { ActiveSelection, StoredConversation, StoredUsageRecord, UsageStatus } from "../storage/types.js";

export type Clock = () => Date;

/** What the session needs from a history store (satisfied by `HistoryStore`). */
export interface SessionHistory {
  readonly directory: string;
  save(conversation: StoredConversation): Promise<unknown>;
  saveActive(selection: ActiveSelection): Promise<unknown>;
  countConversations(): Promise<number>;
  deleteAll(): Promise<{ readonly deleted: number; readonly error: { readonly message: string } | undefined }>;
}

export interface SessionOptions {
  /** The provider/model of this conversation; fixed for the session. */
  readonly selection: ActiveSelection;
  readonly clock: Clock;
  readonly newId: () => string;
  /** Absent: memory-only (nothing is read, written or created). */
  readonly history?: SessionHistory | undefined;
  /** A conversation to continue; copied on adoption. */
  readonly restored?: StoredConversation | undefined;
}

/** An independent copy of the session state; mutating it changes nothing. */
export interface SessionSnapshot {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly provider: ActiveSelection["provider"];
  readonly model: string;
  readonly messages: readonly Message[];
  readonly requests: readonly StoredUsageRecord[];
  /** A file for this conversation exists (loaded from, or saved to, history). */
  readonly onDisk: boolean;
}

export type CleanupOutcome =
  | { readonly kind: "disabled" }
  | { readonly kind: "deleted"; readonly deleted: number }
  | { readonly kind: "failed"; readonly deleted: number; readonly warning: string };

export function cloneRecord(record: StoredUsageRecord): StoredUsageRecord {
  return {
    at: new Date(record.at.getTime()),
    provider: record.provider,
    model: record.model,
    status: record.status,
    ...(record.serviceTier === undefined ? {} : { serviceTier: record.serviceTier }),
    usage: { ...record.usage },
  };
}

/**
 * A safe, printable description of a storage failure, or `undefined` for
 * anything that is not one (a bug, which the caller must not hide).
 */
export function describeStorageFailure(error: unknown): string | undefined {
  if (error instanceof StorageIoError || error instanceof StoragePathError) {
    return error.message;
  }
  if (error instanceof StorageCodecError) {
    return `Could not save conversation history: ${error.message}.`;
  }
  return undefined;
}

export class ChatSession {
  readonly selection: ActiveSelection;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly history: SessionHistory | undefined;
  private id = "";
  private createdAt = new Date(0);
  private updatedAt = new Date(0);
  private messages: Message[] = [];
  private requests: StoredUsageRecord[] = [];
  private onDisk = false;
  private restoredCount = 0;
  private activeSaved: ActiveSelection | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(options: SessionOptions) {
    this.selection = { ...options.selection };
    this.clock = options.clock;
    this.newId = options.newId;
    this.history = options.history;
    if (options.restored === undefined) {
      this.startNew();
    } else {
      this.adopt(options.restored);
    }
  }

  get persistent(): boolean {
    return this.history !== undefined;
  }

  get historyDirectory(): string | undefined {
    return this.history?.directory;
  }

  /** When and how big the restored conversation was; `undefined` unless a non-empty one was continued. */
  get restoredNotice(): { readonly updatedAt: Date; readonly messageCount: number } | undefined {
    return this.restoredCount === 0 ? undefined : { updatedAt: new Date(this.updatedAt.getTime()), messageCount: this.restoredCount };
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: new Date(this.updatedAt.getTime()),
      provider: this.selection.provider,
      model: this.selection.model,
      messages: Object.freeze(this.messages.map((message) => Object.freeze({ ...message }))),
      requests: Object.freeze(this.requests.map(cloneRecord)),
      onDisk: this.onDisk,
    };
  }

  /** What a request for `text` sends: the committed messages plus that one pending user message. Nothing is committed. */
  messagesFor(text: string): Message[] {
    return [...this.messages.map((message) => ({ ...message })), { role: "user", content: text }];
  }

  /**
   * Commits a completed exchange in memory, atomically: the pair and at most
   * one usage record (when usage was reported). Synchronous.
   */
  applyCompleted(text: string, result: GenerationResult): void {
    this.assertIdle();
    this.messages.push({ role: "user", content: text }, { role: "assistant", content: result.text });
    this.recordUsage(result.usage, result.serviceTier, "completed");
  }

  /**
   * Records the usage of an answer that stopped early; its text and prompt are
   * not committed. Returns whether the caller should `persist()`: only when
   * usage was reported and the conversation already has messages or a file.
   */
  applyIncomplete(outcome: IncompleteGeneration): boolean {
    this.assertIdle();
    if (!this.recordUsage(outcome.usage, outcome.serviceTier, "incomplete")) {
      return false;
    }
    return this.messages.length > 0 || this.onDisk;
  }

  /** Saves the conversation (new `updatedAt`), then `active.json` if not yet saved. Returns warnings. */
  persist(): Promise<readonly string[]> {
    return this.exclusive(() => this.save());
  }

  /**
   * Starts a fresh conversation for the same selection when there is anything
   * to leave behind (messages or usage); the old file stays. With history the
   * empty replacement is saved at once. An empty conversation is reused.
   */
  reset(): Promise<{ readonly started: boolean; readonly warnings: readonly string[] }> {
    return this.exclusive(async () => {
      if (this.messages.length === 0 && this.requests.length === 0) {
        return { started: false, warnings: [] };
      }
      this.startNew();
      return { started: true, warnings: await this.save() };
    });
  }

  /** Number of saved conversation files; rejects like the store does. Zero without history. */
  countSaved(): Promise<number> {
    return this.exclusive(() => (this.history === undefined ? Promise.resolve(0) : this.history.countConversations()));
  }

  /** Deletes every saved conversation (the caller has the user's confirmation). */
  cleanup(): Promise<CleanupOutcome> {
    return this.exclusive(async (): Promise<CleanupOutcome> => {
      if (this.history === undefined) {
        return { kind: "disabled" };
      }
      const result = await this.history.deleteAll();
      if (result.error !== undefined) {
        return { kind: "failed", deleted: result.deleted, warning: result.error.message };
      }
      this.startNew();
      return { kind: "deleted", deleted: result.deleted };
    });
  }

  private recordUsage(usage: TokenUsage | undefined, tier: string | undefined, status: UsageStatus): boolean {
    if (usage === undefined) {
      return false;
    }
    this.requests.push({
      at: this.clock(),
      provider: this.selection.provider,
      model: this.selection.model,
      status,
      ...(tier === undefined ? {} : { serviceTier: tier }),
      usage: { ...usage },
    });
    return true;
  }

  private async save(): Promise<string[]> {
    const history = this.history;
    if (history === undefined) {
      return [];
    }
    this.updatedAt = this.clock();
    try {
      await history.save(this.toStored());
    } catch (error: unknown) {
      return [rethrowUnlessStorage(error)];
    }
    this.onDisk = true;
    return this.saveActive(history);
  }

  private async saveActive(history: SessionHistory): Promise<string[]> {
    const wanted = this.selection;
    if (this.activeSaved?.provider === wanted.provider && this.activeSaved.model === wanted.model) {
      return [];
    }
    try {
      await history.saveActive({ ...wanted });
    } catch (error: unknown) {
      return [rethrowUnlessStorage(error)];
    }
    this.activeSaved = { ...wanted };
    return [];
  }

  private toStored(): StoredConversation {
    return {
      id: this.id,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: new Date(this.updatedAt.getTime()),
      provider: this.selection.provider,
      model: this.selection.model,
      messages: this.messages.map((message) => ({ ...message })),
      requests: this.requests.map(cloneRecord),
    };
  }

  private startNew(): void {
    const now = this.clock();
    this.id = this.newId();
    this.createdAt = new Date(now.getTime());
    this.updatedAt = new Date(now.getTime());
    this.messages = [];
    this.requests = [];
    this.onDisk = false;
    this.restoredCount = 0;
  }

  private adopt(stored: StoredConversation): void {
    this.id = stored.id;
    this.createdAt = new Date(stored.createdAt.getTime());
    this.updatedAt = new Date(stored.updatedAt.getTime());
    this.messages = stored.messages.map((message) => ({ ...message }));
    this.requests = stored.requests.map(cloneRecord);
    this.onDisk = true;
    this.restoredCount = this.messages.length;
  }

  private assertIdle(): void {
    if (this.pending > 0) {
      throw new Error("the session is busy persisting; no new exchange may be applied");
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const run = this.tail.then(task, task);
    const settled = run.finally(() => {
      this.pending -= 1;
    });
    this.tail = settled.catch(() => undefined);
    return settled;
  }
}

function rethrowUnlessStorage(error: unknown): string {
  const description = describeStorageFailure(error);
  if (description === undefined) {
    throw error;
  }
  return description;
}
