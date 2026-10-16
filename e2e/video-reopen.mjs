// Ticket 04: real native JSONL -> actual session GET -> mounted ChatWindow ->
// cold SDK reopen -> native Google final fetch. Browser HTTP/SSE transport and
// the final synthetic gateway response are fixtures, not paid network evidence.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { AgentSessionWrapper } = await jiti.import("../lib/rpc-manager.ts");
const { GET: sessionGet } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { cacheSessionPath, invalidateSessionPathCache, invalidateSessionManagerCache } = await jiti.import("../lib/session-reader.ts");
const { VIDEO_MODEL_ID, VIDEO_GOOGLE_BASE_URL, MAX_VIDEO_REQUEST_BYTES } = await jiti.import("../lib/video-attachments.ts");
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4z8CAFWEXHbQSACj/P8FTKqelAAAAAElFTkSuQmCC", "base64");
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "video-reopen.js", platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  plugins: [{ name: "url-context", setup(build) {
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "url-context" }));
    build.onLoad({ filter: /.*/, namespace: "url-context" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(location.search);" }));
  } }],
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";
    import {createRoot} from "react-dom/client";
    import {ChatWindow} from "./components/ChatWindow";
    import {I18nProvider} from "./hooks/useI18n";
    window.sources = [];
    window.emit = event => window.sources.forEach(s => s.readyState === 1 && s.onmessage?.({data:JSON.stringify(event)}));
    window.EventSource = class {
      readyState = 1;
      constructor() { window.sources.push(this); queueMicrotask(() => this.onmessage?.({data:JSON.stringify({type:"connected"})})); }
      close() { this.readyState = 2; }
    };
    createRoot(document.getElementById("root")).render(<I18nProvider><ChatWindow
      session={window.sessionInfo} newSessionCwd={window.sessionInfo.cwd}
      newSessionDraftKey={null} soundEnabled={false} /></I18nProvider>);
  ` },
});
const js = outputFiles.find(f => f.path.endsWith(".js")).text;
const css = outputFiles.find(f => f.path.endsWith(".css"))?.text ?? "";
const html = `<style>
  html,body,#root{height:100%;margin:0} .chat-content{height:100%;display:flex;flex-direction:column}
  .flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.shrink-0{flex-shrink:0}
  .relative{position:relative}.absolute{position:absolute}.fixed{position:fixed}
  .overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}.min-h-0{min-height:0}
  fieldset{min-width:0}
</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script defer src="/fixture.js"></script>`;
const sandbox = await mkdtemp(join(tmpdir(), "pi-web-video-reopen-"));
const oldRoots = globalThis.__piAllowedRootsCache, oldFetch = globalThis.fetch;
let active;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, `${VIDEO_GOOGLE_BASE_URL}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`, "no unexpected network");
  assert.equal(request.headers.get("authorization"), "Bearer isolated-video-reopen-key");
  const raw = await request.text();
  active.requests.push({ body: JSON.parse(raw), bytes: Buffer.byteLength(raw) });
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `Captured answer ${active.requests.length}` }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });

async function fixture(viewport) {
  const dir = await mkdtemp(join(sandbox, "case-")), cwd = join(dir, "workspace");
  await mkdir(cwd);
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Infinity };
  const f = active = { requests: [], prompts: [], history: [], runtimeBuilds: 0 };
  let runtime, file, sessionId, page, offEvents, deliveries = Promise.resolve();
  async function openRuntime() {
    assert.equal(runtime, undefined, "never open two native writers");
    const services = await createAgentSessionServices({ cwd, agentDir: join(dir, "agent"),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
    });
    services.modelRuntime.registerProvider("tapsvc", { api: "anthropic-messages", baseUrl: "https://llm-proxy.tapsvc.com", apiKey: "isolated-video-reopen-key",
      models: [{ id: VIDEO_MODEL_ID, name: "Gemini", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    });
    const sm = file ? SessionManager.open(file) : SessionManager.create(cwd, join(dir, "sessions"));
    const { session } = await createAgentSessionFromServices({ services, model: services.modelRuntime.getModel("tapsvc", VIDEO_MODEL_ID), thinkingLevel: "high", tools: [], sessionManager: sm });
    const wrapper = new AgentSessionWrapper(session, { headless: true });
    runtime = { session, sm, wrapper };
    file = sm.getSessionFile(); sessionId = wrapper.sessionId; f.runtimeBuilds++;
    // Cache only native ID -> path for the actual GET, never an owner/media map.
    cacheSessionPath(sessionId, file);
    offEvents = wrapper.onEvent(event => {
      if (page) deliveries = deliveries.then(() => page.evaluate(event => window.emit(event), event));
    });
    wrapper.start(); wrapper.beginExtensionBinding();
    return runtime;
  }
  async function send(command) {
    const { wrapper } = runtime ?? await openRuntime();
    const done = Promise.withResolvers();
    const off = wrapper.onEvent(event => { if (event.type === "prompt_done") done.resolve(); });
    try { await wrapper.send(command); await done.promise; await deliveries; }
    finally { off(); }
  }
  async function sleepRuntime() {
    await deliveries;
    offEvents?.(); offEvents = undefined;
    await runtime?.wrapper.shutdown();
    assert.equal(runtime?.wrapper.isAlive(), false);
    runtime = undefined;
    invalidateSessionManagerCache(file);
  }
  // Seed through ordinary native wrapper prompts, not hand-authored history or
  // browser response metadata. Upload/picker coverage belongs to 01/02.
  await openRuntime();
  const refs = [
    { version: 1, path: join(cwd, "first.mp4"), mimeType: "video/mp4" },
    { version: 1, path: join(cwd, "second.avi"), mimeType: "video/avi" },
  ];
  await writeFile(refs[0].path, mp4); await writeFile(refs[1].path, avi);
  await send({ type: "prompt", message: "Describe first clip", videos: [refs[0]], images: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] });
  await send({ type: "prompt", message: "Describe second clip", videos: [refs[1]] });
  const originals = runtime.sm.getEntries().filter(e => e.message?.piWebVideos);
  assert.equal(originals.length, 2);
  const savedRefs = structuredClone(originals.map(e => e.message.piWebVideos));
  assert.notEqual(savedRefs[0][0].id, savedRefs[1][0].id);
  await sleepRuntime();
  async function routeRequest(route) {
    const req = route.request(), url = new URL(req.url());
    try {
      assert.equal(url.origin, "http://video-reopen.test", "browser must not make external requests");
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: js });
      if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
      if (url.pathname === "/_next/image") return route.fulfill({ contentType: "image/png", body: png });
      const body = req.method() === "POST" ? req.postDataJSON() : null;
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: { [`tapsvc:${VIDEO_MODEL_ID}`]: "Gemini" }, modelList: [{ provider: "tapsvc", id: VIDEO_MODEL_ID, name: "Gemini" }], defaultModel: { provider: "tapsvc", modelId: VIDEO_MODEL_ID }, defaultThinkingLevel: "high" } });
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [] } });
      if (url.pathname === "/api/tasks/membership") return route.fulfill({ json: { task: null } });
      if (url.pathname === `/api/sessions/${sessionId}/next-cue` && req.method() === "POST") return route.fulfill({ status: 204 });
      if (url.pathname === `/api/sessions/${sessionId}` && req.method() === "GET") {
        const result = await sessionGet(new Request(`http://localhost${url.pathname}${url.search}`), { params: Promise.resolve({ id: sessionId }) });
        assert.equal(result.status, 200);
        const data = await result.json(); f.history.push(data);
        return route.fulfill({ json: data });
      }
      if (url.pathname === `/api/sessions/${sessionId}/state` || (url.pathname === `/api/agent/${sessionId}` && !body)) {
        return route.fulfill({ json: runtime ? { running: true, state: await runtime.wrapper.send({ type: "get_state" }) } : { running: false } });
      }
      if (url.pathname === `/api/agent/${sessionId}` && body) {
        if (body.type === "prompt") {
          assert.equal(body.videos, undefined, "follow-up needs no re-upload or new explicit videos field");
          f.prompts.push(body);
          await send(body);
          return route.fulfill({ json: { success: true, data: {} } });
        }
        assert(runtime, `unexpected cold command ${body.type}`);
        return route.fulfill({ json: { success: true, data: await runtime.wrapper.send(body) } });
      }
      throw new Error(`Unexpected fixture request ${req.method()} ${url.pathname}`);
    } catch (error) {
      f.errors.push(error.message);
      await route.fulfill({ status: 500, json: { error: error.message } });
    }
  }
  f.errors = [];
  async function openPage() {
    assert(!page, "close old document before reopening");
    page = await browser.newPage({ viewport, locale: "en-US" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => f.errors.push(error.message));
    await page.addInitScript(info => { window.sessionInfo = info; }, { id: sessionId, cwd, name: "Durable video fixture" });
    await page.route("**/*", routeRequest);
    await page.goto(`http://video-reopen.test/?session=${sessionId}`);
    await restored();
  }
  async function restored() {
    await page.locator("[data-sent-video]").nth(1).waitFor();
    await page.getByRole("button", { name: "Gemini", exact: true }).waitFor();
    assert.equal(await page.locator("[data-sent-video]").count(), 2);
    for (let i = 0; i < 2; i++) {
      const card = page.locator("[data-sent-video]").nth(i);
      assert.equal(await card.getAttribute("title"), refs[i].path);
      assert.match(await card.textContent(), new RegExp(i === 0 ? "first\\.mp4.*video/mp4" : "second\\.avi.*video/avi"));
      assert((await card.textContent()).includes(refs[i].path));
    }
    assert.equal(await page.locator("[data-video-attachment]").count(), 0, "sent references are not unsent draft attachments");
    assert.equal(await page.locator("textarea").inputValue(), "");
    assert.equal(await page.locator('img[src^="data:image/png"]').count(), 1, "persisted image still restores beside the native video reference");
    const history = f.history.at(-1);
    assert.deepEqual(history.context.messages.filter(m => m.piWebVideos).map(m => m.piWebVideos), savedRefs);
    assert.deepEqual(history.context.messages.flatMap((m, i) => m.piWebVideos ? [history.context.entryIds[i]] : []), originals.map(e => e.id));
  }
  async function ask(message, error = false) {
    const count = f.prompts.length, answerNumber = f.requests.length + 1;
    const response = page.waitForResponse(r => r.request().method() === "POST" && r.request().postDataJSON()?.type === "prompt");
    await page.locator("textarea").fill(message);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    assert.equal((await response).status(), 200);
    if (error) await page.getByText(/Video file is missing or outside/).first().waitFor();
    else await page.getByText(`Captured answer ${answerNumber}`, { exact: true }).waitFor();
    await deliveries;
    assert.equal(f.prompts.length, count + 1);
    assert.equal(await page.locator("[data-sent-video]").count(), 2);
    assert.equal(await page.locator("[data-video-attachment]").count(), 0);
    assert.equal(await page.locator("textarea").inputValue(), "");
  }
  function assertWire(firstBytes = mp4) {
    const request = f.requests.at(-1), contents = request.body.contents;
    const parts = contents.flatMap((c, index) => c.parts.filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, role: c.role, ...p.inlineData })));
    assert.deepEqual(parts.map(p => [p.index, p.role, p.mimeType]), [[0, "user", "video/mp4"], [2, "user", "video/avi"]]);
    assert.deepEqual(Buffer.from(parts[0].data, "base64"), firstBytes);
    assert.deepEqual(Buffer.from(parts[1].data, "base64"), avi);
    assert.equal(contents[0].parts[0].text, "Describe first clip");
    assert.equal(contents[2].parts[0].text, "Describe second clip");
    assert(!contents.at(-1).parts.some(p => p.inlineData));
    assert.deepEqual(Buffer.from(contents[0].parts.find(p => p.inlineData?.mimeType === "image/png").inlineData.data, "base64"), png);
    assert(request.bytes < MAX_VIDEO_REQUEST_BYTES);
    assert.deepEqual(runtime.sm.getEntries().filter(e => e.message?.piWebVideos).map(e => e.message.piWebVideos), savedRefs);
  }
  return { ...f, refs, savedRefs, requests: f.requests, get runtimeBuilds() { return f.runtimeBuilds; },
    get page() { return page; }, openPage, restored, ask, sleepRuntime, assertWire,
    async closePage() { await deliveries; await page.close(); page = undefined; },
    assertSleeping() { assert.equal(runtime, undefined); },
    async close() {
      offEvents?.(); await runtime?.wrapper.shutdown(); await deliveries;
      await page?.close(); invalidateSessionManagerCache(file); invalidateSessionPathCache(sessionId);
      assert.deepEqual(f.errors, []);
    },
  };
}

try {
  for (const viewport of [{ width: 1100, height: 850 }, { width: 390, height: 844 }]) {
    const f = await fixture(viewport), layout = viewport.width === 390 ? "mobile" : "desktop";
    try {
      await f.openPage();
      f.assertSleeping(); assert.equal(f.runtimeBuilds, 1); assert.equal(f.prompts.length, 0); assert.equal(f.requests.length, 2);
      await f.ask("Follow up on both clips; /not-authorized/missing.mp4 is text only");
      assert.equal(f.runtimeBuilds, 2); assert.equal(f.requests.length, 3); f.assertWire();
      console.log(`PASS ${layout}: native disk history GET restores two owners/image; cold ordinary follow-up sends both`);

      await f.sleepRuntime();
      const changed = Buffer.concat([mp4, Buffer.from("current file after browser refresh")]);
      await writeFile(f.refs[0].path, changed);
      await f.page.reload(); await f.restored();
      f.assertSleeping(); assert.equal(f.runtimeBuilds, 2); assert.equal(f.requests.length, 3);
      await f.ask("After refresh, compare the current files again");
      assert.equal(f.runtimeBuilds, 3); assert.equal(f.requests.length, 4); f.assertWire(changed);
      console.log(`PASS ${layout}: full document reload + disposed runtime preserve references and transmit modified current bytes`);

      await f.sleepRuntime(); await f.closePage();
      await unlink(f.refs[0].path);
      await f.openPage();
      f.assertSleeping(); assert.equal(f.runtimeBuilds, 3); assert.equal(f.requests.length, 4);
      await f.ask("Reopened conversation: compare both, even though the old file is now missing", true);
      assert.equal(f.runtimeBuilds, 4); assert.equal(f.requests.length, 4, "missing old video cannot degrade to new-video/text-only fetch");
      console.log(`PASS ${layout}: fresh page + cold reopen retain both historical references; missing older file surfaces terminal error, zero fetch`);

      await writeFile(f.refs[0].path, changed);
      await f.ask("Explicit follow-up after restoring the file");
      assert.equal(f.runtimeBuilds, 4); assert.equal(f.requests.length, 5); f.assertWire(changed);
      console.log(`PASS ${layout}: only an explicit follow-up after repair sends both owners again, with original image bytes`);
    } finally { await f.close(); }
  }
} finally {
  await browser.close(); globalThis.fetch = oldFetch; globalThis.__piAllowedRootsCache = oldRoots;
  await rm(sandbox, { recursive: true, force: true });
}
