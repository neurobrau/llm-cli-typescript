/**
 * The providers of one fullscreen run. Only the provider that was selected at
 * startup exists at first; another one is constructed - after the existing
 * readiness (key) check - the first time the user selects it, and reused
 * afterwards together with its discovery caches. Nothing here touches the
 * network, and no other provider's credentials or host are ever read.
 */
import type { ProviderId } from "../domain/generation.js";
import type { Provider } from "../domain/provider.js";

export interface ProviderHubOptions {
  readonly initial: Provider;
  readonly createProvider: (id: ProviderId) => Provider;
  /** Throws a ProviderError when the provider cannot run (e.g. no API key). No network. */
  readonly checkProviderReady?: ((id: ProviderId) => void) | undefined;
}

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = { openai: "OpenAI", ollama: "Ollama" };
export const PROVIDER_ORDER: readonly ProviderId[] = ["openai", "ollama"];

export class ProviderHub {
  private readonly providers = new Map<ProviderId, Provider>();

  constructor(private readonly options: ProviderHubOptions) {
    this.providers.set(options.initial.id, options.initial);
  }

  /** Whether the provider already exists (selecting it needs no construction). */
  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  /**
   * The provider instance, built on first use. Throws what the readiness check or the factory throws
   * (ProviderError / SettingsError) without remembering the failure, so a fixed environment can succeed later.
   */
  acquire(id: ProviderId): Provider {
    const existing = this.providers.get(id);
    if (existing !== undefined) return existing;
    this.options.checkProviderReady?.(id);
    const created = this.options.createProvider(id);
    this.providers.set(id, created);
    return created;
  }
}
