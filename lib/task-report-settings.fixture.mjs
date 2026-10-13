// Isolated real SDK model catalogue + file settings, shared by behavior and browser tests.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

export async function reportSettingsFixture({ onRequest, contextWindow = 10000 } = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-report-settings-"));
  let requests = 0;
  const server = createServer((req, res) => { requests++; if (onRequest) onRequest(req, res); else res.writeHead(500).end("Report model must not be called"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const model = (reasoning, name) => ({ id: "same-id", name, reasoning, input: ["text"], contextWindow, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const providers = {
    "report-reasoning": { baseUrl, api: "openai-completions", apiKey: "test-only", models: [model(true, "Reasoning report")] },
    "report-plain": { baseUrl, api: "openai-completions", apiKey: "test-only", models: [model(false, "Plain report")] },
  };
  const initial = { defaultProvider: "chat-only", defaultModel: "chat-model", defaultThinkingLevel: "medium",
    enabledModels: ["report-reasoning/*", "report-plain/*"], defaultTools: ["read"], unrelated: { preserved: true } };
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify(initial));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers }));
  return {
    agentDir, settingsPath, initial, providers,
    selection: { provider: "report-reasoning", modelId: "same-id", thinkingLevel: "high" },
    read: async () => JSON.parse(await readFile(settingsPath, "utf8")),
    requests: () => requests,
    close: async () => { await new Promise((resolve) => server.close(resolve)); await rm(agentDir, { recursive: true, force: true }); },
  };
}
