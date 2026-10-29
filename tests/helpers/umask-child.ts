// Child process for the umask tests: sets a umask, saves through the real stores under the given root,
// and prints the resulting modes as JSON. Synthetic data only.
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { HistoryStore, SettingsStore } from "../../src/storage/fs/index.js";

const [root, umask] = process.argv.slice(2);
if (root === undefined || umask === undefined) {
  throw new Error("usage: umask-child <root> <octal umask>");
}
process.umask(Number.parseInt(umask, 8));

const app = join(root, "state", "neurobrau");
const store = new HistoryStore(join(app, "conversations"));
const id = "11111111-1111-4111-8111-111111111111";
await store.save({
  id,
  createdAt: new Date("2026-10-21T07:00:00.000Z"),
  updatedAt: new Date("2026-10-21T08:00:00.000Z"),
  messages: [],
  requests: [],
});
await store.save({
  id,
  createdAt: new Date("2026-10-21T07:00:00.000Z"),
  updatedAt: new Date("2026-10-21T09:00:00.000Z"),
  messages: [],
  requests: [],
}); // replacement
await store.saveActive({ provider: "openai", model: "m" });
const settings = new SettingsStore(join(root, "config", "neurobrau", "settings.json"));
await settings.load();
await settings.save({ answerStyle: "normal", providers: new Map() });

const modeOf = async (path: string): Promise<string> => ((await stat(path)).mode & 0o777).toString(8);
console.log(
  JSON.stringify({
    app: await modeOf(app),
    conversations: await modeOf(join(app, "conversations")),
    conversation: await modeOf(join(app, "conversations", `${id}.json`)),
    active: await modeOf(join(app, "active.json")),
    settingsDir: await modeOf(join(root, "config", "neurobrau")),
    settings: await modeOf(join(root, "config", "neurobrau", "settings.json")),
  }),
);
