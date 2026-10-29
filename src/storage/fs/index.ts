/**
 * Filesystem entry point of the storage layer (Node `fs`/`path`/`crypto`).
 * Separate from `../index.ts`, which stays pure. Importing this module does
 * nothing: no I/O, no environment access, no output.
 */
export { writeFileAtomic } from "./atomic.js";
export type { AtomicWriteOptions, AtomicWriteResult } from "./atomic.js";
export { HistoryStore } from "./history-store.js";
export type {
  ActiveLoad,
  ConversationLoad,
  DeleteResult,
  HistoryStoreOptions,
  LatestConversation,
  SaveOptions,
  SaveReceipt,
} from "./history-store.js";
export { cleanupFailuresOf, displayPath, StorageIoError, StoragePathError } from "./errors.js";
export type { CleanupFailure, StorageOperation, StorageSubject } from "./errors.js";
export { nodeFs } from "./node-fs.js";
export type { EntryInfo, EntryKind, StorageFs, WritableFile } from "./node-fs.js";
export { newConversationId, resolveStorageComponents, resolveStoragePaths } from "./paths.js";
export type { ComponentPath, ComponentPaths, StorageEnvironment, StoragePathInput, StoragePaths } from "./paths.js";
export { SettingsStore } from "./settings-store.js";
export type { SettingsLoad, SettingsSave, SettingsStoreOptions } from "./settings-store.js";
