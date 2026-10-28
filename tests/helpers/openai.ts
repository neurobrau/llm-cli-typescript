import { OpenAIProvider } from "../../src/providers/openai/provider.js";
import type { OpenAIProviderOptions } from "../../src/providers/openai/provider.js";
import { createOpenAiApi } from "../../src/providers/openai/sdk.js";
import type { GenerationRequest } from "../../src/domain/generation.js";
import type { Loopback } from "./loopback.js";

/** Synthetic credential; never a real key. */
export const KEY = "sk-test-synthetic-0123456789abcdef";

export const baseRequest: GenerationRequest = {
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "hi" }],
  reasoning: { explicit: false, source: "builtin" },
};

export interface Harness {
  readonly provider: OpenAIProvider;
  readonly keyReads: () => number;
  readonly apiCreations: () => number;
}

/** A provider using the real SDK against the loopback server. */
export function providerFor(server: Loopback, overrides: Partial<OpenAIProviderOptions> = {}, key: string | null = KEY, baseURL = server.url): Harness {
  let keyReads = 0;
  let apiCreations = 0;
  const provider = new OpenAIProvider({
    getApiKey: () => {
      keyReads += 1;
      return key ?? undefined;
    },
    createApi: (apiKey) => {
      apiCreations += 1;
      return createOpenAiApi({ apiKey, baseURL });
    },
    ...overrides,
  });
  return { provider, keyReads: () => keyReads, apiCreations: () => apiCreations };
}

export function bodyOf(request: { readonly body: string }): Record<string, unknown> {
  const parsed: unknown = JSON.parse(request.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body is not an object");
  }
  return Object.fromEntries(Object.entries(parsed));
}
