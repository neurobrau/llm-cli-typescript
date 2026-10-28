import { run } from "./main.js";
import { createWriter, sigintSource } from "./process-io.js";
import { API_KEY_ENV_VAR } from "./providers/openai/capabilities.js";
import { OpenAIProvider } from "./providers/openai/provider.js";

process.exitCode = await run(
  process.argv.slice(2),
  { stdout: createWriter(process.stdout), stderr: createWriter(process.stderr) },
  {
    // The key is read only when a provider operation actually runs.
    createProvider: () => new OpenAIProvider({ getApiKey: () => process.env[API_KEY_ENV_VAR] }),
    interrupt: sigintSource,
  },
);
