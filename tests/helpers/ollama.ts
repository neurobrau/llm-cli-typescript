import { OllamaProvider } from "../../src/providers/ollama/provider.js";
import type { OllamaProviderOptions } from "../../src/providers/ollama/provider.js";
import type { GenerationRequest } from "../../src/domain/generation.js";
import type { Loopback, RecordedRequest, Responder } from "./loopback.js";
import { json } from "./loopback.js";

export const baseRequest: GenerationRequest = {
  model: "m1",
  messages: [{ role: "user", content: "hi" }],
  reasoning: { explicit: false, source: "builtin" },
};

export function providerFor(server: Loopback, overrides: Partial<OllamaProviderOptions> = {}): OllamaProvider {
  return new OllamaProvider({ baseUrl: server.origin, ...overrides });
}

/** A synthetic /api/tags entry. */
export function tag(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, model: name, modified_at: "2026-01-01T00:00:00Z", size: 1, digest: `d-${name}`, details: {}, ...extra };
}

export const tags = (...models: Record<string, unknown>[]): Responder => json(200, { models });
export const show = (body: Record<string, unknown> = {}): Responder => json(200, body);

/** A completed non-streaming chat reply. */
export function chat(content: string, extra: Record<string, unknown> = {}): Responder {
  return json(200, {
    model: "m1",
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
    ...extra,
  });
}

export function bodyOf(request: RecordedRequest): Record<string, unknown> {
  const parsed: unknown = JSON.parse(request.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body is not an object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

export const paths = (server: Loopback): string[] => server.requests.map((request) => `${request.method} ${request.path}`);

/** An /api/show body for a thinking model with the given `thinking.values`. */
export function thinkingShowBody(values: unknown[]): Record<string, unknown> {
  return { capabilities: ["completion", "thinking"], thinking: { values } };
}
