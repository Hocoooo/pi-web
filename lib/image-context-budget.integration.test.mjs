import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const image = (data) => ({ type: "image", data, mimeType: "image/png" });
const images = (messages) => messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === "image") : []);
const model = { ...getModel("anthropic", "claude-sonnet-4-5"), provider: "pi-web-image-test", id: "fixture", baseUrl: "https://image-test.invalid" };
const originalFetch = globalThis.fetch;
const originalBudget = process.env.PI_WEB_IMAGE_CONTEXT_MAX_BYTES;
test.before(() => { globalThis.fetch = async () => { throw new Error("Network is forbidden in image budget tests"); }; });
test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalBudget === undefined) delete process.env.PI_WEB_IMAGE_CONTEXT_MAX_BYTES; else process.env.PI_WEB_IMAGE_CONTEXT_MAX_BYTES = originalBudget;
});
const answer = (content = [{ type: "text", text: "done" }], stopReason = "stop") => ({
  role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
async function fixture(t, { factories = [], tools = [], respond = () => answer(), configure, sessionFile, settings = {}, virtualRoute } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-budget-"));
  process.env.PI_WEB_IMAGE_CONTEXT_MAX_BYTES = String(PNG.length * 2);
  const manager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(dir, dir);
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir,
    settingsManager: SettingsManager.inMemory({ images: { autoResize: false }, compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off", ...settings }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: factories },
  });
  const calls = [];
  services.modelRuntime.registerProvider(model.provider, {
    api: model.api, apiKey: "test-only", baseUrl: model.baseUrl, models: [model],
    streamSimple: (_model, context) => {
      calls.push(structuredClone(context.messages));
      const stream = createAssistantMessageEventStream();
      void Promise.resolve(respond(calls.length)).then(message => {
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  if (virtualRoute) services.modelRuntime.registerVirtualModel({ provider: "image-router", id: "auto", name: "Image test router", route: virtualRoute });
  const selected = virtualRoute ? services.modelRuntime.getModel("image-router", "auto") : services.modelRuntime.getModel(model.provider, model.id);
  const { session } = await createAgentSessionFromServices({ services, model: selected, tools, sessionManager: manager });
  configure?.(session);
  const wrapper = new AgentSessionWrapper(session, { headless: true });
  wrapper.start();
  wrapper.beginExtensionBinding();
  t.after(async () => {
    await wrapper.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  async function send(command) {
    const done = Promise.withResolvers();
    const off = wrapper.onEvent(e => { if (e.type === "prompt_done") done.resolve(); });
    try { await wrapper.send({ type: "prompt", message: "continue", ...command }); await done.promise; }
    finally { off(); }
  }
  return { dir, manager, session, wrapper, calls, send };
}

test("oversized latest user image group rejects before acceptance, append or provider (including queue commands)", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const type of ["prompt", "steer", "follow_up"]) {
    const before = f.manager.getEntries();
    await assert.rejects(f.wrapper.send({ type, message: "too many", images: [image(PNG), image(PNG), image(PNG)] }), /newest image-bearing message/i);
    assert.deepEqual(f.manager.getEntries(), before);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.session.pendingMessageCount, 0);
});

test("oversized reopened newest group rejects ordinary follow-up before acceptance but compact remains available", { timeout: 10000 }, async t => {
  const f = await fixture(t, { factories: [pi => pi.on("session_before_compact", event => ({ compaction: {
    summary: "text recovery", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 1,
  } }))] });
  f.manager.appendMessage({ role: "user", content: [image(PNG.repeat(3))], timestamp: 1 });
  f.manager.appendMessage(answer());
  f.manager.appendMessage({ role: "user", content: "later text", timestamp: 3 });
  f.manager.appendMessage(answer());
  await assert.rejects(f.wrapper.send({ type: "prompt", message: "follow up" }), /newest image-bearing message/i);
  assert.equal(f.calls.length, 0);
  await f.wrapper.send({ type: "compact" });
  assert.ok(f.manager.getEntries().some(e => e.type === "compaction"));
});

test("warm tool continuation offloads user images, preserving tool pair, details and entire tool image group", { timeout: 10000 }, async t => {
  const f = await fixture(t, {
    tools: ["pictures"],
    factories: [pi => pi.registerTool({ name: "pictures", label: "pictures", description: "fixture", parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "tool text" }, image(PNG), image(PNG)], details: { preserved: true } }; },
    })],
    respond: call => call === 1 ? answer([{ type: "toolCall", id: "picture-call", name: "pictures", arguments: {} }], "toolUse") : answer(),
  });
  await f.send({ images: [image(PNG)] });
  assert.equal(f.calls.length, 2);
  assert.equal(images(f.calls[0]).length, 1);
  assert.equal(images(f.calls[1]).length, 2, JSON.stringify(f.calls[1]));
  const result = f.calls[1].find(m => m.role === "toolResult");
  assert.equal(result.toolCallId, "picture-call");
  assert.equal(result.toolName, "pictures");
  assert.deepEqual(result.details, { preserved: true });
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(f.calls[1].find(m => m.role === "user")), /offloaded/);
  assert.ok(f.manager.getEntries().some(e => e.type === "context_edit"));
});

test("between-tool auto-compaction sees durable offload and retained images do not revive", { timeout: 10000 }, async t => {
  const preparations = [];
  const f = await fixture(t, {
    tools: ["pictures"],
    settings: { compaction: { enabled: true, reserveTokens: model.contextWindow - 1000, keepRecentTokens: 0 } },
    factories: [pi => {
      pi.registerTool({ name: "pictures", label: "pictures", description: "fixture", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "tool evidence ".repeat(1000) }, image(PNG), image(PNG)], details: {} }; },
      });
      pi.on("session_before_compact", (_event, ctx) => {
        const projection = ctx.sessionManager.buildSessionProjection();
        preparations.push(structuredClone(projection.messages));
        return { compaction: { summary: "text-only fixture summary", firstKeptEntryId: projection.entries.find(e => e.messages.some(m => m.role === "user")).sourceEntry.id, tokensBefore: 10000 } };
      });
    }],
    respond: call => call === 1 ? answer([{ type: "toolCall", id: "picture-call", name: "pictures", arguments: {} }], "toolUse") : answer(),
  });
  await f.send({ images: [image(PNG)] });
  assert.ok(preparations.length > 0);
  for (const messages of preparations) {
    assert.equal(images(messages).length, 2);
    assert.match(JSON.stringify(messages.find(m => m.role === "user")), /offloaded/);
  }
  assert.equal(f.calls.length, 2);
  assert.equal(images(f.calls[1]).length, 2);
  assert.equal(images(SessionManager.open(f.manager.getSessionFile()).buildSessionProjection().messages).length, 2);
});

test("oversized tool group is not silently trimmed; continuation makes zero additional provider calls", { timeout: 10000 }, async t => {
  const f = await fixture(t, {
    tools: ["pictures"],
    factories: [pi => pi.registerTool({ name: "pictures", label: "pictures", description: "fixture", parameters: Type.Object({}),
      async execute() { return { content: [image(PNG), image(PNG), image(PNG)] }; },
    })],
    respond: call => call === 1 ? answer([{ type: "toolCall", id: "picture-call", name: "pictures", arguments: {} }], "toolUse") : answer(),
  });
  await f.send();
  assert.equal(f.calls.length, 1);
  assert.match(f.session.messages.at(-1).errorMessage, /image.*budget/i);
  assert.equal(images(f.manager.buildSessionProjection().messages).length, 3);
  assert.equal(f.manager.getEntries().filter(e => e.type === "context_edit").length, 0);
});

test("final stream guard rejects context-hook and converter injected excess with zero provider calls", { timeout: 10000 }, async t => {
  for (const source of ["context", "converter"]) {
    const f = await fixture(t, {
      factories: source === "context" ? [pi => pi.on("context", event => ({ messages: [...event.messages, { role: "user", content: [image(PNG.repeat(3))], timestamp: 2 }] }))] : [],
      configure: source === "converter" ? session => {
        const convert = session.agent.convertToLlm;
        session.agent.convertToLlm = async messages => [...await convert(messages), { role: "user", content: [image(PNG.repeat(3))], timestamp: 2 }];
      } : undefined,
    });
    await f.send();
    assert.equal(f.calls.length, 0, source);
    assert.match(f.session.messages.at(-1).errorMessage, /image.*budget/i);
    assert.ok(f.session.messages.at(-1).piWebPerformance);
  }
});

test("queued image messages are budgeted at consumption, not silently lost or moved to another owner", { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { respond: async call => { if (call === 1) { entered.resolve(); await release.promise; } return answer(); } });
  t.after(() => release.resolve());
  const running = f.send({ images: [image(PNG)] });
  await entered.promise;
  await f.wrapper.send({ type: "follow_up", message: "queued image group", images: [image(PNG), image(PNG)] });
  assert.equal(f.session.pendingMessageCount, 1);
  release.resolve();
  await running;
  assert.equal(f.calls.length, 2);
  const newest = f.calls[1].find(m => m.role === "user" && m.content.some(b => b.text === "queued image group"));
  assert.deepEqual(images([newest]).map(b => b.data), [PNG, PNG]);
  assert.equal(images(f.calls[1]).length, 2);
  assert.equal(f.session.pendingMessageCount, 0);
});

test("custom image message injected before first request is the protected newest group", { timeout: 10000 }, async t => {
  const f = await fixture(t, { factories: [pi => pi.on("before_agent_start", () => ({ message: {
    customType: "new-images", content: [image(PNG), image(PNG)], display: true,
  } }))] });
  await f.send({ images: [image(PNG)] });
  assert.equal(f.calls.length, 1);
  assert.equal(images(f.calls[0]).length, 2);
  const custom = f.manager.getEntries().find(e => e.type === "custom_message");
  assert.deepEqual(custom.content, [image(PNG), image(PNG)]);
  assert.equal(f.manager.getEntries().find(e => e.type === "context_edit").targetId, f.manager.getEntries().find(e => e.message?.role === "user").id);
});

test("cold SDK wrapper reopens offloaded history without restoring images or duplicating edits", { timeout: 10000 }, async t => {
  const first = await fixture(t);
  first.manager.appendMessage({ role: "user", content: [image(PNG), image(PNG)], timestamp: 1 });
  await first.send({ images: [image(PNG), image(PNG)] });
  const file = first.manager.getSessionFile();
  const editCount = first.manager.getEntries().filter(e => e.type === "context_edit").length;
  await first.wrapper.shutdown();
  const second = await fixture(t, { sessionFile: file });
  await second.send();
  assert.equal(second.calls.length, 1);
  assert.equal(images(second.calls[0]).length, 2);
  assert.equal(second.manager.getEntries().filter(e => e.type === "context_edit").length, editCount);
});

test("failed durable append blocks the provider instead of sending an ephemeral trimmed request", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.manager.appendMessage({ role: "user", content: [image(PNG)], timestamp: 1 });
  const append = f.manager.appendContextEdit;
  f.manager.appendContextEdit = () => { throw new Error("fixture durable edit failure"); };
  try { await f.send({ images: [image(PNG), image(PNG)] }); }
  finally { f.manager.appendContextEdit = append; }
  assert.equal(f.calls.length, 0);
  assert.match(f.session.messages.at(-1).errorMessage, /fixture durable edit failure/);
  assert.equal(images(f.manager.buildSessionProjection().messages).length, 3);
});

for (const kind of ["steer", "follow_up"]) {
  test(`early offload append failure preserves consumed ${kind} ownership and explicit recovery`, { timeout: 10000 }, async t => {
    let f;
    f = await fixture(t, {
      tools: ["pictures"],
      factories: [pi => pi.registerTool({ name: "pictures", label: "pictures", description: "fixture", parameters: Type.Object({}),
        async execute() {
          await f.wrapper.send({ type: kind, message: "owned queued input", images: [image(PNG)] });
          f.manager.appendContextEdit = () => { throw new Error("early append failure"); };
          return { content: [image(PNG), image(PNG)], details: {} };
        },
      })],
      respond: call => call === 1 ? answer([{ type: "toolCall", id: "picture-call", name: "pictures", arguments: {} }], "toolUse") : answer(),
    });
    const append = f.manager.appendContextEdit;
    await f.send({ images: [image(PNG)] });
    assert.equal(f.calls.length, 1);
    assert.match(f.session.messages.at(-1).errorMessage, /early append failure/);
    const owned = () => f.manager.getEntries().filter(e => e.message?.role === "user" && e.message.content.some(b => b.text === "owned queued input"));
    assert.equal(owned().length, 1, "dequeued input must be persisted before failing request preparation");
    assert.deepEqual(images([owned()[0].message]), [image(PNG)]);
    assert.equal(f.session.pendingMessageCount, 0, "no phantom session queue");
    assert.deepEqual(f.session.agent.peekQueuedMessages(), [], "no duplicate executable input");
    const ownerId = owned()[0].id;
    f.manager.appendContextEdit = append;
    await f.send({ message: "explicit recovery" });
    assert.equal(f.calls.length, 2);
    assert.equal(owned().length, 1);
    assert.equal(owned()[0].id, ownerId);
    assert.equal(images(f.calls[1]).length, 2);
    assert.ok(f.calls[1].some(m => m.role === "user" && m.content.some(b => b.text === "owned queued input")));
  });
}

for (const compact of [true, false]) {
  test(`virtual route oversized tool group: compaction=${compact}, route once before definitive budget decision`, { timeout: 10000 }, async t => {
    const routes = [];
    let compactions = 0;
    const f = await fixture(t, {
      tools: ["pictures"],
      settings: { compaction: { enabled: compact, reserveTokens: model.contextWindow - 5000, keepRecentTokens: 0 } },
      virtualRoute: request => { routes.push(request.reason); return { model, thinkingLevel: "off" }; },
      factories: [pi => {
        pi.registerTool({ name: "pictures", label: "pictures", description: "fixture", parameters: Type.Object({}),
          async execute() { return { content: [{ type: "text", text: "large tool result ".repeat(10000) }, image(PNG), image(PNG), image(PNG)], details: {} }; },
        });
        pi.on("session_before_compact", (_event, ctx) => {
          compactions++;
          // Retain no image-bearing entry; a native custom marker supplies the kept boundary.
          const marker = ctx.sessionManager.getBranch().findLast(e => e.type === "custom_message");
          return { compaction: { summary: "text summary", firstKeptEntryId: marker.id, tokensBefore: 100000 } };
        });
        pi.on("turn_end", event => event.toolResults.length ? { entries: [{ type: "custom_message", customType: "kept", content: "continue after summary", display: false }] } : undefined);
      }],
      respond: call => call === 1 ? answer([{ type: "toolCall", id: "picture-call", name: "pictures", arguments: {} }], "toolUse") : answer(),
    });
    await f.send({ images: [image(PNG)] });
    assert.deepEqual(routes, ["user", "continuation"], "one route per attempted request, no re-route for refresh");
    assert.equal(compactions, compact ? 1 : 0);
    assert.equal(f.calls.length, compact ? 2 : 1);
    if (compact) {
      assert.equal(images(f.calls[1]).length, 0);
      assert.equal(f.session.messages.at(-1).stopReason, "stop");
      assert.equal(images(f.manager.buildSessionProjection().messages).length, 0);
    } else assert.match(f.session.messages.at(-1).errorMessage, /image.*budget/i);
    assert.equal(f.manager.getEntries().filter(e => e.type === "context_edit").length, 0, "oversized group is not silently trimmed");
    assert.equal(images(f.manager.getEntries().filter(e => e.type === "message").map(e => e.message)).length, 4);
  });
}

test("post-routing offload refreshes canonical provenance without routing twice", { timeout: 10000 }, async t => {
  let f;
  let routes = 0;
  f = await fixture(t, {
    tools: ["pictures"],
    virtualRoute: () => {
      routes++;
      if (routes === 2) {
        // Public host-manager mutation during asynchronous routing changes which
        // group is newest after the SDK took its initial request snapshot.
        const tool = f.manager.getEntries().find(e => e.message?.role === "toolResult");
        f.manager.appendContextEdit(tool.id, { content: [image(PNG)] });
        f.manager.appendCustomMessageEntry("routed-images", [image(PNG), image(PNG)], true);
      }
      return { model, thinkingLevel: "off", state: { route: routes } };
    },
    factories: [pi => pi.registerTool({ name: "pictures", label: "pictures", description: "fixture", parameters: Type.Object({}),
      async execute() { return { content: [image(PNG), image(PNG), image(PNG)], details: { owner: "tool" } }; },
    })],
    respond: call => call === 1 ? answer([{ type: "toolCall", id: "picture-call", name: "pictures", arguments: {} }], "toolUse") : answer(),
  });
  await f.send({ images: [image(PNG)] });
  assert.equal(routes, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(images(f.calls[1]).length, 2);
  const tool = f.calls[1].find(m => m.role === "toolResult");
  assert.equal(tool.toolCallId, "picture-call");
  assert.deepEqual(tool.details, { owner: "tool" });
  assert.match(tool.content[0].text, /offloaded/);
  const projected = f.manager.buildSessionProjection();
  const custom = projected.entries.find(e => e.sourceEntry.type === "custom_message");
  assert.deepEqual(custom.messages[0].content, [image(PNG), image(PNG)]);
  assert.deepEqual(f.calls[1].at(-1).content, custom.messages[0].content);
  assert.equal(f.session.messages.at(-1).thinkingLevel, "off");
});

for (const outcome of ["cancelled", "failed"]) {
  test(`${outcome} compaction retains legal offload and queued input ownership`, { timeout: 10000 }, async t => {
    let f;
    const failures = [];
    f = await fixture(t, {
      tools: ["pictures"],
      settings: { compaction: { enabled: true, reserveTokens: model.contextWindow - 5000, keepRecentTokens: 0 } },
      factories: [pi => {
        pi.registerTool({ name: "pictures", label: "pictures", description: "fixture", parameters: Type.Object({}),
          async execute() {
            await f.wrapper.send({ type: "steer", message: "queued during tool" });
            return { content: [{ type: "text", text: "large tool result ".repeat(10000) }, image(PNG), image(PNG)], details: {} };
          },
        });
        pi.on("session_before_compact", event => outcome === "cancelled" ? { cancel: true } : {
          compaction: { summary: "fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 100000 },
        });
        pi.on("session_compact_failed", event => { failures.push(event); });
      }],
      respond: call => call === 1 ? answer([{ type: "toolCall", id: "picture-call", name: "pictures", arguments: {} }], "toolUse") : answer(),
    });
    if (outcome === "failed") f.manager.appendCompaction = () => { throw new Error("fixture compaction write failure"); };
    await f.send({ images: [image(PNG)] });
    assert.equal(f.calls.length, 2);
    assert.ok(failures.length > 0);
    assert.equal(failures[0].aborted, outcome === "cancelled");
    if (outcome === "failed") assert.match(failures[0].errorMessage, /fixture compaction write failure/);
    assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, 0);
    assert.equal(f.manager.getEntries().filter(e => e.type === "context_edit").length, 1);
    assert.equal(images(f.calls[1]).length, 2);
    assert.equal(f.session.pendingMessageCount, 0);
    assert.deepEqual(f.session.agent.peekQueuedMessages(), []);
    assert.equal(f.calls[1].filter(m => m.role === "user" && m.content.some(b => b.text === "queued during tool")).length, 1);
    const reopened = SessionManager.open(f.manager.getSessionFile());
    assert.equal(images(reopened.buildSessionProjection().messages).length, 2);
    assert.equal(reopened.getEntries().filter(e => e.type === "context_edit").length, 1);
  });
}

test("first SDK request durably offloads oldest images and preserves the newest entire message", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const oldId = f.manager.appendMessage({ role: "user", content: [{ type: "text", text: "keep text" }, image("AAAAAAAA"), image("BBBB")], timestamp: 1 });
  await f.send({ images: [image(PNG), image(PNG)] });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(images(f.calls[0]).map(b => b.data), [PNG, PNG]);
  assert.equal(images([f.manager.getEntry(oldId).message]).length, 2);
  const edits = f.manager.getEntries().filter(e => e.type === "context_edit");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].targetId, oldId);
  assert.match(JSON.stringify(edits[0].replacement), /offloaded/i);
  const reopened = SessionManager.open(f.manager.getSessionFile());
  assert.deepEqual(images(reopened.buildSessionProjection().messages).map(b => b.data), [PNG, PNG]);
});
