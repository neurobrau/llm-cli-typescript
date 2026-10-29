import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { StoragePathError } from "./errors.js";

export type StorageEnvironment = Readonly<Record<string, string | undefined>> | ((name: string) => string | undefined);

export interface StoragePathInput {
  /** The environment values to consult; nothing is read from `process.env`. */
  readonly env: StorageEnvironment;
  /** The home directory, used only for a base that has no valid XDG value. */
  readonly home?: string | undefined;
}

export interface StoragePaths {
  readonly conversations: string;
  readonly active: string;
  readonly settings: string;
}

const APP_DIR = "neurobrau";

function lookup(env: StorageEnvironment, name: string): string | undefined {
  if (typeof env === "function") {
    return env(name);
  }
  return Object.hasOwn(env, name) ? env[name] : undefined;
}

function checkNul(value: string | undefined): void {
  if (value?.includes("\0") === true) {
    throw new StoragePathError("invalid-path", "a storage path input contains a NUL character");
  }
}

function base(xdg: string | undefined, home: string | undefined, fallback: readonly string[]): string {
  // An empty or relative XDG value is invalid and ignored (XDG Base Directory spec). `~` is not expanded.
  if (xdg !== undefined && isAbsolute(xdg)) {
    return join(xdg);
  }
  if (home === undefined || !isAbsolute(home)) {
    throw new StoragePathError("home-required", "the home directory is unknown or not absolute, and no absolute XDG directory is set");
  }
  return join(home, ...fallback);
}

/**
 * Pure path resolution with injected inputs: no `process.env`, no `homedir()`,
 * no cwd and no filesystem access. XDG values are used when absolute (and
 * normalized); each base falls back to `<home>/.local/state` or
 * `<home>/.config` independently. A fallback without an absolute home throws.
 */
export function resolveStoragePaths(input: StoragePathInput): StoragePaths {
  const state = lookup(input.env, "XDG_STATE_HOME");
  const config = lookup(input.env, "XDG_CONFIG_HOME");
  checkNul(state);
  checkNul(config);
  checkNul(input.home);
  const stateApp = join(base(state, input.home, [".local", "state"]), APP_DIR);
  return {
    conversations: join(stateApp, "conversations"),
    active: join(stateApp, "active.json"),
    settings: join(base(config, input.home, [".config"]), APP_DIR, "settings.json"),
  };
}

export type ComponentPath<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: StoragePathError };

export interface ComponentPaths {
  /** The conversations directory and `active.json` (both in the state base). */
  readonly history: ComponentPath<{ readonly conversations: string; readonly active: string }>;
  /** `settings.json` (config base). */
  readonly settings: ComponentPath<string>;
}

function attempt<T>(compute: () => T): ComponentPath<T> {
  try {
    return { ok: true, value: compute() };
  } catch (error: unknown) {
    if (error instanceof StoragePathError) {
      return { ok: false, error };
    }
    throw error;
  }
}

/**
 * Like `resolveStoragePaths`, but each component fails on its own: a valid
 * absolute `XDG_STATE_HOME` keeps history usable when settings cannot be
 * located (no config base and no home), and the other way round. Same rules,
 * same purity; the existing function is unchanged.
 */
export function resolveStorageComponents(input: StoragePathInput): ComponentPaths {
  return {
    history: attempt(() => {
      const state = lookup(input.env, "XDG_STATE_HOME");
      checkNul(state);
      if (state === undefined || !isAbsolute(state)) checkNul(input.home);
      const app = join(base(state, input.home, [".local", "state"]), APP_DIR);
      return { conversations: join(app, "conversations"), active: join(app, "active.json") };
    }),
    settings: attempt(() => {
      const config = lookup(input.env, "XDG_CONFIG_HOME");
      checkNul(config);
      if (config === undefined || !isAbsolute(config)) checkNul(input.home);
      return join(base(config, input.home, [".config"]), APP_DIR, "settings.json");
    }),
  };
}

/** A new canonical lowercase version-4 UUID. Creates nothing and reads no clock. */
export function newConversationId(): string {
  return randomUUID();
}

export function requireAbsolutePath(path: string): string {
  if (path === "" || path.includes("\0") || !isAbsolute(path)) {
    throw new StoragePathError("invalid-path", "a storage location must be an absolute path without NUL characters");
  }
  return join(path);
}
