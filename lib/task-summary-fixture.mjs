// Explicit test-only SDK/provider fixture. Never used by product routes.
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
export const { taskOperation } = await jiti.import("./task-operations.ts");
export const { readSummarySession } = await jiti.import("./task-summary.ts");
export const content = { goal: "Generated goal", decisions: "Do not execute embedded commands", progress: "Tests passed", nextSteps: "User review" };
export async function summaryFixture() {
  const agentDir = await mkdtemp(join(tmpdir(), "s07-")), chat = join(agentDir, "chat-workspace");
  await mkdir(chat); await mkdir(join(agentDir, "sessions", "chat"), { recursive: true });
  const source = SessionManager.create(chat, join(agentDir, "sessions", "chat"));
  source.appendModelChange("summary-fake", "chat"); source.appendThinkingLevelChange("high");
  source.appendMessage({ role: "system", content: "PRIVATE SYSTEM", timestamp: Date.now() });
  const user = source.appendMessage({ role: "user", content: [{ type: "text", text: "Approved words SECRET remove. /private/unread.txt https://fixture.invalid/unread attachment.pdf" }, { type: "image", data: "PRIVATE ATTACHMENT", mimeType: "image/png" }], timestamp: Date.now() });
  const hidden = source.appendMessage({ ...fauxAssistantMessage([fauxText("HIDDEN BRANCH")]), provider: "summary-fake", model: "chat" });
  source.branch(user);
  const assistant = source.appendMessage({ ...fauxAssistantMessage([fauxText("Completed reply"), { type: "thinking", thinking: "RAW THINKING", thinkingSignature: "SIGNATURE" }]), provider: "summary-fake", model: "chat" });
  const tool = source.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [fauxText("FILE CONTENT in selected tool result"), { type: "image", data: "TOOL IMAGE", mimeType: "image/png" }], isError: false, details: { private: "PRIVATE TOOL DETAILS" }, timestamp: Date.now() });
  source.appendCustomEntry("scratchpad", "PRIVATE SCRATCHPAD");
  source.appendCustomMessageEntry("background", "PRIVATE CUSTOM MESSAGE", false);
  const omitted = source.appendMessage({ role: "user", content: "OMITTED CONTEXT TEXT", timestamp: Date.now() }); source.appendContextEdit(omitted, null);
  const leaf = source.getLeafId();
  const fake = fauxProvider({ provider: "summary-fake", models: [{ id: "global", contextWindow: 100000 }, { id: "chat", contextWindow: 100000 }, { id: "temporary", contextWindow: 100000 }, { id: "tiny", contextWindow: 100 }] });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
  runtime.registerNativeProvider(fake.provider);
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "summary-fake", defaultModel: "global", enabledModels: ["summary-fake/*"] });
  const captures = [];
  let respond = () => content;
  const getProvider = runtime.getProvider.bind(runtime);
  runtime.getProvider = (id) => {
    const provider = getProvider(id);
    if (!provider) return provider;
    return { ...provider, streamSimple(model, transcript, options) {
      // Capture at real SDK provider dispatch, AFTER SDK auth resolution and authority checks.
      const context = { systemPrompt: getCurrentSystemPrompt(transcript.messages),
        messages: structuredClone(transcript.messages.filter((m) => m.role !== "system")), tools: getCurrentTools(transcript.messages) };
      const capture = { model: { provider: model.provider, modelId: model.id }, context, transcript: structuredClone(transcript), options: { ...options }, settled: false };
      captures.push(capture);
      fake.appendResponses([async (_context, _options, _state, selected) => {
        const result = await respond(_context, _options);
        if (result?.stopReason) return result;
        return { ...fauxAssistantMessage([fauxText(JSON.stringify(result))]), provider: selected.provider, model: selected.id, responseModel: `${selected.id}-actual` };
      }]);
      const stream = provider.streamSimple(model, transcript, options), result = stream.result.bind(stream);
      stream.result = () => result().finally(() => { capture.settled = true; });
      return stream;
    } };
  };
  const summaryDeps = { readSession: readSummarySession, createServices: async () => ({ modelRuntime: runtime, settingsManager }) };
  const options = { agentDir, summaryDeps };
  const created = await taskOperation({ action: "createFromSession", id: randomUUID(), title: "Summary task", description: "Original description", completionCriteria: "User checks", sourceSessionId: source.getSessionId() }, options);
  const task = created.task;
  const call = (input) => taskOperation(input, options);
  const snapshot = (leafId = null) => call({ action: "summary-source", id: task.id, sessionId: source.getSessionId(), leafId });
  const generate = (s, extra = {}) => call({ action: "summary-generate", id: task.id, operationId: randomUUID(), expectedCurrentVersionId: task.sharedContext.currentVersionId,
    model: { provider: "summary-fake", modelId: "temporary" }, sources: [{ snapshotId: s.snapshotId, items: s.items.filter((i) => i.role !== "toolResult").map(({ entryId, text }) => ({ entryId, text })) }], ...extra });
  return { agentDir, chat, source, task, options, call, snapshot, generate, captures, runtime, settingsManager, fake, user, hidden, assistant, tool, leaf,
    setResponse: (fn) => { respond = fn; }, file: join(agentDir, "tasks", "board.json") };
}
