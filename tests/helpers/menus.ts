/** Fakes for the menu/switching tests: providers with catalogs, gates and call counts; a saving settings store. */
import { ProviderError, createAbortError } from "../../src/domain/errors.js";
import type { ProviderId } from "../../src/domain/generation.js";
import type { Availability, ModelInfo } from "../../src/domain/provider.js";
import type { ModelCapabilities } from "../../src/domain/settings.js";
import type { SettingsSaveResult } from "../../src/application/chat-startup.js";
import { emptySettings } from "../../src/storage/settings.js";
import type { StoredModelPreferences, StoredSettings } from "../../src/storage/types.js";
import type { RunDependencies } from "../../src/main.js";
import { missingApiKeyError } from "../../src/providers/openai/errors.js";
import { MemoryHistory, ScriptedProvider } from "./chat.js";
import type { Tree } from "./storage-fs.js";
import { startTui } from "./tui.js";
import type { FakeTerminal, TuiSession } from "./tui.js";

export const LEVELS: ModelCapabilities = {
  reasoning: { known: true, values: ["low", "medium", "high"], allowsModelDefault: true, defaultValue: "low", modelDefault: "medium" },
  maxOutputTokensLimit: 8192,
};
export const OFF_ON: ModelCapabilities = { reasoning: { known: true, values: ["off", "on"], allowsModelDefault: false, defaultValue: "off" }, maxOutputTokensLimit: 4096 };
export const NONE: ModelCapabilities = { reasoning: { known: true, values: [], allowsModelDefault: true } };
export const UNKNOWN: ModelCapabilities = { reasoning: { known: false, values: [], allowsModelDefault: true } };

export const model = (id: string, details?: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, remote: false, ...(details === undefined ? {} : { details }), ...extra });

/** Waits for the gate, rejecting with an AbortError when the signal aborts first (unless `deaf`). */
export function waitFor(gate: Promise<void> | undefined, signal: AbortSignal, deaf = false): Promise<void> {
  if (gate === undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (!deaf) {
      const onAbort = (): void => { reject(createAbortError()); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    void gate.then(resolve);
  });
}

/** A provider with a model catalog, per-model capabilities, call counters, gates and injected failures. */
export class CatalogProvider extends ScriptedProvider {
  models: ModelInfo[];
  readonly caps = new Map<string, ModelCapabilities>();
  defaultCaps: ModelCapabilities = LEVELS;
  availability: Availability = { available: true, message: "" };
  availabilityError: ProviderError | undefined;
  listError: ProviderError | undefined;
  defaultName: string;
  listCalls = 0;
  availabilityCalls = 0;
  deaf = false;
  gates: { list?: Promise<void>; availability?: Promise<void>; capabilities?: Promise<void>; defaultModel?: Promise<void> } = {};

  constructor(id: ProviderId, models: readonly ModelInfo[], defaultName?: string) {
    super(id, [], { defaultModel: defaultName ?? models[0]?.id ?? "none" });
    this.label = id === "openai" ? "OpenAI" : "Ollama";
    this.models = [...models];
    this.defaultName = defaultName ?? models[0]?.id ?? "none";
  }

  override async listModels(signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    this.listCalls += 1;
    await waitFor(this.gates.list, signal ?? new AbortController().signal, this.deaf);
    if (this.listError !== undefined) throw this.listError;
    return this.models;
  }

  override async checkAvailability(signal?: AbortSignal): Promise<Availability> {
    this.availabilityCalls += 1;
    await waitFor(this.gates.availability, signal ?? new AbortController().signal, this.deaf);
    if (this.availabilityError !== undefined) throw this.availabilityError;
    return this.availability;
  }

  override async defaultModel(signal?: AbortSignal): Promise<string> {
    this.defaultModelCalls += 1;
    await waitFor(this.gates.defaultModel, signal ?? new AbortController().signal, this.deaf);
    return this.defaultName;
  }

  override async getCapabilities(name: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    this.capabilityCalls.push(name);
    await waitFor(this.gates.capabilities, signal ?? new AbortController().signal, this.deaf);
    return this.caps.get(name) ?? this.defaultCaps;
  }
}

/** A settings store holding a document; every save is recorded and can be made to fail. */
export class FakeSettingsStore {
  stored: StoredSettings;
  loads = 0;
  readonly saves: StoredSettings[] = [];
  results: SettingsSaveResult[] = [];
  saveEnabled = true;

  constructor(stored: StoredSettings = emptySettings()) {
    this.stored = stored;
  }

  load(): Promise<{ settings: StoredSettings; warnings: string[]; saveEnabled: boolean }> {
    this.loads += 1;
    return Promise.resolve({ settings: this.stored, warnings: [], saveEnabled: this.saveEnabled });
  }

  save(settings: StoredSettings): Promise<SettingsSaveResult> {
    this.saves.push(settings);
    const result = this.results.shift() ?? { saved: true };
    if (result.saved) this.stored = settings;
    return Promise.resolve(result);
  }
}

export function settingsDoc(style: "brief" | "normal" | "detailed", entries: Record<string, Record<string, StoredModelPreferences>>): StoredSettings {
  return {
    answerStyle: style,
    providers: new Map(Object.entries(entries).map(([provider, models]) => [provider, new Map(Object.entries(models))])),
  };
}

// ----- a whole fullscreen run with two providers -----


export interface MenuRig {
  readonly session: TuiSession;
  readonly openai: CatalogProvider;
  readonly ollama: CatalogProvider;
  readonly store: FakeSettingsStore;
  readonly history: MemoryHistory;
  /** Providers the factory was asked for, in order. */
  readonly created: ProviderId[];
  /** Providers whose readiness (key) check ran, in order. */
  readonly ready: ProviderId[];
}

export interface MenuRigOptions {
  readonly argv?: readonly string[];
  readonly store?: FakeSettingsStore;
  readonly history?: MemoryHistory;
  readonly noKey?: boolean;
  /** A provider whose construction fails (for example an invalid OLLAMA_HOST). */
  readonly createError?: Partial<Record<ProviderId, Error>>;
  readonly terminal?: FakeTerminal;
  readonly tree?: Tree;
  readonly deps?: Partial<RunDependencies>;
  readonly configure?: (providers: { openai: CatalogProvider; ollama: CatalogProvider }) => void;
}

export async function startMenuTui(options: MenuRigOptions = {}): Promise<MenuRig> {
  const openai = new CatalogProvider("openai", [model("gpt-6-luna"), model("gpt-5-mini")], "gpt-6-luna");
  const ollama = new CatalogProvider("ollama", [model("qwen3.5:4b", "4.7B Q4_K_M"), model("llama3.2:3b", "3.2B Q4_K_M"), model("gemma:2b", "2B Q4_0")], "qwen3.5:4b");
  options.configure?.({ openai, ollama });
  const store = options.store ?? new FakeSettingsStore();
  const history = options.history ?? new MemoryHistory();
  const created: ProviderId[] = [];
  const ready: ProviderId[] = [];
  const session = await startTui({
    argv: options.argv ?? ["--provider", "ollama", "--model", "qwen3.5:4b"],
    provider: options.argv?.includes("openai") === true ? openai : ollama,
    history,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.tree === undefined ? {} : { tree: options.tree }),
    deps: {
      createProvider: (id) => {
        const failure = options.createError?.[id];
        if (failure !== undefined) throw failure;
        created.push(id);
        return id === "openai" ? openai : ollama;
      },
      checkProviderReady: (id) => {
        ready.push(id);
        if (id === "openai" && options.noKey === true) throw missingApiKeyError();
      },
      createSettingsStore: () => store,
      ...options.deps,
    },
  });
  return { session, openai, ollama, store, history, created, ready };
}
