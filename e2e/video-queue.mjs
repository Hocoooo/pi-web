// Real mounted ChatWindow + existing upload handler + actual SDK queues and
// Google final fetch. HTTP/SSE/shell navigation and gateway responses are isolated.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const root = fileURLToPath(new URL("../", import.meta.url)), jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { AgentSessionWrapper } = await jiti.import("../lib/rpc-manager.ts");
const { POST: uploadPost } = await jiti.import("../app/api/files/[...path]/route.ts");
const { POST: agentPost } = await jiti.import("../app/api/agent/[id]/route.ts");
const { buildSessionContext } = await jiti.import("../lib/session-reader.ts");
const { VIDEO_MODEL_ID, VIDEO_GOOGLE_BASE_URL } = await jiti.import("../lib/video-attachments.ts");
const { encodeFilePathForApi } = await jiti.import("../lib/file-paths.ts");
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4z8CAFWEXHbQSACj/P8FTKqelAAAAAElFTkSuQmCC", "base64");
const { outputFiles } = await build({ absWorkingDir: root, bundle: true, write: false, outfile: "video-queue.js", platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  plugins: [{ name: "navigation", setup(build) { build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" })); build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(location.search);" })); } }],
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React,{useRef,useState} from "react"; import {createRoot} from "react-dom/client";
    import {ChatWindow} from "./components/ChatWindow"; import {I18nProvider} from "./hooks/useI18n";
    import {getDraft} from "./lib/draft-store"; window.readDraft=getDraft;
    window.sources=[]; window.emit=(id,event)=>window.sources.forEach(s=>s.id===id&&s.readyState===1&&s.onmessage?.({data:JSON.stringify(event)}));
    window.EventSource=class {readyState=1;constructor(url){this.id=url.split("/")[3];window.sources.push(this);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:"connected"})}));}close(){this.readyState=2;}};
    function App(){const ref=useRef(null);const [target,setTarget]=useState("a");window.switchTo=setTarget;
      return <I18nProvider><ChatWindow key={target} session={window.sessions[target]} chatInputRef={ref} soundEnabled={false}/></I18nProvider>;}
    createRoot(document.getElementById("root")).render(<App/>);
  ` } });
const sandbox = await mkdtemp(join(tmpdir(), "pi-video-queue-ui-")), oldRoots = globalThis.__piAllowedRootsCache, oldFetch = globalThis.fetch;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
let active;
const frame = (text, done = false) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(done ? { finishReason: "STOP" } : {}) }], ...(done ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } } : {}) })}\n\n`;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init); assert.equal(request.url, `${VIDEO_GOOGLE_BASE_URL}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`, "no unexpected network");
  const f = active, body = JSON.parse(await request.text()); f.requests.push(body);
  if (f.requests.length > 1) return new Response(frame("Captured queued answer", true), { headers: { "content-type": "text/event-stream" } });
  return new Response(new ReadableStream({ start(controller) {
    const encoder = new TextEncoder(); controller.enqueue(encoder.encode(frame("Working on previous question")));
    request.signal.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
    f.finish = () => { controller.enqueue(encoder.encode(frame("Previous question finished", true))); controller.close(); };
  } }), { headers: { "content-type": "text/event-stream" } });
};
async function fixture(mobile, transformInput = false, userGate) {
  const dir = await mkdtemp(join(sandbox, "case-")), runtimes = {}, requests = [], prompts = [], errors = [];
  for (const name of ["a", "b"]) {
    const cwd = join(dir, name); await mkdir(cwd);
    const services = await createAgentSessionServices({ cwd, agentDir: join(dir, `agent-${name}`), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off" }), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [
        ...(transformInput ? [pi => pi.on("input", e => e.text === "Keep queued question" ? { action: "transform", text: "Transformed queued question", images: e.images } : undefined)] : []),
        ...(userGate ? [pi => pi.on("message_start", async e => {
          if (e.message.role === "user" && e.message.content[0]?.text === "Keep queued question") { userGate.entered.resolve(); await userGate.release.promise; }
        })] : []),
      ] } });
    services.modelRuntime.registerProvider("tapsvc", { api: "google-generative-ai", baseUrl: VIDEO_GOOGLE_BASE_URL, apiKey: "isolated-video-queue-key", models: [{ id: VIDEO_MODEL_ID, name: "Gemini", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }] });
    const sm = SessionManager.create(cwd, join(dir, `sessions-${name}`));
    const { session } = await createAgentSessionFromServices({ services, model: services.modelRuntime.getModel("tapsvc", VIDEO_MODEL_ID), tools: [], sessionManager: sm });
    const wrapper = new AgentSessionWrapper(session, { headless: true }); (globalThis.__piSessions ??= new Map()).set(wrapper.sessionId, wrapper); wrapper.start(); wrapper.beginExtensionBinding();
    runtimes[name] = { cwd, session, sm, wrapper };
  }
  const { a, b } = runtimes;
  globalThis.__piAllowedRootsCache = { roots: new Set([a.cwd, b.cwd]), expiresAt: Infinity };
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 850 }, locale: "en-US" }); page.setDefaultTimeout(10000);
  page.on("pageerror", e => errors.push(e.message));
  const f = active = { page, a, b, requests, prompts, uploads: 0, failedStateReads: 0, stateReads: [], unknown: null, suppressEvents: false, historyFailure: false, completed: 0 };
  let deliveries = Promise.resolve();
  const offs = Object.values(runtimes).map(r => r.wrapper.onEvent(event => {
    const clientEvent = f.omitQueueInputs && event.type === "queue_update" ? { ...event, inputs: undefined } : event;
    if (!f.suppressEvents) deliveries = deliveries.then(() => page.evaluate(({ id, event }) => window.emit(id, event), { id: r.wrapper.sessionId, event: clientEvent }));
  }));
  await page.addInitScript(sessions => { window.sessions = sessions; window.promptCompletions = 0; const native = window.fetch.bind(window); window.fetch = async (input, init) => {
    const response = await native(input, init); if (init?.method === "POST" && JSON.parse(init.body ?? "{}").type === "prompt") { const json = response.json.bind(response); response.json = async () => { try { return await json(); } finally { window.promptCompletions++; } }; } return response;
  }; }, Object.fromEntries(Object.entries(runtimes).map(([name, r]) => [name, { id: r.wrapper.sessionId, cwd: r.cwd, name: `Fixture ${name}` }])));
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url()), body = req.method() === "POST" && req.headers()["content-type"]?.includes("application/json") ? req.postDataJSON() : null;
    try {
      assert.equal(url.origin, "http://video-queue.test");
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<style>html,body,#root{height:100%;margin:0}.chat-content,.h-full{height:100%}.relative{position:relative}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.min-w-0,fieldset{min-width:0}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}</style><div id="root"></div>' });
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: { [`tapsvc:${VIDEO_MODEL_ID}`]: "Gemini" }, modelList: [{ provider: "tapsvc", id: VIDEO_MODEL_ID, name: "Gemini" }], defaultModel: { provider: "tapsvc", modelId: VIDEO_MODEL_ID }, defaultThinkingLevel: "off" } });
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [] } });
      if (url.pathname === "/api/app-update") return route.fulfill({ json: { updateAvailable: false } });
      if (url.pathname === "/api/tasks/membership") return route.fulfill({ json: { task: null } });
      if (url.pathname === "/_next/image") return route.fulfill({ contentType: "image/png", body: png });
      if (url.pathname.startsWith("/api/files/")) {
        f.uploads++;
        const headers = { ...req.headers(), host: "localhost", origin: "http://localhost" };
        const response = await uploadPost(new NextRequest(`http://localhost${url.pathname}${url.search}`, { method: "POST", headers, body: req.postDataBuffer() }), { params: Promise.resolve({ path: encodeFilePathForApi(a.cwd).split("/") }) });
        return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
      }
      const r = Object.values(runtimes).find(r => url.pathname.includes(r.wrapper.sessionId)); assert(r, `unexpected request ${url.pathname}`);
      if (url.pathname.endsWith("/next-cue")) return route.fulfill({ status: 204 });
      if (body) {
        const outcome = body.type === "prompt" && body.video ? f.unknown : null;
        if (body.type === "prompt") prompts.push({ id: r.wrapper.sessionId, ...body });
        if (body.type === "clear_queue") { f.recalls ??= []; f.recalls.push(body); }
        let response;
        if (outcome !== "none" && !(body.type === "clear_queue" && f.recallOutcome === "none")) response = await agentPost(new Request(`http://localhost${url.pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: r.wrapper.sessionId }) });
        if (body.type === "clear_queue" && f.holdRecall) { f.recallEntered.resolve(); await f.releaseRecall.promise; }
        if (outcome || (body.type === "clear_queue" && f.recallOutcome)) return route.abort("failed");
        return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
      }
      const state = await r.wrapper.send({ type: "get_state" });
      if (url.pathname.startsWith("/api/agent/") || url.pathname.endsWith("/state")) {
        f.stateReads.push(state);
        if (f.stateFailure) { f.failedStateReads++; return route.fulfill({ status: 500, json: { error: "fixture state read failed" } }); }
        const clientState = f.omitQueueInputs ? { ...state, queuedMessages: { ...state.queuedMessages, inputs: undefined } } : state;
        return route.fulfill({ json: { running: true, state: clientState } });
      }
      if (url.pathname === `/api/sessions/${r.wrapper.sessionId}`) {
        if (f.historyFailure) return route.fulfill({ status: 500, json: { error: "fixture authority read failed" } });
        const context = buildSessionContext(r.sm.getEntries(), r.sm.getLeafId());
        const nextHistory = f.nextHistory; f.nextHistory = null;
        if (nextHistory) { nextHistory.entered.resolve(); await nextHistory.release.promise; }
        return route.fulfill({ json: { sessionId: r.wrapper.sessionId, filePath: r.sm.getSessionFile(), tree: [], treeFormat: "summary", leafId: r.sm.getLeafId(), snapshotRevision: String(r.sm.getEntries().length), context: { ...context, oldestEntryId: null, hasMore: false, model: state.model, thinkingLevel: "off" } } });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    } catch (error) { errors.push(error.message); await route.fulfill({ status: 500, json: { error: error.message } }); }
  });
  await page.goto("http://video-queue.test/");
  for (const file of outputFiles) { if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text }); else await page.addScriptTag({ content: file.text }); }
  const input = page.locator("textarea"), card = page.locator("[data-video-attachment]"), queued = page.locator("[data-queued-video]"), saved = page.locator("[data-unconfirmed-submission]");
  const send = page.getByRole("button", { name: "Send", exact: true }), recall = page.getByRole("button", { name: "Recall to input", exact: true });
  await input.waitFor(); await page.getByRole("button", { name: "Gemini", exact: true }).waitFor();
  const ready = () => card.getByText(/Video ready|Not replaced/).waitFor();
  return Object.assign(f, { input, card, queued, saved, send, recall, ready,
    async start() { await input.fill("Previous question"); await send.click(); await page.getByText("Working on previous question", { exact: true }).waitFor(); await page.waitForFunction(() => window.promptCompletions === 1); },
    async prepare(name = "queued.avi", bytes = avi, image = true) {
      await input.fill("Keep queued question");
      if (image) { await page.locator('input[accept="image/*"]').setInputFiles({ name: "pixel.png", buffer: png, mimeType: "image/png" }); await page.locator('img[src^="blob:"]').waitFor(); }
      await page.locator('input[accept=".mp4,.avi"]').setInputFiles({ name, buffer: bytes, mimeType: name.endsWith(".avi") ? "video/x-msvideo" : "video/mp4" }); await ready();
    },
    queue: mode => page.getByRole("button", { name: mode === "steer" ? "Steer" : "Follow-up", exact: true }).click(),
    async stop() { if (mobile) await page.getByRole("button", { name: "More controls", exact: true }).click(); await page.getByRole("button", { name: "Stop", exact: true }).click(); await send.waitFor(); await deliveries; await a.session.waitForIdle(); },
    async settle() { await a.session.waitForIdle(); await deliveries; await send.waitFor(); },
    async switchTo(target) { await page.evaluate(target => window.switchTo(target), target); await input.waitFor(); await page.getByRole("button", { name: "Gemini", exact: true }).waitFor(); },
    async close() { offs.forEach(off => off()); for (const r of Object.values(runtimes)) { await r.wrapper.shutdown(); globalThis.__piSessions.delete(r.wrapper.sessionId); } await deliveries; await page.close(); assert.deepEqual(errors, []); },
  });
}
function videos(body) { return body.contents.flatMap((c, index) => c.parts.filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, text: c.parts.find(p => p.text)?.text, ...p.inlineData }))); }
async function assertDelivered(f, bytes = avi, image = true) {
  await f.page.getByText("Captured queued answer", { exact: true }).waitFor(); await f.settle(); await f.page.locator("[data-sent-video]").waitFor();
  assert.equal(f.requests.length, 2); assert.equal(videos(f.requests[0]).length, 0);
  const media = videos(f.requests[1]); assert.equal(media.length, 1); assert.equal(media[0].text, "Keep queued question"); assert.deepEqual(Buffer.from(media[0].data, "base64"), bytes);
  if (image) assert(f.requests[1].contents[media[0].index].parts.some(p => p.inlineData?.mimeType === "image/png" && p.inlineData.data === png.toString("base64")));
  assert.equal(f.a.sm.getEntries().filter(e => e.message?.piWebVideo).length, 1); assert.equal(await f.input.inputValue(), ""); assert.equal(await f.card.count(), 0); assert.equal(await f.queued.count(), 0);
}
async function assertPngDraft(f, text, count = 1) {
  await f.page.waitForFunction(({ sid, text, count }) => {
    const draft = window.readDraft(sid);
    return draft?.value === text && draft.images.length === count;
  }, { sid: f.a.wrapper.sessionId, text, count });
  const draft = await f.page.evaluate(sid => window.readDraft(sid), f.a.wrapper.sessionId);
  assert.deepEqual(draft, { value: text, images: Array.from({ length: count }, () => ({ data: png.toString("base64"), mimeType: "image/png" })) });
  assert.equal(await f.input.inputValue(), text);
  const previews = await f.page.locator("fieldset img").evaluateAll(nodes => Promise.all(nodes.map(async node => {
    const response = await fetch(node.src), bytes = new Uint8Array(await response.arrayBuffer());
    return { mimeType: response.headers.get("content-type"), data: btoa(String.fromCharCode(...bytes)) };
  })));
  assert.deepEqual(previews, Array.from({ length: count }, () => ({ mimeType: "image/png", data: png.toString("base64") })));
  assert.equal(await f.card.count(), 0); assert.equal(await f.saved.count(), 0);
}
async function assertPngSent(f, text, count = 1) {
  await f.send.click(); await f.page.getByText("Captured queued answer", { exact: true }).waitFor(); await f.settle();
  assert.equal(f.requests.length, 2); assert.equal(videos(f.requests[1]).length, 0);
  const wire = f.requests[1].contents.flatMap(c => c.parts.filter(p => p.inlineData?.mimeType === "image/png").map(p => ({ text: c.parts.find(p => p.text)?.text, ...p.inlineData })));
  assert.equal(wire.length, count);
  for (const image of wire) { assert.equal(image.text, text); assert.deepEqual(Buffer.from(image.data, "base64"), png); }
  const users = f.a.sm.getEntries().filter(e => e.message?.role === "user");
  assert.equal(users.length, 2, "only the original question and explicit restored Send become native users");
  const user = users[1].message; assert.equal(user.piWebVideo, undefined); assert.equal(user.content.find(p => p.type === "text")?.text, text);
  const images = user.content.filter(p => p.type === "image"); assert.equal(images.length, count);
  for (const image of images) assert.deepEqual(Buffer.from(image.data ?? image.source.data, "base64"), png);
  assert.equal(await f.input.inputValue(), ""); assert.equal(await f.page.locator("fieldset img").count(), 0);
  assert.equal(f.a.session.pendingMessageCount, 0); assert.equal(f.prompts.length, 3);
}
const recallFailures = [];
try {
  for (const mobile of [false, true]) {
    const layout = mobile ? "mobile" : "desktop";
    for (const mode of ["steer", "followUp"]) {
      let f = await fixture(mobile);
      try {
        await f.start(); await f.prepare();
        // Real key events in the same event turn exercise composer submission exclusion.
        await f.input.evaluate((ta, { mobile, followUp }) => { for (let n = 0; n < 2; n++) ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ctrlKey: mobile, altKey: followUp })); }, { mobile, followUp: mode === "followUp" });
        await f.queued.waitFor(); await f.page.waitForFunction(() => window.promptCompletions === 2);
        assert.equal(f.prompts.length, 2); assert.equal(f.prompts[1].streamingBehavior, mode); assert.equal(await f.card.count(), 0); assert.equal(await f.queued.textContent(), "🎞 queued.avi");
        assert.equal(f.requests.length, 1); f.finish(); await assertDelivered(f);
        console.log(`PASS ${layout}/${mode}: busy picker + duplicate keyboard send + SDK queue row + correct native owner/PNG/final fetch`);
      } finally { await f.close(); }
      f = await fixture(mobile);
      try {
        await f.start(); await f.prepare(); await f.queue(mode); await f.queued.waitFor();
        await f.recall.click();
        await f.page.getByText("Stop the conversation and wait until it is idle before recalling video questions. No queued input was cleared.", { exact: true }).waitFor();
        assert.equal(f.recalls?.length ?? 0, 0); assert.equal(f.a.session.pendingMessageCount, 1); assert.equal(await f.saved.count(), 0);
        await f.stop();
        assert.equal(f.requests.length, 1); assert.equal(f.a.session.pendingMessageCount, 1); assert.equal(await f.queued.count(), 1);
        await f.recall.evaluate(button => { button.click(); button.click(); });
        await f.ready(); assert.equal(await f.input.inputValue(), "Keep queued question"); assert.equal(await f.queued.count(), 0); assert.equal(await f.page.locator('fieldset img[src^="data:image/"]').count(), 1);
        const path = join(f.a.cwd, "queued.avi"); await unlink(path); await f.send.click();
        await f.page.getByText(/Video file is missing/).waitFor(); await f.ready();
        assert.equal(await f.input.inputValue(), "Keep queued question"); assert.equal(f.requests.length, 1); assert.equal(await f.page.locator('fieldset img[src^="data:image/"]').count(), 1);
        await writeFile(path, avi); await f.send.click(); await assertDelivered(f);
        assert.equal(f.prompts.length, 4, "original, queue, rejected explicit send, repaired explicit send only");
        console.log(`PASS ${layout}/${mode}: Stop retains without resend; duplicate recall restores text/video/PNG once; rejection and explicit repaired retry`);
      } finally { await f.close(); }
      for (const failure of ["missing", "model"]) {
        f = await fixture(mobile);
        try {
          await f.start(); await f.prepare("queued.mp4", mp4, false); await f.queue(mode); await f.queued.waitFor();
          if (failure === "missing") await unlink(join(f.a.cwd, "queued.mp4")); else f.a.session.agent.state.model.provider = "other";
          f.finish(); await f.settle(); await f.page.locator("[data-sent-video]").waitFor();
          await f.page.getByText(failure === "missing" ? /Video file is missing/ : /Video requires tapsvc/).waitFor();
          assert.equal(f.requests.length, 1); assert.equal(f.a.sm.getEntries().filter(e => e.message?.piWebVideo).length, 1); assert.equal(await f.card.count(), 0);
          await writeFile(join(f.a.cwd, "queued.mp4"), mp4); f.a.session.agent.state.model.provider = "tapsvc";
          await f.input.fill("Explicit repair follow-up"); await f.send.click(); await f.page.getByText("Captured queued answer", { exact: true }).waitFor(); await f.settle();
          assert.equal(f.requests.length, 2); assert.deepEqual(Buffer.from(videos(f.requests[1])[0].data, "base64"), mp4); assert.equal(f.a.sm.getEntries().filter(e => e.message?.piWebVideo).length, 1);
          console.log(`PASS ${layout}/${mode}: consume-time ${failure} is a visible error, zero fallback, original reference survives explicit repair`);
        } finally { await f.close(); }
      }
    }
    // Final R2 blocker: successful native PNG-only Recall must restore bytes,
    // including while busy and alongside an ordinary existing composer draft.
    for (const mode of ["steer", "followUp"]) {
      const f = await fixture(mobile);
      try {
        await f.start(); await f.input.fill("PNG queued question");
        await f.page.locator('input[accept="image/*"]').setInputFiles({ name: "queued.png", buffer: png, mimeType: "image/png" });
        await f.page.locator('img[src^="blob:"]').waitFor(); await f.queue(mode);
        await f.page.waitForFunction(() => window.promptCompletions === 2);
        const queued = (await f.a.wrapper.send({ type: "get_state" })).queuedMessages.inputs;
        assert.equal([...queued.steering, ...queued.followUp][0].images[0].data, png.toString("base64"));
        await f.input.fill("Current draft text");
        await f.page.locator('input[accept="image/*"]').setInputFiles({ name: "current.png", buffer: png, mimeType: "image/png" });
        await f.page.locator('img[src^="blob:"]').waitFor();
        await f.recall.click();
        await assertPngDraft(f, "PNG queued question\n\nCurrent draft text", 2);
        assert.equal(f.a.session.isStreaming, true, "ordinary PNG Recall needs no idle or empty composer");
        assert.equal(f.a.session.pendingMessageCount, 0); assert.equal(f.recalls.length, 1);
        assert.deepEqual(f.recalls[0].recallInputs, queued); assert.equal(f.requests.length, 1);
        f.finish(); await f.settle(); await assertPngSent(f, "PNG queued question\n\nCurrent draft text", 2);
        console.log(`PASS ${layout}/${mode}: successful busy PNG-only Recall merges current draft; composer/native/final-fetch bytes survive exactly once`);
      } catch (error) { recallFailures.push(error); console.error(`FAIL ${layout}/${mode}: successful PNG-only Recall`, error); }
      finally { await f.close(); }
    }
    for (const outcome of ["ack", "lost-ack"]) {
      const f = await fixture(mobile);
      try {
        await f.start(); await f.input.fill("Plain queued question"); await f.queue("followUp");
        await f.page.waitForFunction(() => window.promptCompletions === 2);
        const idleRead = f.page.waitForResponse(response => response.request().method() === "GET" && response.url() === `http://video-queue.test/api/agent/${f.a.wrapper.sessionId}`);
        await f.stop(); await idleRead; await f.page.evaluate(() => new Promise(requestAnimationFrame));
        f.suppressEvents = true;
        await f.a.wrapper.send({ type: "steer", message: "Later PNG question", images: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] });
        const actual = (await f.a.wrapper.send({ type: "get_state" })).queuedMessages.inputs;
        if (outcome === "lost-ack") f.recallOutcome = "cleared";
        const refreshed = f.page.waitForResponse(response => response.url().endsWith(`/api/sessions/${f.a.wrapper.sessionId}/state`));
        await f.recall.click(); await refreshed; await f.page.getByText("Later PNG question", { exact: true }).waitFor();
        assert.equal(f.a.session.pendingMessageCount, 2); assert.equal(f.recalls.length, 1);
        assert.deepEqual((await f.a.wrapper.send({ type: "get_state" })).queuedMessages.inputs, actual);
        assert.equal(await f.input.inputValue(), ""); assert.equal(await f.page.locator("fieldset img").count(), 0);
        f.recallOutcome = null; f.suppressEvents = false;
        await f.recall.click(); await assertPngDraft(f, "Later PNG question\n\nPlain queued question");
        assert.deepEqual(f.recalls[1].recallInputs, actual); assert.equal(f.recalls.length, 2);
        assert.equal(f.a.session.pendingMessageCount, 0); assert.equal(f.requests.length, 1); assert.equal(f.prompts.length, 2);
        await assertPngSent(f, "Later PNG question\n\nPlain queued question");
        console.log(`PASS ${layout}: stale PNG-only/${outcome} refuses safely then explicit successful Recall/Send preserves native PNG bytes`);
      } catch (error) { recallFailures.push(error); console.error(`FAIL ${layout}: stale PNG-only/${outcome}`, error); }
      finally { await f.close(); }
    }
    {
      const f = await fixture(mobile);
      try {
        await f.start(); await f.input.fill("PNG capacity question");
        await f.page.locator('input[accept="image/*"]').setInputFiles({ name: "queued.png", buffer: png, mimeType: "image/png" });
        await f.page.locator('img[src^="blob:"]').waitFor(); await f.queue("followUp"); await f.page.waitForFunction(() => window.promptCompletions === 2);
        await f.page.locator('input[accept="image/*"]').setInputFiles(Array.from({ length: 10 }, (_, n) => ({ name: `current-${n}.png`, buffer: png, mimeType: "image/png" })));
        await f.page.waitForFunction(() => document.querySelectorAll('fieldset img[src^="blob:"]').length === 10);
        await f.recall.click();
        await f.page.getByText("The recalled images do not fit the composer. Free image slots before recalling; no queued input was cleared.", { exact: true }).waitFor();
        assert.equal(f.recalls?.length ?? 0, 0); assert.equal(f.a.session.pendingMessageCount, 1);
        assert.equal(await f.page.locator("fieldset img").count(), 10); assert.equal(f.requests.length, 1);
        const removeCurrent = async () => {
          while (await f.page.locator("fieldset img").count()) await f.page.locator("fieldset img").first().locator("../..").getByRole("button").last().click();
        };
        await removeCurrent();
        // Ordinary image Recall does not lock the composer while waiting. If
        // later edits exhaust capacity, retain the returned bytes, never slice.
        f.holdRecall = true; f.recallEntered = Promise.withResolvers(); f.releaseRecall = Promise.withResolvers();
        await f.recall.click(); await f.recallEntered.promise;
        assert.equal(f.a.session.pendingMessageCount, 0); await f.input.fill("Current conflict");
        await f.page.locator('input[accept="image/*"]').setInputFiles(Array.from({ length: 10 }, (_, n) => ({ name: `late-${n}.png`, buffer: png, mimeType: "image/png" })));
        await f.page.waitForFunction(() => document.querySelectorAll("fieldset img").length === 10);
        f.releaseRecall.resolve(); await f.saved.waitFor(); await f.saved.getByText("Saved images: 1", { exact: true }).waitFor();
        assert.equal(await f.input.inputValue(), "Current conflict"); assert.equal(await f.page.locator("fieldset img").count(), 10);
        assert.equal(f.recalls.length, 1); assert.equal(f.requests.length, 1);
        f.finish(); await f.settle(); await removeCurrent(); await f.input.fill("");
        await f.page.getByRole("button", { name: "Check and restore saved input", exact: true }).click();
        await assertPngDraft(f, "PNG capacity question"); await assertPngSent(f, "PNG capacity question");
        assert.equal(f.recalls.length, 1, "explicit restore reads authority without repeating the successful clear");
        console.log(`PASS ${layout}: PNG capacity refuses before clear; late capacity conflict preserves both drafts; explicit restore/Send keeps all bytes`);
      } catch (error) { recallFailures.push(error); console.error(`FAIL ${layout}: PNG Recall capacity`, error); }
      finally { f.releaseRecall?.resolve(); await f.close(); }
    }
    {
      const f = await fixture(mobile);
      try {
        await f.start(); await f.input.fill("Plain queued question"); await f.queue("followUp");
        await f.page.waitForFunction(() => window.promptCompletions === 2); await f.input.fill("Current plain text");
        await f.recall.click(); await f.page.waitForFunction(() => document.querySelector("textarea").value === "Plain queued question\n\nCurrent plain text");
        assert.equal(f.a.session.isStreaming, true); assert.equal(f.a.session.pendingMessageCount, 0);
        assert.equal(await f.page.locator("fieldset img").count(), 0); assert.equal(await f.saved.count(), 0);
        f.finish(); await f.settle(); await f.send.click(); await f.page.getByText("Captured queued answer", { exact: true }).waitFor(); await f.settle();
        assert.equal(f.requests.length, 2); assert.equal(f.prompts.length, 3);
        assert.equal(f.requests[1].contents.at(-1).parts.find(p => p.text)?.text, "Plain queued question\n\nCurrent plain text");
        assert.equal(f.requests[1].contents.flatMap(c => c.parts).filter(p => p.inlineData).length, 0);
        console.log(`PASS ${layout}: ordinary busy text Recall still prepends existing text and sends once without media`);
      } catch (error) { recallFailures.push(error); console.error(`FAIL ${layout}: ordinary text Recall`, error); }
      finally { await f.close(); }
    }
    // R2 re-review: client sees only plain work while the real SDK gains media.
    for (const outcome of ["ack", "lost-ack", "missing-inputs"]) {
      const f = await fixture(mobile);
      try {
        await f.start(); f.omitQueueInputs = outcome === "missing-inputs";
        await f.input.fill("Plain queued question"); await f.queue("followUp");
        await f.page.waitForFunction(() => window.promptCompletions === 2);
        const idleRead = f.page.waitForResponse(response => response.request().method() === "GET" && response.url() === `http://video-queue.test/api/agent/${f.a.wrapper.sessionId}`);
        await f.stop(); await idleRead; await f.page.evaluate(() => new Promise(requestAnimationFrame));
        f.suppressEvents = true;
        const path = join(f.a.cwd, "later.avi"); await writeFile(path, avi);
        await f.a.wrapper.send({ type: "steer", message: "Later video question", images: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], video: { version: 1, path, mimeType: "video/avi" } });
        const actual = (await f.a.wrapper.send({ type: "get_state" })).queuedMessages.inputs;
        assert.equal(f.a.session.pendingMessageCount, 2); assert.equal(await f.queued.count(), 0, "late SDK media has not reached the client summary");
        if (outcome === "lost-ack") f.recallOutcome = "cleared"; // Drop the actual handler's refusal ACK, not its execution.
        const omittedRefresh = outcome === "missing-inputs" ? f.page.waitForResponse(response => response.url().endsWith(`/api/sessions/${f.a.wrapper.sessionId}/state`)) : null;
        await f.recall.click();
        if (outcome === "missing-inputs") {
          await f.page.getByText("Queue details are not available. Nothing was cleared; check the refreshed queue before recalling again.", { exact: true }).waitFor();
          assert.equal(f.recalls?.length ?? 0, 0, "incomplete inputs cannot authorize clear");
          await omittedRefresh; await f.page.evaluate(() => new Promise(requestAnimationFrame));
          // The first read also lacks media detail. Re-enable full authority;
          // a second user click only refreshes, it must still not clear.
          f.omitQueueInputs = false; await f.recall.click();
        }
        await f.queued.waitFor();
        assert.equal(f.a.session.pendingMessageCount, 2, "unseen video/PNG must remain in the sole SDK queue even when the ACK is lost");
        assert.equal(f.a.sm.getEntries().filter(e => e.message?.piWebVideo).length, 0);
        assert.equal(await f.input.inputValue(), ""); assert.equal(await f.card.count(), 0); assert.equal(await f.saved.count(), 0);
        const before = f.recalls?.length ?? 0;
        assert.equal(before, outcome === "missing-inputs" ? 0 : 1);
        if (before) assert.deepEqual(f.recalls[0].recallInputs, { steering: [], followUp: [{ text: "Plain queued question", images: [] }] });
        assert.deepEqual((await f.a.wrapper.send({ type: "get_state" })).queuedMessages.inputs, actual);
        f.recallOutcome = null; f.suppressEvents = false;
        await f.recall.click(); await f.ready();
        assert.equal(f.recalls.length, before + 1, "only a new explicit Recall clears the refreshed full inputs");
        assert.equal(await f.input.inputValue(), "Later video question\n\nPlain queued question");
        assert((await f.card.textContent()).includes("later.avi"));
        assert.equal(await f.page.locator('fieldset img[src^="data:image/"]').count(), 1);
        assert.equal(f.a.session.pendingMessageCount, 0); assert.equal(f.requests.length, 1); assert.equal(f.prompts.length, 2);
        await f.send.click(); await f.page.getByText("Captured queued answer", { exact: true }).waitFor(); await f.settle();
        assert.equal(f.requests.length, 2); assert.equal(f.prompts.length, 3);
        const media = videos(f.requests[1]); assert.equal(media.length, 1); assert.deepEqual(Buffer.from(media[0].data, "base64"), avi);
        assert.equal(media[0].text, "Later video question\n\nPlain queued question");
        assert(f.requests[1].contents[media[0].index].parts.some(p => p.inlineData?.mimeType === "image/png" && p.inlineData.data === png.toString("base64")));
        assert.equal(f.a.sm.getEntries().filter(e => e.message?.piWebVideo).length, 1);
        console.log(`PASS ${layout}: stale plain Recall/${outcome} keeps unseen SDK video/PNG; refresh then explicit Recall/Send restores native bytes once`);
      } catch (error) { recallFailures.push(error); console.error(`FAIL ${layout}: stale plain Recall/${outcome}`, error); }
      finally { await f.close(); }
    }
    // R2: the destructive handler may or may not have run when its ACK is lost.
    for (const outcome of ["none", "cleared"]) {
      const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      const f = await fixture(mobile, false, gate);
      try {
        await f.start(); await f.prepare(); await f.queue("followUp"); await f.queued.waitFor(); await f.stop();
        const original = (await f.a.wrapper.send({ type: "get_state" })).queuedMessages.inputs.followUp[0];
        f.recallOutcome = outcome;
        await f.recall.click(); await f.saved.waitFor();
        assert.equal(f.a.session.pendingMessageCount, outcome === "none" ? 1 : 0);
        assert.equal(await f.input.inputValue(), ""); assert.equal(await f.card.count(), 0);
        assert((await f.saved.textContent()).includes("Keep queued question")); assert((await f.saved.textContent()).includes(original.video.path));
        await f.saved.getByText("Saved images: 1", { exact: true }).waitFor();
        const restore = f.page.getByRole("button", { name: "Check and restore saved input", exact: true });
        f.historyFailure = true; await restore.click(); await f.saved.getByRole("alert").waitFor();
        assert.equal(await f.saved.count(), 1); assert.equal(f.recalls.length, 1);
        await f.page.waitForFunction(() => document.querySelector("[data-unconfirmed-submission] button")?.disabled === false);
        f.historyFailure = false; f.stateFailure = true; await restore.click();
        await f.page.getByText("The send is still unconfirmed or the conversation is busy. The saved input has been kept; nothing was resent.", { exact: true }).last().waitFor();
        await f.page.waitForFunction(() => document.querySelector("[data-unconfirmed-submission] button")?.disabled === false);
        assert.equal(await f.saved.count(), 1); assert.equal(await f.card.count(), 0);
        assert(f.failedStateReads >= 1, "the failed authoritative state read really executed");
        f.stateFailure = false;
        if (outcome === "none") {
          await restore.click();
          await f.page.getByText("The saved video question is still queued. The saved input was kept; nothing was cleared, restored or resent.", { exact: true }).waitFor();
          assert.equal(await f.saved.count(), 1); assert.equal(await f.input.inputValue(), ""); assert.equal(f.a.session.pendingMessageCount, 1);
          // A later input is not permission to retry the old destructive clear.
          await f.a.wrapper.send({ type: "steer", message: "Later question" }); await f.page.getByText("Later question", { exact: true }).waitFor();
          await f.recall.click(); assert.equal(f.recalls.length, 1); assert.equal(f.a.session.pendingMessageCount, 2);
          f.suppressEvents = true;
          await f.a.wrapper.send({ type: "prompt", message: "Explicitly consume retained queue" }); await gate.entered.promise;
          await restore.click();
          await f.page.getByText("The send is still unconfirmed or the conversation is busy. The saved input has been kept; nothing was resent.", { exact: true }).last().waitFor();
          await f.page.waitForFunction(() => document.querySelector("[data-unconfirmed-submission] button")?.disabled === false);
          assert.equal(f.stateReads.at(-1).isStreaming, true, "real SDK extension await is still busy at the authoritative recheck");
          assert.equal(await f.saved.count(), 1); assert.equal(await f.card.count(), 0);
          // Capture history before the user is appended, then finish the real
          // run before /state. A stale history + fresh idle state is not absence.
          f.heldHistory = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; f.nextHistory = f.heldHistory;
          await restore.click(); await f.heldHistory.entered.promise;
          gate.release.resolve(); await f.a.session.waitForIdle();
          assert.equal(f.a.sm.getEntries().filter(e => e.message?.piWebVideo?.id === original.video.id).length, 1);
          f.heldHistory.release.resolve(); await f.page.waitForFunction(() => !document.querySelector("[data-unconfirmed-submission]"));
          assert.equal(await f.card.count(), 0); assert.equal(await f.input.inputValue(), ""); assert.equal(f.recalls.length, 1);
        } else {
          await restore.click(); await f.ready();
          assert.equal(await f.saved.count(), 0); assert.equal(await f.input.inputValue(), "Keep queued question");
          assert.equal(await f.page.locator('fieldset img[src^="data:image/"]').count(), 1);
          assert.equal(f.recalls.length, 1); assert.equal(f.prompts.length, 2); assert.equal(f.requests.length, 1);
          gate.release.resolve(); await f.send.click(); await assertDelivered(f);
        }
        console.log(`PASS ${layout}: Recall ACK lost/${outcome} retains text/PNG/video; authority failures keep snapshot; known UUID prevents duplicate/clear retry`);
      } catch (error) { recallFailures.push(error); console.error(`FAIL ${layout}: Recall ACK lost/${outcome}`, error); }
      finally { gate.release.resolve(); f.heldHistory?.release.resolve(); await f.close(); }
    }
    // R3: hold the actual successful clear response while real DOM controls race it.
    {
      const f = await fixture(mobile);
      try {
        await f.start(); await f.prepare(); await f.queue("followUp"); await f.queued.waitFor(); await f.stop();
        f.holdRecall = true; f.recallEntered = Promise.withResolvers(); f.releaseRecall = Promise.withResolvers();
        await f.recall.click(); await f.recallEntered.promise;
        assert.equal(f.a.session.pendingMessageCount, 0, "actual handler cleared before its held ACK");
        assert.equal(await f.input.isDisabled(), true, "pending Recall locks text editing");
        assert.equal(await f.page.getByRole("button", { name: "Attach video (MP4/AVI)", exact: true }).isDisabled(), true);
        // File input change and ChatWindow DOM drop both exercise the actual picker boundary.
        await f.page.locator('input[accept=".mp4,.avi"]').setInputFiles({ name: "new.mp4", buffer: mp4, mimeType: "video/mp4" });
        await f.page.locator(".chat-content").evaluate((node, bytes) => {
          const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], "drop.mp4", { type: "video/mp4" }));
          dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "new-image.png", { type: "image/png" }));
          node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        }, [...mp4]);
        await f.input.evaluate(ta => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ctrlKey: true })));
        assert.equal(await f.card.count(), 0); assert.equal(f.prompts.length, 2);
        f.releaseRecall.resolve(); await f.ready();
        assert.equal(await f.input.inputValue(), "Keep queued question"); assert((await f.card.textContent()).includes("queued.avi"));
        assert.equal(await f.page.locator('fieldset img[src^="data:image/"]').count(), 1); assert.equal(await f.saved.count(), 0);
        assert.equal(f.uploads, 1, "neither pending chooser nor DOM drop started another upload");
        assert.equal(await f.input.isDisabled(), false); await f.send.click(); await assertDelivered(f);
        console.log(`PASS ${layout}: pending Recall gates chooser/drop/text/keyboard; original AVI+question+PNG restore once without a new-video merge`);
      } catch (error) { recallFailures.push(error); console.error(`FAIL ${layout}: pending Recall race`, error); }
      finally { f.releaseRecall?.resolve(); await f.close(); }
    }
    for (const outcome of ["none", "queued"]) {
      const f = await fixture(mobile);
      try {
        await f.start(); await f.prepare(); f.unknown = outcome; f.suppressEvents = true;
        await f.queue("followUp");
        if (outcome === "none") { await f.saved.waitFor(); f.suppressEvents = false; await f.stop();
          f.historyFailure = true; await f.page.getByRole("button", { name: "Check and restore saved input", exact: true }).click(); await f.saved.getByRole("alert").waitFor(); assert.equal(await f.saved.count(), 1);
          f.historyFailure = false; await f.page.getByRole("button", { name: "Check and restore saved input", exact: true }).click(); await f.ready(); assert.equal(await f.input.inputValue(), "Keep queued question"); assert.equal(f.prompts.length, 2);
          f.unknown = null; await f.send.click(); await assertDelivered(f);
        } else { await f.queued.waitFor(); await f.page.waitForFunction(() => !document.querySelector("[data-unconfirmed-submission]")); assert.equal(await f.card.count(), 0); assert.equal(f.requests.length, 1); f.suppressEvents = false; await f.stop();
          assert.equal(f.a.session.pendingMessageCount, 1); assert.equal(f.prompts.length, 2, "authoritative queue confirms reception without resend");
        }
        console.log(`PASS ${layout}: unknown ${outcome} uses 03 snapshot + authoritative queue/history check, never automatic restore/resend`);
      } finally { await f.close(); }
    }
    {
      const f = await fixture(mobile, true);
      try {
        await f.start(); await f.prepare(); f.unknown = "queued"; f.suppressEvents = true;
        await f.queue("followUp"); await f.saved.waitFor(); await f.queued.waitFor();
        f.suppressEvents = false; await f.stop();
        await f.page.getByRole("button", { name: "Check and restore saved input", exact: true }).click();
        await f.page.getByText("A matching video question may have been transformed and received. The saved input was kept for inspection, not restored or resent.", { exact: true }).waitFor();
        assert.equal(await f.saved.count(), 1); assert.equal(await f.card.count(), 0); assert.equal(await f.input.inputValue(), "");
        assert.equal(f.a.session.pendingMessageCount, 1); assert.equal(f.prompts.length, 2); assert.equal(f.requests.length, 1);
        console.log(`PASS ${layout}: unknown transformed owner remains inconclusive; no duplicate restore or text-only fallback`);
      } finally { await f.close(); }
    }
    const f = await fixture(mobile);
    try {
      await f.start(); await f.prepare(); await f.queue("followUp"); await f.queued.waitFor(); await f.switchTo("b");
      await f.input.fill("Other conversation question"); await f.send.click(); await f.page.getByText("Captured queued answer", { exact: true }).waitFor();
      assert.equal(videos(f.requests[1]).length, 0); assert.equal(await f.page.locator("[data-sent-video]").count(), 0); assert.equal(await f.queued.count(), 0);
      f.finish(); await f.a.session.waitForIdle(); assert.equal(videos(f.requests[2]).length, 1); assert.equal(f.b.sm.getEntries().some(e => e.message?.piWebVideo), false);
      await f.switchTo("a"); await f.page.locator("[data-sent-video]").waitFor(); assert.equal(f.a.sm.getEntries().filter(e => e.message?.piWebVideo).length, 1);
      console.log(`PASS ${layout}: queued owner cannot enter another conversation; source history restores after consumption`);
    } finally { await f.close(); }
  }
  assert.equal(recallFailures.length, 0, "all Recall race/response-loss regressions must pass");
} finally { await browser.close(); globalThis.fetch = oldFetch; globalThis.__piAllowedRootsCache = oldRoots; await rm(sandbox, { recursive: true, force: true }); }
