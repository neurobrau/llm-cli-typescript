/**
 * Test-only executable composition: the same wiring as src/cli.ts, but the
 * providers talk to loopback servers and the OpenAI key is a synthetic
 * constant. Usage: node harness.js OPENAI_BASE_URL [cli arguments...]
 * The Ollama base URL (loopback) comes from HARNESS_OLLAMA_BASE.
 */
import { homedir } from "node:os";

import { LineReader } from "../../src/line-input.js";
import { run } from "../../src/main.js";
import { createWriter, sigintSource } from "../../src/process-io.js";
import { OpenAIProvider } from "../../src/providers/openai/provider.js";
import { createOpenAiApi } from "../../src/providers/openai/sdk.js";
import { OllamaProvider } from "../../src/providers/ollama/provider.js";
import { KEY } from "./openai.js";

const [baseURL, ...cliArgs] = process.argv.slice(2);
if (baseURL === undefined) {
  throw new Error("missing base URL");
}
const ollamaBase = process.env.HARNESS_OLLAMA_BASE;

process.exitCode = await run(
  cliArgs,
  { stdout: createWriter(process.stdout), stderr: createWriter(process.stderr) },
  {
    createProvider: (id) => {
      if (id === "ollama") {
        if (ollamaBase === undefined) throw new Error("missing HARNESS_OLLAMA_BASE");
        return new OllamaProvider({ baseUrl: ollamaBase });
      }
      return new OpenAIProvider({
        getApiKey: () => KEY,
        createApi: (apiKey) => createOpenAiApi({ apiKey, baseURL }),
      });
    },
    interrupt: sigintSource,
    storageEnvironment: { env: process.env, home: homedir() },
    createInput: () => new LineReader(process.stdin),
  },
);
