import { run } from "./main.js";
import { createWriter, sigintSource } from "./process-io.js";
import { API_KEY_ENV_VAR } from "./providers/openai/capabilities.js";
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
  },
);
