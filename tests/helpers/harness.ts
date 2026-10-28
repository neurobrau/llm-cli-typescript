/**
 * Test-only executable composition: the same wiring as src/cli.ts, but the
 * OpenAI SDK talks to a loopback server and the key is a synthetic constant.
 * Usage: node harness.js BASE_URL [cli arguments...]
 */
import { run } from "../../src/main.js";
import { createWriter, sigintSource } from "../../src/process-io.js";
import { OpenAIProvider } from "../../src/providers/openai/provider.js";
import { createOpenAiApi } from "../../src/providers/openai/sdk.js";
import { KEY } from "./openai.js";

const [baseURL, ...cliArgs] = process.argv.slice(2);
if (baseURL === undefined) {
  throw new Error("missing base URL");
}

process.exitCode = await run(
  cliArgs,
  { stdout: createWriter(process.stdout), stderr: createWriter(process.stderr) },
  {
    createProvider: () =>
      new OpenAIProvider({
        getApiKey: () => KEY,
        createApi: (apiKey) => createOpenAiApi({ apiKey, baseURL }),
      }),
    interrupt: sigintSource,
  },
);
