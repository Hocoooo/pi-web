// Mounted ChatWindow/composer/hook, existing upload POST and real SDK/Google final
// fetch. Only shell navigation, browser HTTP/SSE and the gateway response are fixtures.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink, truncate } from "node:fs/promises";
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
const { POST: uploadPost } = await jiti.import("../app/api/files/[...path]/route.ts");
const { buildSessionContext } = await jiti.import("../lib/session-reader.ts");
const { VIDEO_MODEL_ID, VIDEO_GOOGLE_BASE_URL, MAX_VIDEO_FILE_BYTES } = await jiti.import("../lib/video-attachments.ts");
const { encodeFilePathForApi } = await jiti.import("../lib/file-paths.ts");
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4z8CAFWEXHbQSACj/P8FTKqelAAAAAElFTkSuQmCC", "base64");
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "video-retry.js", platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  plugins: [{ name: "url-context", setup(build) {
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "url-context" }));
    build.onLoad({ filter: /.*/, namespace: "url-context" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(location.search);" }));
  } }],
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, {useRef,useState} from "react";
    import {createRoot} from "react-dom/client";
    import {ChatWindow} from "./components/ChatWindow";
    import {I18nProvider} from "./hooks/useI18n";
    import {getDraft} from "./lib/draft-store";
    window.sources = []; window.readDraft = getDraft;
    window.emit = (id,event) => window.sources.forEach(s => s.id === id && s.readyState === 1 && s.onmessage?.({data:JSON.stringify(event)}));
    window.EventSource = class {
      readyState = 1;
      constructor(url) { this.id = url.split("/")[3]; window.sources.push(this); queueMicrotask(() => this.onmessage?.({data:JSON.stringify({type:"connected"})})); }
      close() { this.readyState = 2; }
    };
    function App() {
      const sharedRef = useRef(null);
      const [selection,setSelection] = useState({target:"a",epoch:0,session:window.existing ? window.sessions.a : null});
      window.switchTo = target => setSelection(prev => ({target,epoch:prev.epoch+1,session:window.sessions[target]}));
      // Like AppShell: explicit navigation remounts; automatic promotion rekeys
      // the current draft without remounting. The composer ref is shared across chats.
      return <I18nProvider><ChatWindow key={selection.target+selection.epoch} chatInputRef={sharedRef}
        session={selection.session} newSessionCwd={window.sessions[selection.target].cwd}
        newSessionDraftKey="retry-draft" soundEnabled={false}
        onSessionCreated={(session,sourceDraftKey) => setSelection(prev => prev.target === "a" && !prev.session && sourceDraftKey === "retry-draft" ? {...prev,session} : prev)}
      /></I18nProvider>;
    }
    createRoot(document.getElementById("root")).render(<App/>);
  ` },
});
const sandbox = await mkdtemp(join(tmpdir(), "pi-web-video-retry-"));
const oldRoots = globalThis.__piAllowedRootsCache, oldFetch = globalThis.fetch;
let active;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, `${VIDEO_GOOGLE_BASE_URL}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`, "no unexpected network");
  assert.equal(request.headers.get("authorization"), "Bearer isolated-video-retry-key");
  active.requests.push(JSON.parse(await request.text()));
  if (active.gatewayFailure) return new Response(JSON.stringify({ error: { message: "fixture gateway failure", status: "UNAVAILABLE" } }), { status: 503 });
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Captured recovery answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });

async function fixture(existing) {
  const dir = await mkdtemp(join(sandbox, "case-"));
  const runtimes = {};
  for (const name of ["a", "b"]) {
    const cwd = join(dir, name); await mkdir(cwd);
    const services = await createAgentSessionServices({ cwd, agentDir: join(dir, `agent-${name}`),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
    });
    services.modelRuntime.registerProvider("tapsvc", { api: "anthropic-messages", baseUrl: "https://llm-proxy.tapsvc.com", apiKey: "isolated-video-retry-key",
      models: [{ id: VIDEO_MODEL_ID, name: "Gemini", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    });
    const sm = SessionManager.create(cwd, join(dir, `sessions-${name}`));
    const { session } = await createAgentSessionFromServices({ services, model: services.modelRuntime.getModel("tapsvc", VIDEO_MODEL_ID), thinkingLevel: "high", tools: [], sessionManager: sm });
    const wrapper = new AgentSessionWrapper(session, { headless: true }); wrapper.start(); wrapper.beginExtensionBinding();
    runtimes[name] = { cwd, session, sm, wrapper, emitEvents: true };
  }
  const a = runtimes.a, b = runtimes.b;
  globalThis.__piAllowedRootsCache = { roots: new Set([a.cwd, b.cwd]), expiresAt: Infinity };
  const page = await browser.newPage({ viewport: existing ? { width: 390, height: 844 } : { width: 1100, height: 850 }, locale: "en-US" });
  page.setDefaultTimeout(10000);
  const errors = [], uploads = [], prompts = [], requests = [];
  const f = active = { existing, requests, gatewayFailure: false, uploadPlan: {}, promptPlan: {}, historyFailure: false, historyReads: 0, ensureCalls: 0 };
  let deliveries = Promise.resolve();
  const offEvents = Object.values(runtimes).map(r => r.wrapper.onEvent(event => {
    if (r.emitEvents) deliveries = deliveries.then(() => page.evaluate(({ id, event }) => window.emit(id, event), { id: r.wrapper.sessionId, event }));
  }));
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(data => {
    Object.assign(window, data);
    // Observe the original browser operations, not just the route's gate release.
    window.completedSubmissions = [];
    const record = (kind, path) => window.completedSubmissions.push({ kind, path });
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (init?.method !== "POST" || JSON.parse(init.body ?? "{}").type !== "prompt") return fetch(input, init);
      const path = new URL(input, location.href).pathname;
      try {
        const response = await fetch(input, init);
        const json = response.json.bind(response);
        response.json = async () => {
          try { return await json(); }
          finally { record("prompt", path); }
        };
        return response;
      } catch (error) { record("prompt", path); throw error; }
    };
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      this.submissionPath = method === "POST" ? new URL(url, location.href).pathname : null;
      return open.call(this, method, url, ...args);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      if (this.submissionPath?.startsWith("/api/files/")) {
        this.addEventListener("loadend", () => record("upload", this.submissionPath), { once: true });
      }
      return send.apply(this, args);
    };
  }, { existing, sessions: Object.fromEntries(Object.entries(runtimes).map(([key, r]) => [key, { id: r.wrapper.sessionId, cwd: r.cwd, name: `Fixture ${key}` }])) });
  async function run(r, body, events = true) {
    const done = Promise.withResolvers(), off = r.wrapper.onEvent(e => { if (e.type === "prompt_done") done.resolve(); });
    r.emitEvents = events;
    try { await r.wrapper.send(body); await done.promise; await deliveries; }
    finally { off(); r.emitEvents = true; }
  }
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    try {
      if (url.href === "http://video-retry.test/") return route.fulfill({ contentType: "text/html", body: '<style>html,body,#root{height:100%;margin:0} .chat-content,.h-full{height:100%} .relative{position:relative} .flex{display:flex} .flex-col{flex-direction:column} .flex-1{flex:1} .min-h-0{min-height:0} .min-w-0,fieldset{min-width:0} .overflow-hidden{overflow:hidden} .overflow-y-auto{overflow-y:auto}</style><div id="root"></div>' });
      assert.equal(url.origin, "http://video-retry.test");
      if (url.pathname.startsWith("/api/files/")) {
        const plan = f.uploadPlan;
        const data = req.postDataBuffer(), headers = { ...req.headers(), host: "localhost", origin: "http://localhost" };
        const form = await new Request(req.url(), { method: "POST", headers, body: data }).formData();
        uploads.push({ url: url.href, names: form.getAll("files").map(file => file.name) });
        plan.started?.resolve();
        await plan.gate?.promise;
        if (plan.failure === "abort") return route.abort("failed");
        if (plan.failure) return route.fulfill({ status: 500, json: { error: "fixture upload failure" } });
        const r = Object.values(runtimes).find(r => url.pathname === `/api/files/${encodeFilePathForApi(r.cwd)}`);
        assert(r, "upload belongs to its original cwd");
        const response = await uploadPost(new NextRequest(`http://localhost${url.pathname}${url.search}`, { method: "POST", headers, body: data }), { params: Promise.resolve({ path: encodeFilePathForApi(r.cwd).split("/") }) });
        return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
      }
      const body = req.method() === "POST" ? req.postDataJSON() : null;
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: { [`tapsvc:${VIDEO_MODEL_ID}`]: "Gemini" }, modelList: [{ provider: "tapsvc", id: VIDEO_MODEL_ID, name: "Gemini" }], defaultModel: { provider: "tapsvc", modelId: VIDEO_MODEL_ID }, defaultThinkingLevel: "high" } });
      if (url.pathname === "/_next/image") return route.fulfill({ contentType: "image/png", body: png });
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [] } });
      if (url.pathname === "/api/app-update") return route.fulfill({ json: { updateAvailable: false } });
      if (url.pathname === "/api/tasks/membership") return route.fulfill({ json: { task: null } });
      if (url.pathname === "/api/agent/new") {
        f.ensureCalls++; assert.equal(body.type, "ensure_session"); assert.equal(body.video, undefined);
        return route.fulfill({ json: { sessionId: a.wrapper.sessionId, model: { provider: "tapsvc", modelId: VIDEO_MODEL_ID }, thinkingLevel: "high" } });
      }
      const r = Object.values(runtimes).find(r => url.pathname.includes(r.wrapper.sessionId));
      assert(r, `unexpected fixture request ${url.pathname}`);
      if (req.method() === "POST" && url.pathname === `/api/sessions/${r.wrapper.sessionId}/next-cue`) return route.fulfill({ status: 204 });
      if (body?.type === "prompt") {
        const plan = f.promptPlan;
        prompts.push({ id: r.wrapper.sessionId, ...body });
        plan.started?.resolve();
        await plan.gate?.promise;
        try {
          if (plan.outcome !== "unknown-none") await run(r, body, plan.outcome !== "unknown-history");
        } catch (error) {
          return route.fulfill({ status: 500, json: { error: error.message, accepted: false, code: "prompt_rejected" } });
        }
        if (plan.outcome?.startsWith("unknown")) return route.abort("failed");
        return route.fulfill({ json: { success: true, data: {} } });
      }
      const state = await r.wrapper.send({ type: "get_state" });
      if (url.pathname.endsWith("/state")) return route.fulfill({ json: { running: true, state } });
      if (req.method() === "GET" && url.pathname === `/api/sessions/${r.wrapper.sessionId}`) {
        f.historyReads++;
        if (f.historyFailure) return route.fulfill({ status: 500, json: { error: "fixture history unavailable" } });
        const context = buildSessionContext(r.sm.getEntries(), r.sm.getLeafId());
        return route.fulfill({ json: { sessionId: r.wrapper.sessionId, filePath: r.sm.getSessionFile(), tree: [], treeFormat: "summary", leafId: r.sm.getLeafId(), snapshotRevision: `fixture-${r.sm.getEntries().length}`, context: { ...context, oldestEntryId: null, hasMore: false, model: state.model, thinkingLevel: "high" } } });
      }
      return route.fulfill({ json: body ? { success: true, data: await r.wrapper.send(body) } : { running: true, state } });
    } catch (error) {
      errors.push(error.message);
      await route.fulfill({ status: 500, json: { error: error.message } });
    }
  });
  await page.goto("http://video-retry.test/");
  for (const file of outputFiles) {
    if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
    else await page.addScriptTag({ content: file.text });
  }
  const input = page.locator("textarea"), card = page.locator("[data-video-attachment]"), saved = page.locator("[data-unconfirmed-submission]");
  const send = page.getByRole("button", { name: "Send", exact: true });
  const restore = page.getByRole("button", { name: "Check and restore saved input", exact: true });
  const idle = () => page.getByRole("button", { name: "Attach video (MP4/AVI)", exact: true }).waitFor();
  await input.waitFor(); await page.getByRole("button", { name: "Gemini", exact: true }).waitFor();
  return Object.assign(f, { a, b, page, input, card, saved, send, restore, uploads, prompts, run,
    remove: () => page.getByRole("button", { name: "Remove video", exact: true }).click(),
    select: (name = "clip.avi", bytes = avi, mimeType = "video/x-msvideo") => page.locator('input[accept=".mp4,.avi"]').setInputFiles({ name, buffer: bytes, mimeType }),
    ready: () => card.getByText(/Video ready|Not replaced/).waitFor(),
    idle,
    async waitForSourceCompletion(kind) {
      const path = kind === "upload" ? `/api/files/${encodeFilePathForApi(a.cwd)}` : `/api/agent/${a.wrapper.sessionId}`;
      await page.waitForFunction(({ kind, path }) => window.completedSubmissions.some(r => r.kind === kind && r.path === path), { kind, path });
      // Let the consumer's promise continuations and React's resulting updates flush.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    },
    async switchTo(target) { await page.evaluate(target => window.switchTo(target), target); await input.waitFor(); await page.getByRole("button", { name: "Gemini", exact: true }).waitFor(); },
    async prepare() {
      await input.fill("Keep the original question");
      await page.locator('input[accept="image/*"]').setInputFiles({ name: "pixel.png", buffer: png, mimeType: "image/png" });
      await page.locator('img[src^="blob:"]').waitFor();
      await this.select(); await this.ready();
    },
    async close() { offEvents.forEach(off => off()); await deliveries; for (const r of Object.values(runtimes)) await r.wrapper.shutdown(); await page.close(); assert.deepEqual(errors, []); },
  });
}
function videos(body) { return body.contents.flatMap((c, index) => c.parts.filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, role: c.role, ...p.inlineData }))); }
async function assertSuccess(f, { prompts = 1, bytes = avi } = {}) {
  await f.page.getByText("Captured recovery answer", { exact: true }).waitFor();
  await f.page.locator("[data-sent-video]").waitFor();
  await f.idle();
  assert.equal(f.prompts.length, prompts); assert.equal(f.requests.length, 1);
  const parts = videos(f.requests[0]);
  assert.equal(parts.length, 1); assert.equal(parts[0].role, "user"); assert.equal(parts[0].mimeType, "video/avi");
  assert.deepEqual(Buffer.from(parts[0].data, "base64"), bytes);
  assert(f.requests[0].contents[parts[0].index].parts.some(p => p.text?.includes("Keep the original question")));
  const image = f.requests[0].contents[parts[0].index].parts.find(p => p.inlineData?.mimeType === "image/png");
  assert.deepEqual(Buffer.from(image.inlineData.data, "base64"), png);
  assert.equal(f.ensureCalls, f.existing ? 0 : 1, "retries reuse the actual SDK session");
  assert.equal(await f.input.inputValue(), ""); assert.equal(await f.card.count(), 0); assert.equal(await f.saved.count(), 0);
}

try {
  for (const existing of [false, true]) {
    const layout = existing ? "existing/mobile" : "new/desktop";
    for (const failure of ["http", "abort"]) {
      const f = await fixture(existing);
      try {
        await f.input.fill("Keep the original question"); f.uploadPlan = { failure };
        await f.select(); await f.card.getByRole("alert").waitFor();
        assert.equal(await f.input.inputValue(), "Keep the original question"); assert.equal(await f.send.isDisabled(), true);
        await f.input.press("Control+Alt+Enter"); assert.equal(f.prompts.length, 0);
        await f.remove(); f.uploadPlan = {};
        await f.prepare(); await f.send.click(); await assertSuccess(f);
        assert.equal(f.uploads.length, 2);
        console.log(`PASS ${layout}: upload ${failure} -> remove/reselect -> actual original video+image wire`);
      } finally { await f.close(); }
    }
    for (const kind of ["missing", "oversized", "model"]) {
      const f = await fixture(existing);
      try {
        await f.prepare(); const path = join(f.a.cwd, "clip.avi");
        const originalGetModel = f.a.session.modelRuntime.getModel.bind(f.a.session.modelRuntime);
        await unlink(path); await f.send.click(); await f.ready();
        assert.equal(await f.input.inputValue(), "Keep the original question");
        assert.equal(f.prompts.length, 1); assert.equal(f.requests.length, 0);
        if (kind !== "missing") await writeFile(path, avi);
        if (kind === "oversized") await truncate(path, MAX_VIDEO_FILE_BYTES + 1);
        if (kind === "model") f.a.session.modelRuntime.getModel = () => ({ ...f.a.session.model, provider: "other" });
        await f.send.click(); await f.ready();
        assert.equal(await f.input.inputValue(), "Keep the original question");
        assert.equal(await f.saved.count(), 0); assert.equal(f.prompts.length, 2); assert.equal(f.requests.length, 0, "retry checks must never send text-only");
        assert.equal(f.a.session.messages.some(m => m.piWebVideo), false, "definite rejection has no native owner");
        await writeFile(path, avi); f.a.session.modelRuntime.getModel = originalGetModel;
        await f.send.click(); await assertSuccess(f, { prompts: 3 });
        for (const prompt of f.prompts.slice(1)) {
          assert.deepEqual(prompt.video, f.prompts[0].video); assert.deepEqual(prompt.images, f.prompts[0].images);
        }
        console.log(`PASS ${layout}: rejection -> restored retry rechecks ${kind} -> repair -> validated actual transport`);
      } finally { await f.close(); }
    }
    {
      const f = await fixture(existing);
      try {
        // A removed result must neither resurrect itself nor unblock/replace the newer upload.
        await f.input.fill("Keep the original question");
        const old = { gate: Promise.withResolvers(), started: Promise.withResolvers() };
        const next = { gate: Promise.withResolvers(), started: Promise.withResolvers() };
        f.uploadPlan = old; await f.select("removed.mp4", mp4, "video/mp4");
        await old.started.promise; await f.card.getByText(/Uploading video/).waitFor(); await f.remove();
        f.uploadPlan = next; await f.select(); await next.started.promise; await f.card.getByText(/Uploading video/).waitFor();
        old.gate.resolve(); await f.waitForSourceCompletion("upload");
        assert.match(await f.card.textContent(), /clip.avi.*Uploading video/s); assert.equal(await f.send.isDisabled(), true);
        next.gate.resolve(); await f.ready(); await f.remove();
        f.uploadPlan = {};
        const count = f.uploads.length;
        await f.input.evaluate((target, bytes) => {
          for (let i = 0; i < 2; i++) {
            const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(bytes)], "duplicate.mp4", { type: "video/mp4" }));
            target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
          }
        }, [...mp4]);
        await f.ready(); assert.equal(f.uploads.length, count + 1, "duplicate selection uploads only once"); await f.remove();
        await f.prepare();
        await f.send.evaluate(button => { button.click(); button.click(); });
        await assertSuccess(f);
        assert.equal(await f.page.locator('fieldset img').count(), 0, "duplicate Send must not restore a second copy of the submitted draft");
        assert.equal(f.a.session.messages.filter(m => m.piWebVideo).length, 1);
        console.log(`PASS ${layout}: removed late upload vs newer upload + duplicate Send preserves one owner and empty draft`);
      } finally { await f.close(); }
    }
    for (const stage of ["upload", "rejection", "unknown", "accepted"]) {
      const f = await fixture(existing);
      try {
        const gate = Promise.withResolvers(), started = Promise.withResolvers();
        if (stage === "upload") { f.uploadPlan = { gate, started }; await f.input.fill("Source input"); await f.select(); await f.card.getByText(/Uploading video/).waitFor(); }
        else {
          await f.prepare();
          if (stage === "rejection") await unlink(join(f.a.cwd, "clip.avi"));
          f.promptPlan = { gate, started, ...(stage === "unknown" ? { outcome: "unknown-none" } : {}) };
          await f.send.click();
        }
        await started.promise;
        if (stage !== "upload") assert.equal(f.prompts.length, 1);
        await f.switchTo("b"); await f.input.fill("Destination stays untouched");
        f.uploadPlan = {};
        await f.select("destination.mp4", mp4, "video/mp4");
        await f.ready(); gate.resolve(); await f.waitForSourceCompletion(stage === "upload" ? "upload" : "prompt");
        assert.equal(await f.input.inputValue(), "Destination stays untouched");
        assert.match(await f.card.textContent(), /destination.mp4/); assert.equal(await f.saved.count(), 0);
        assert.equal(f.prompts.filter(p => p.id === f.b.wrapper.sessionId).length, 0);
        assert.equal(f.requests.length, stage === "accepted" ? 1 : 0);
        assert.equal(await f.page.locator("[data-sent-video]").count(), 0, "late source owner is not displayed in destination");
        assert.equal(await f.page.evaluate(id => window.readDraft(id)?.video?.path, f.b.wrapper.sessionId), join(f.b.cwd, "destination.mp4"));
        if (existing && stage === "rejection") {
          await f.switchTo("a"); await f.ready();
          assert.equal(await f.input.inputValue(), "Keep the original question", "late rejection is recoverable only in its source session");
          await writeFile(join(f.a.cwd, "clip.avi"), avi); f.promptPlan = {};
          await f.send.click(); await assertSuccess(f, { prompts: 2 });
        }
        console.log(`PASS ${layout}: switch during ${stage}, shared ref/destination text/video unaffected by late source result`);
      } finally { await f.close(); }
    }
    for (const outcome of ["unknown-none", "unknown-history", "unknown-sse", "unknown-late"]) {
      const f = await fixture(existing);
      try {
        await f.prepare(); f.promptPlan = { outcome: outcome === "unknown-late" ? "unknown-none" : outcome };
        await f.send.click();
        if (outcome === "unknown-history" || outcome === "unknown-sse") {
          await f.page.locator("[data-sent-video]").waitFor(); await f.idle();
          assert.equal(await f.saved.count(), 0); assert.equal(await f.input.inputValue(), "");
          assert.equal(f.prompts.length, 1); assert.equal(f.requests.length, 1);
        } else {
          await f.saved.waitFor(); await f.restore.waitFor({ state: "visible" });
          await f.page.waitForFunction(() => !document.querySelector('[data-unconfirmed-submission] button')?.disabled);
          assert.equal(await f.input.inputValue(), ""); assert.equal(await f.card.count(), 0); assert.equal(f.requests.length, 0);
          if (outcome === "unknown-late") await f.run(f.a, f.prompts[0], false);
          else {
            await f.input.fill("Another input"); await f.send.click();
            await f.page.getByText("Check the unconfirmed submission and restore its saved input before sending again. Nothing was sent.", { exact: true }).waitFor();
            await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(f.prompts.length, 1, "a new prompt cannot overwrite an unknown submission");
            assert.equal(await f.input.inputValue(), "Another input");
            assert.match(await f.saved.textContent(), /Keep the original question/); await f.input.fill("");
            f.historyFailure = true; await f.restore.click();
            await f.saved.getByRole("alert").waitFor(); assert.equal(f.prompts.length, 1); assert.equal(await f.input.inputValue(), "");
            f.historyFailure = false;
          }
          await f.page.waitForFunction(() => !document.querySelector('[data-unconfirmed-submission] button')?.disabled);
          const reads = f.historyReads;
          await f.restore.evaluate(button => { button.click(); button.click(); });
          // Exercise the neighboring endpoint during recovery; it must neither
          // look like history nor inflate the one-authoritative-GET assertion.
          assert.equal(await f.page.evaluate(async id => (await fetch(`/api/sessions/${id}/next-cue`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: null, leafId: null }),
          })).status, f.a.wrapper.sessionId), 204);
          if (outcome === "unknown-late") {
            await f.saved.waitFor({ state: "hidden" }); assert.equal(await f.input.inputValue(), ""); assert.equal(await f.card.count(), 0);
          } else {
            await f.ready(); assert.equal(f.historyReads, reads + 1, "duplicate restore shares the existing local guard");
            assert.equal(f.prompts.length, 1, "restore never automatically resends");
            // A restored reference is not an authorization/size bypass.
            await truncate(join(f.a.cwd, "clip.avi"), MAX_VIDEO_FILE_BYTES + 1);
            f.promptPlan = {}; await f.send.click(); await f.ready(); assert.equal(f.requests.length, 0);
            await writeFile(join(f.a.cwd, "clip.avi"), avi);
            await f.send.click(); await assertSuccess(f, { prompts: 3 });
            assert.deepEqual(f.prompts[2].video, f.prompts[0].video); assert.deepEqual(f.prompts[2].images, f.prompts[0].images);
          }
        }
        console.log(`PASS ${layout}: ${outcome}, authoritative check/no automatic resend/explicit restore/actual validated wire`);
      } finally { await f.close(); }
    }
    {
      const f = await fixture(existing);
      try {
        await f.prepare(); f.gatewayFailure = true; await f.send.click();
        await f.page.getByText(/fixture gateway failure/).first().waitFor(); await f.idle();
        assert.equal(f.prompts.length, 1); assert.equal(f.requests.length, 1);
        assert.equal(await f.page.locator("[data-sent-video]").count(), 1, "accepted error keeps its native reference in history");
        assert.equal(await f.saved.count(), 0); assert.equal(await f.card.count(), 0); assert.equal(await f.input.inputValue(), "");
        console.log(`PASS ${layout}: admitted gateway error keeps native user reference, never auto-restores/resends`);
      } finally { await f.close(); }
    }
  }
} finally {
  await browser.close(); globalThis.fetch = oldFetch; globalThis.__piAllowedRootsCache = oldRoots;
  await rm(sandbox, { recursive: true, force: true });
}
