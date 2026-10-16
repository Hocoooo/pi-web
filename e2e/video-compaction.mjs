// Tickets 05/09: chooser/drop -> upload/SDK -> cold follow-up -> actual manual/
// automatic compaction/history GET -> picker reattachment -> final Google fetch.
// Only browser HTTP/SSE and gateway answers are fixtures; no SDK compaction hooks.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { AgentSessionWrapper } = await jiti.import("../lib/rpc-manager.ts");
const { GET: sessionGet } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { GET: contextGet } = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const { POST: uploadPost } = await jiti.import("../app/api/files/[...path]/route.ts");
const { cacheSessionPath, invalidateSessionPathCache, invalidateSessionManagerCache } = await jiti.import("../lib/session-reader.ts");
const { encodeFilePathForApi } = await jiti.import("../lib/file-paths.ts");
const { VIDEO_MODEL_ID, VIDEO_GOOGLE_BASE_URL } = await jiti.import("../lib/video-attachments.ts");
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "video-compaction.js", platform: "browser", format: "iife", jsx: "automatic",
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
html,body,#root{height:100%;margin:0}.chat-content{height:100%;display:flex;flex-direction:column}
.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.shrink-0{flex-shrink:0}
.relative{position:relative}.absolute{position:absolute}.fixed{position:fixed}
.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}.min-h-0{min-height:0}fieldset{min-width:0}
</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script defer src="/fixture.js"></script>`;
const sandbox = await mkdtemp(join(tmpdir(), "pi-web-video-compaction-"));
const oldRoots = globalThis.__piAllowedRootsCache, oldFetch = globalThis.fetch;
let active;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, `${VIDEO_GOOGLE_BASE_URL}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`, "no unexpected network");
  const raw = await request.text(), body = JSON.parse(raw);
  active.requests.push({ body, headers: request.headers });
  const summary = body.contents.some(c => c.parts.some(p => p.text?.includes("<conversation>")));
  const high = !summary && active.highNext;
  if (high) active.highNext = false;
  const text = summary ? active.summary : `Captured answer ${active.requests.length}`;
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: high ? 995000 : 10, candidatesTokenCount: 3, totalTokenCount: high ? 995003 : 13 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
function media(request) {
  return request.body.contents.flatMap((c, index) => c.parts.filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, role: c.role, ...p.inlineData })));
}
async function fixture(mode, viewport) {
  const dir = await mkdtemp(join(sandbox, "case-")), cwd = join(dir, "workspace");
  await mkdir(cwd);
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Infinity };
  const refs = [{ version: 1, path: join(cwd, "removed.mp4"), mimeType: "video/mp4" }, { version: 1, path: join(cwd, "retained.avi"), mimeType: "video/avi" }];
  const f = active = { requests: [], prompts: [], commands: [], events: [], errors: [], uploads: 0, builds: 0, highNext: false,
    summary: `Text description, not media: ${refs[0].path} @removed.mp4 ${refs[1].path} /not-authorized/missing.avi` };
  let runtime, file, sessionId, page, offEvents, deliveries = Promise.resolve();
  async function openRuntime() {
    assert.equal(runtime, undefined, "one native writer only");
    const services = await createAgentSessionServices({ cwd, agentDir: join(dir, "agent"),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: mode === "automatic", reserveTokens: 10000, keepRecentTokens: 300 }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
    });
    services.modelRuntime.registerProvider("tapsvc", { api: "google-generative-ai", baseUrl: VIDEO_GOOGLE_BASE_URL, apiKey: "isolated-video-compaction-key",
      models: [{ id: VIDEO_MODEL_ID, name: "Gemini", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    });
    const sm = file ? SessionManager.open(file) : SessionManager.create(cwd, join(dir, "sessions"));
    const { session } = await createAgentSessionFromServices({ services, model: services.modelRuntime.getModel("tapsvc", VIDEO_MODEL_ID), thinkingLevel: "high", tools: [], sessionManager: sm });
    const wrapper = new AgentSessionWrapper(session, { headless: true });
    runtime = { session, sm, wrapper }; file = sm.getSessionFile(); sessionId = wrapper.sessionId; f.builds++;
    cacheSessionPath(sessionId, file);
    offEvents = wrapper.onEvent(event => {
      f.events.push(event);
      if (page) deliveries = deliveries.then(() => page.evaluate(event => window.emit(event), event));
    });
    wrapper.start(); wrapper.beginExtensionBinding();
  }
  async function send(command) {
    if (!runtime) await openRuntime();
    const done = Promise.withResolvers();
    const off = runtime.wrapper.onEvent(event => { if (event.type === "prompt_done") done.resolve(); });
    try { await runtime.wrapper.send(command); await done.promise; await deliveries; }
    finally { off(); }
  }
  async function sleep() {
    await deliveries; offEvents?.(); offEvents = undefined;
    await runtime.wrapper.shutdown(); runtime = undefined; invalidateSessionManagerCache(file);
  }
  // Persist only a plain setup turn. Both video owners must come from the UI,
  // not from seeded SDK attachments (ticket 09 integrated acceptance).
  await openRuntime();
  await send({ type: "prompt", message: "Before UI attachments" });
  const keptQuestion = `Recent clip ${"r".repeat(1600)}`;
  let originals;
  await sleep();
  async function routeRequest(route) {
    const req = route.request(), url = new URL(req.url());
    try {
      assert.equal(url.origin, "http://video-compaction.test");
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: js });
      if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
      if (url.pathname.startsWith("/api/files/")) {
        f.uploads++;
        assert.equal(url.searchParams.get("conflict"), "skip");
        const headers = { ...req.headers(), host: "localhost", origin: "http://localhost" };
        const result = await uploadPost(new NextRequest(`http://localhost${url.pathname}${url.search}`, { method: "POST", headers, body: req.postDataBuffer() }), { params: Promise.resolve({ path: encodeFilePathForApi(cwd).split("/") }) });
        return route.fulfill({ status: result.status, contentType: "application/json", body: await result.text() });
      }
      const body = req.method() === "POST" ? req.postDataJSON() : null;
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: { [`tapsvc:${VIDEO_MODEL_ID}`]: "Gemini" }, modelList: [{ provider: "tapsvc", id: VIDEO_MODEL_ID, name: "Gemini" }], defaultModel: { provider: "tapsvc", modelId: VIDEO_MODEL_ID }, defaultThinkingLevel: "high" } });
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [] } });
      if (url.pathname === "/api/tasks/membership") return route.fulfill({ json: { task: null } });
      if (url.pathname === `/api/sessions/${sessionId}/next-cue` && req.method() === "POST") return route.fulfill({ status: 204 });
      if ((url.pathname === `/api/sessions/${sessionId}` || url.pathname === `/api/sessions/${sessionId}/context`) && req.method() === "GET") {
        const handler = url.pathname.endsWith("/context") ? contextGet : sessionGet;
        const result = await handler(new Request(`http://localhost${url.pathname}${url.search}`), { params: Promise.resolve({ id: sessionId }) });
        assert.equal(result.status, 200);
        return route.fulfill({ json: await result.json() });
      }
      if (url.pathname === `/api/sessions/${sessionId}/state` || (url.pathname === `/api/agent/${sessionId}` && !body)) return route.fulfill({ json: runtime ? { running: true, state: await runtime.wrapper.send({ type: "get_state" }) } : { running: false } });
      if (url.pathname === `/api/agent/${sessionId}` && body) {
        f.commands.push(body.type);
        if (body.type === "prompt") { f.prompts.push(body); await send(body); return route.fulfill({ json: { success: true, data: {} } }); }
        if (!runtime) await openRuntime();
        const result = await runtime.wrapper.send(body); await deliveries;
        return route.fulfill({ json: { success: true, data: result } });
      }
      throw new Error(`Unexpected ${req.method()} ${url.pathname}`);
    } catch (error) { f.errors.push(error.message); await route.fulfill({ status: 500, json: { error: error.message } }); }
  }
  async function states(expected) {
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll("[data-video-context]")].map(e => e.dataset.videoContext)) === JSON.stringify(expected), expected);
    assert.equal(await page.locator("[data-sent-video]").count(), expected.length);
    if (expected.includes("inactive")) {
      const text = await page.locator('[data-video-context="inactive"]').first().textContent();
      assert.match(text, /no longer included automatically.*Attach it to a new question.*summary text is not video input/);
    }
    if (expected.length) assert((await page.locator("[data-sent-video]").first().textContent()).includes(refs[0].path));
    assert.equal(await page.locator("[data-video-attachment]").count(), 0);
  }
  async function openPage() {
    page = await browser.newPage({ viewport, locale: "en-US" }); page.setDefaultTimeout(10000);
    page.on("pageerror", error => f.errors.push(error.message));
    await page.addInitScript(info => { window.sessionInfo = info; }, { id: sessionId, cwd, name: "Compaction video fixture" });
    await page.route("**/*", routeRequest);
    await page.goto(`http://video-compaction.test/?session=${sessionId}`);
    await page.getByRole("button", { name: "Gemini", exact: true }).waitFor();
  }
  async function ask(message) {
    const response = page.waitForResponse(r => r.request().method() === "POST" && ["prompt", "compact"].includes(r.request().postDataJSON()?.type));
    await page.locator("textarea").fill(message);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    assert.equal((await response).status(), 200); await deliveries;
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  }
  function assertWire(mimes) {
    const request = f.requests.at(-1), parts = media(request);
    assert.equal(request.headers.get("authorization"), "Bearer isolated-video-compaction-key");
    assert.deepEqual(parts.map(p => p.mimeType), mimes);
    parts.forEach(part => {
      assert.equal(part.role, "user");
      assert.deepEqual(Buffer.from(part.data, "base64"), part.mimeType === "video/mp4" ? mp4 : avi);
      assert.equal(request.body.contents[part.index].parts[0].text, part.mimeType === "video/mp4" ? f.prompts.findLast(p => p.videos?.some(video => video.mimeType === "video/mp4")).message : keptQuestion);
    });
  }
  return { f, refs, states, openPage, ask, assertWire, sleep, get page() { return page; },
    async attachInitial() {
      await page.locator('input[accept=".mp4,.avi"]').setInputFiles({ name: "removed.mp4", buffer: mp4, mimeType: "video/mp4" });
      await page.locator("[data-video-attachment]").getByText(/Video ready/).waitFor();
      await ask("Old clip"); await states(["active"]); assertWire(["video/mp4"]);
      await page.evaluate(bytes => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], "retained.avi", { type: "video/x-msvideo" }));
        const target = document.querySelector(".chat-content");
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }, [...avi]);
      await page.locator("[data-video-attachment]").getByText(/Video ready/).waitFor();
      await ask(keptQuestion); await states(["active", "active"]); assertWire(["video/mp4", "video/avi"]);
      originals = structuredClone(runtime.sm.getEntries().filter(e => e.message?.piWebVideos));
      assert.equal(originals.length, 2);
      assert.notEqual(originals[0].message.piWebVideos[0].id, originals[1].message.piWebVideos[0].id);
      assert.deepEqual(f.prompts.map(p => p.videos), refs.map(ref => [ref]));
    },
    assertReattached() {
      const owners = runtime.sm.getEntries().filter(e => e.message?.piWebVideos);
      assert.equal(owners.length, 3);
      assert.deepEqual(owners.slice(0, 2), originals, "reattachment does not rewrite original owners");
      assert.notEqual(owners[2].message.piWebVideos[0].id, originals[0].message.piWebVideos[0].id);
      assert.equal(owners[2].message.piWebVideos[0].path, refs[0].path);
      assert.deepEqual(runtime.sm.buildSessionProjection().messages.flatMap(m => m.piWebVideos ?? []).map(video => video.id),
        [originals[1].message.piWebVideos[0].id, owners[2].message.piWebVideos[0].id]);
    },
    async compact() {
      if (mode === "automatic") { f.highNext = true; await ask("Trigger normal automatic threshold check"); }
      else await ask("/compact");
      assert(f.events.some(e => e.type === "compaction_end" && e.reason === (mode === "automatic" ? "threshold" : "manual") && e.result && !e.aborted));
      assert.equal(f.commands.filter(c => c === "compact").length, mode === "automatic" ? 0 : 1);
      const entry = runtime.sm.getEntries().find(e => e.type === "compaction");
      assert.equal(entry.firstKeptEntryId, originals[1].id);
      assert(entry.summary.includes(refs[0].path));
      assert.equal(media(f.requests.at(-1)).length, 0, "actual SDK summary fetch has no original video");
      assert(JSON.stringify(f.requests.at(-1).body).includes("<conversation>"));
      const result = await contextGet(new Request(`http://localhost/api/sessions/${sessionId}/context?before=${entry.id}&leafId=${runtime.sm.getLeafId()}`), { params: Promise.resolve({ id: sessionId }) });
      const data = await result.json();
      assert.deepEqual(data.context.messages.filter(m => m.piWebVideos).map(m => m.piWebVideoInContext), [false, true], "paged historical references use the full current context, not the cursor");
    },
    async reopen() { await deliveries; await page.close(); page = undefined; await openPage(); },
    async close() {
      offEvents?.(); await runtime?.wrapper.shutdown(); await deliveries; await page?.close();
      invalidateSessionManagerCache(file); invalidateSessionPathCache(sessionId); assert.deepEqual(f.errors, []);
      assert.equal((await readFile(file, "utf8")).includes("piWebVideoInContext"), false);
    },
  };
}
try {
  for (const mode of ["manual", "automatic"]) for (const viewport of [{ width: 1100, height: 850 }, { width: 390, height: 844 }]) {
    const h = await fixture(mode, viewport), label = `${mode}/${viewport.width === 390 ? "mobile" : "desktop"}`;
    try {
      await h.openPage(); await h.states([]);
      await h.attachInitial();
      assert.equal(h.f.requests.length, 3); assert.equal(h.f.builds, 2); assert.equal(h.f.uploads, 2);
      await h.sleep();
      await h.page.reload(); await h.states(["active", "active"]);
      await h.reopen(); await h.states(["active", "active"]);
      assert.equal(h.f.requests.length, 3); assert.equal(h.f.uploads, 2);
      await h.ask("Cold follow-up before compaction"); h.assertWire(["video/mp4", "video/avi"]);
      console.log(`PASS ${label}: chooser MP4 + DOM drop AVI -> upload/SDK answers -> reload/fresh-page cold follow-up keeps both native owners/bytes`);
      await h.compact(); await h.states(["inactive", "active"]);
      await unlink(h.refs[0].path);
      await h.ask("Follow up with the retained clip only"); h.assertWire(["video/avi"]);
      assert(h.f.prompts.slice(2).every(p => !p.videos));
      console.log(`PASS ${label}: SDK ${mode === "manual" ? "manual command" : "automatic threshold"} preserves one owner; excluded reference remains visible and missing file/summary paths never activate media`);
      await h.sleep(); const before = h.f.requests.length;
      await h.page.reload(); await h.states(["inactive", "active"]);
      assert.equal(h.f.requests.length, before);
      await h.reopen(); await h.states(["inactive", "active"]);
      assert.equal(h.f.requests.length, before);
      await h.ask("Cold reopened follow-up"); h.assertWire(["video/avi"]);
      console.log(`PASS ${label}: full reload/fresh page restore identical state; cold SDK sends only retained AVI`);
      await h.page.locator('input[accept=".mp4,.avi"]').setInputFiles({ name: "removed.mp4", buffer: mp4, mimeType: "video/mp4" });
      await h.page.locator("[data-video-attachment]").getByText(/Video ready/).waitFor();
      await h.ask("Reattached old clip"); await h.states(["inactive", "active", "active"]); h.assertWire(["video/avi", "video/mp4"]); h.assertReattached();
      assert.equal(h.f.uploads, 3);
      assert.deepEqual(h.f.prompts.at(-1).videos, [h.refs[0]]);
      await h.sleep(); await h.page.reload(); await h.states(["inactive", "active", "active"]);
      await h.ask("After reattachment and reload"); h.assertWire(["video/avi", "video/mp4"]); h.assertReattached();
      console.log(`PASS ${label}: existing picker/upload + explicit Send creates new effective owner; old reference stays inactive after reload`);
    } finally { await h.close(); }
  }
} finally {
  await browser.close(); globalThis.fetch = oldFetch; globalThis.__piAllowedRootsCache = oldRoots;
  await rm(sandbox, { recursive: true, force: true });
}
