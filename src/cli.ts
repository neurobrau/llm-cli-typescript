import { homedir } from "node:os";

import { LineReader } from "./line-input.js";
import { run } from "./main.js";
import { createWriter, sigintSource } from "./process-io.js";
import { API_KEY_ENV_VAR } from "./providers/openai/capabilities.js";
import { missingApiKeyError } from "./providers/openai/errors.js";
import { OpenAIProvider } from "./providers/openai/provider.js";
import { HOST_ENV_VAR, resolveBaseUrl } from "./providers/ollama/host.js";
import { OllamaProvider } from "./providers/ollama/provider.js";

process.exitCode = await run(
  process.argv.slice(2),
  { stdout: createWriter(process.stdout), stderr: createWriter(process.stderr) },
  {
    // Only the selected provider is built, and its environment variable is read
    // only then (the OpenAI key additionally only when an operation runs).
    createProvider: (id) =>
      id === "ollama"
        ? new OllamaProvider({ baseUrl: resolveBaseUrl(process.env[HOST_ENV_VAR]) })
        : new OpenAIProvider({ getApiKey: () => process.env[API_KEY_ENV_VAR] }),
    interrupt: sigintSource,
    // Interactive chat only: the real environment, home, stdin and clock.
    storageEnvironment: { env: process.env, home: homeOrUndefined() },
    createInput: () => new LineReader(process.stdin),
    // Presence of the key only: no request is made to find out whether it is valid.
    checkProviderReady: (id) => {
      if (id === "openai" && (process.env[API_KEY_ENV_VAR] ?? "").trim() === "") {
        throw missingApiKeyError();
      }
    },
  },
);

function homeOrUndefined(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined; // no determinable home: history/settings are disabled with a warning
  }
}
