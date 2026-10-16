// Ticket 06: mounted ChatWindow/BranchNavigator -> real wrapper/SDK navigation,
// fork/clone -> actual history GET -> native Google final fetch (synthetic SSE).
// No Next server, production credentials, asset copies or hand-authored owners.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink, readdir } from "node:fs/promises";
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
const { GET: contextGet } = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const { cacheSessionPath, resolveSessionPath, invalidateSessionPathCache, invalidateSessionManagerCache } = await jiti.import("../lib/session-reader.ts");
const { VIDEO_MODEL_ID, VIDEO_GOOGLE_BASE_URL, MAX_VIDEO_REQUEST_BYTES } = await jiti.import("../lib/video-attachments.ts");
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "video-branch.js", platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  plugins: [{ name: "url-context", setup(build) {
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "url-context" }));
    build.onLoad({ filter: /.*/, namespace: "url-context" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(location.search);" }));
  } }],
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, {useCallback, useState} from "react";
    import {createRoot} from "react-dom/client";
    import {ChatWindow} from "./components/ChatWindow";
    import {BranchNavigator} from "./components/BranchNavigator";
    import {I18nProvider} from "./hooks/useI18n";
    window.sources = [];
    window.emit = (id,event) => window.sources.forEach(s => s.id === id && s.readyState === 1 && s.onmessage?.({data:JSON.stringify(event)}));
    window.EventSource = class {
      readyState = 1;
      constructor(url) { this.id = url.split("/")[3]; window.sources.push(this); queueMicrotask(() => this.onmessage?.({data:JSON.stringify({type:"connected"})})); }
      close() { this.readyState = 2; }
    };
    function App() {
      const [id,setId] = useState(new URLSearchParams(location.search).get("session"));
      const [branch,setBranch] = useState({tree:[],leaf:null,change:()=>{},locked:false});
      const branchData = useCallback((tree,leaf,change,locked) => { window.branchTree = tree; setBranch({tree,leaf,change,locked}); },[]);
      const select = useCallback(id => { history.replaceState(null,"","/?session="+id); setId(id); },[]);
      return <I18nProvider><div style={{height:"100%",display:"flex",flexDirection:"column"}}>
        <div data-branches><BranchNavigator tree={branch.tree} activeLeafId={branch.leaf} onLeafChange={branch.change} locked={branch.locked} hasSession /></div>
        {/* Exercise the registered shell callback at an exact native user ID,
            including nodes the navigator's chain compression need not expose. */}
        <button data-owner-boundary onClick={()=>branch.change(window.ownerBoundary)}>Before video owner</button>
        <div data-leaf={branch.leaf} data-session={id} />
        <ChatWindow key={id} session={{id,cwd:window.cwd,name:"Branch videos"}} newSessionCwd={window.cwd}
          newSessionDraftKey={null} soundEnabled={false} onBranchDataChange={branchData} onSessionForked={select} />
      </div></I18nProvider>;
    }
    createRoot(document.getElementById("root")).render(<App/>);
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
const sandbox = await mkdtemp(join(tmpdir(), "pi-web-video-branch-"));
const oldRoots = globalThis.__piAllowedRootsCache, oldFetch = globalThis.fetch, oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const registry = globalThis.__piSessions ??= new Map();
let active;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init), raw = await req.text(), body = JSON.parse(raw);
  const media = body.contents.flatMap(c => c.parts ?? []).filter(p => p.inlineData?.mimeType.startsWith("video/"));
  assert.equal(req.url, `${media.length ? VIDEO_GOOGLE_BASE_URL : "https://llm-proxy.tapsvc.com"}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`, "no unexpected network");
  if (media.length) assert.equal(req.headers.get("authorization"), "Bearer isolated-video-branch-key");
  active.requests.push({ body, bytes: Buffer.byteLength(raw) });
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `Captured answer ${active.requests.length}` }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });

async function fixture(viewport, { longBranch = false } = {}) {
  const dir = await mkdtemp(join(sandbox, "case-")), cwd = join(dir, "workspace"), agentDir = join(dir, "agent");
  await mkdir(cwd); process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Infinity };
  const f = active = { requests: [], commands: [], history: [], contexts: [], errors: [], builds: 0, navigationFailure: false };
  const runtimes = new Map(), files = new Map();
  let page, deliveries = Promise.resolve();
  async function openRuntime(id) {
    const existing = runtimes.get(id);
    if (existing?.wrapper.isAlive()) return existing;
    const file = id ? files.get(id) ?? await resolveSessionPath(id) : undefined;
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
        extensionFactories: [pi => pi.on("session_before_tree", () => f.navigationCancelled ? { cancel: true } : undefined)] },
    });
    services.modelRuntime.registerProvider("tapsvc", { api: "google-generative-ai", baseUrl: "https://llm-proxy.tapsvc.com", apiKey: "isolated-video-branch-key",
      models: [{ id: VIDEO_MODEL_ID, name: "Gemini", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    });
    const sm = file ? SessionManager.open(file) : SessionManager.create(cwd, join(agentDir, "sessions"));
    const { session } = await createAgentSessionFromServices({ services, model: services.modelRuntime.getModel("tapsvc", VIDEO_MODEL_ID), thinkingLevel: "high", tools: [], sessionManager: sm });
    const wrapper = new AgentSessionWrapper(session, { headless: true }), runtime = { session, sm, wrapper };
    id = wrapper.sessionId;
    runtimes.set(id, runtime); files.set(id, sm.getSessionFile()); cacheSessionPath(id, sm.getSessionFile()); registry.set(id, wrapper); f.builds++;
    wrapper.onEvent(event => { if (page) deliveries = deliveries.then(() => page.evaluate(({id,event}) => window.emit(id,event), { id, event })); });
    wrapper.start(); wrapper.beginExtensionBinding();
    return runtime;
  }
  async function command(id, body) {
    const runtime = await openRuntime(id), done = Promise.withResolvers();
    const off = runtime.wrapper.onEvent(event => { if (event.type === "prompt_done") done.resolve(); });
    try {
      const result = await runtime.wrapper.send(body);
      if (body.type === "prompt") await done.promise;
      await deliveries;
      if (result?.newSessionId) { const file = await resolveSessionPath(result.newSessionId); files.set(result.newSessionId, file); }
      return result;
    } finally { off(); }
  }
  const first = await openRuntime(), source = first.wrapper.sessionId;
  const refs = [{ version: 1, path: join(cwd, "branch-a.mp4"), mimeType: "video/mp4" }, { version: 1, path: join(cwd, "branch-b.avi"), mimeType: "video/avi" }];
  await writeFile(refs[0].path, mp4); await writeFile(refs[1].path, avi);
  await command(source, { type: "prompt", message: "Before both videos" });
  const base = first.sm.getLeafId();
  await command(source, { type: "prompt", message: "Describe branch A", videos: [refs[0]] });
  if (longBranch) {
    // Real prompt/SDK entries put A's owner beyond the canonical 50-entry tail.
    for (let turn = 0; turn < 28; turn++) await command(source, { type: "prompt", message: `Long A turn ${turn}` });
  }
  const a = first.sm.getLeafId();
  await command(source, { type: "navigate_tree", targetId: base });
  await command(source, { type: "prompt", message: "Describe branch B", videos: [refs[1]] });
  const b = first.sm.getLeafId(), originals = structuredClone(first.sm.getEntries().filter(e => e.message?.piWebVideos));
  async function sleep() {
    await deliveries;
    for (const [id, runtime] of runtimes) { await runtime.wrapper.shutdown(); registry.delete(id); invalidateSessionManagerCache(files.get(id)); }
    runtimes.clear();
  }
  await sleep();
  async function routeRequest(route) {
    const req = route.request(), url = new URL(req.url()), body = req.method() === "POST" ? req.postDataJSON() : null;
    try {
      assert.equal(url.origin, "http://video-branch.test", "browser must not make external requests");
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: js });
      if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: { [`tapsvc:${VIDEO_MODEL_ID}`]: "Gemini" }, modelList: [{ provider: "tapsvc", id: VIDEO_MODEL_ID, name: "Gemini" }], defaultModel: { provider: "tapsvc", modelId: VIDEO_MODEL_ID }, defaultThinkingLevel: "high" } });
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [] } });
      if (url.pathname === "/api/tasks/membership") return route.fulfill({ json: { task: null } });
      const [, , domain, id, action] = url.pathname.split("/");
      if (domain === "sessions" && action === "next-cue") return route.fulfill({ status: 204 });
      if (domain === "sessions" && (!action || action === "context") && !body) {
        const result = await (action ? contextGet : sessionGet)(new Request(`http://localhost${url.pathname}${url.search}`), { params: Promise.resolve({ id }) });
        assert.equal(result.status, 200); const data = await result.json();
        if (action) f.contexts.push({ url: url.href, ...data });
        else f.history.push(data);
        const gate = action ? f.contextGate : f.historyGate;
        if (gate && !gate.captured) {
          gate.captured = true; gate.started.resolve(data); await gate.release.promise;
          await route.fulfill({ json: data }); gate.finished.resolve(); return;
        }
        return route.fulfill({ json: data });
      }
      if (domain === "sessions" && action === "state" || domain === "agent" && !body) {
        const runtime = runtimes.get(id);
        return route.fulfill({ json: runtime?.wrapper.isAlive() ? { running: true, state: await runtime.wrapper.send({ type: "get_state" }) } : { running: false } });
      }
      if (domain === "agent" && body) {
        f.commands.push({ id, ...body });
        if (body.type === "navigate_tree" && f.navigationGate) await f.navigationGate.promise;
        if (body.type === "navigate_tree" && f.navigationFailure) return route.fulfill({ status: 500, json: { error: "Isolated navigation refused" } });
        return route.fulfill({ json: { success: true, data: await command(id, body) } });
      }
      throw new Error(`Unexpected fixture request ${req.method()} ${url.pathname}`);
    } catch (error) {
      f.errors.push(error.message);
      await route.fulfill({ status: 500, json: { error: error.message } });
    }
  }
  async function openPage(id = source) {
    assert(!page);
    page = await browser.newPage({ viewport, locale: "en-US" }); page.setDefaultTimeout(10000);
    page.on("pageerror", error => f.errors.push(error.message));
    await page.addInitScript(({cwd,boundary,observeScrolling}) => {
      window.cwd = cwd; window.ownerBoundary = boundary;
      if (!observeScrolling) return;
      // Observe the browser's real scroll/IntersectionObserver/fetch path. Never
      // synthesize an intersection or invoke the hook's loadContext directly.
      window.historyIntersections = []; window.contextFetches = [];
      const fetch = window.fetch;
      window.fetch = (...args) => {
        const url = typeof args[0] === "string" ? args[0] : args[0].url;
        if (/\/api\/sessions\/[^/]+\/context\?/.test(url)) window.contextFetches.push(url);
        return fetch(...args);
      };
      const Observer = window.IntersectionObserver;
      window.IntersectionObserver = class extends Observer {
        constructor(callback, options) {
          super((entries, observer) => {
            callback(entries, observer);
            if (options?.root?.matches(".chat-message-region")) {
              window.historyIntersections.push({ intersecting: entries[0]?.isIntersecting, reads: window.contextFetches.length });
            }
          }, options);
        }
      };
    }, { cwd, boundary: originals[0].id, observeScrolling: longBranch });
    await page.route("**/*", routeRequest);
    await page.goto(`http://video-branch.test/?session=${id}`);
    await page.getByRole("button", { name: "Gemini", exact: true }).waitFor();
  }
  async function displayed(indices) {
    await page.waitForFunction(count => document.querySelectorAll("[data-sent-video]").length === count, indices.length);
    const paths = await page.locator("[data-sent-video]").evaluateAll(cards => cards.map(c => c.title));
    assert.deepEqual(paths, indices.map(i => refs[i].path));
    for (const i of indices) {
      const card = page.locator(`[data-sent-video][title="${refs[i].path}"]`);
      assert((await card.textContent()).includes(refs[i].mimeType));
      assert.equal(await card.locator("[data-video-context]").getAttribute("data-video-context"), "active");
    }
    assert.equal(await page.locator("[data-video-attachment]").count(), 0);
  }
  async function beginBranchSwitch(label) {
    await page.getByRole("button", { name: "Branches", exact: true }).click();
    const response = page.waitForResponse(r => r.request().postDataJSON()?.type === "navigate_tree");
    await page.locator("[data-branches]").getByText(label, { exact: true }).click();
    assert.equal((await response).status(), 200);
  }
  async function switchBranch(label) {
    await beginBranchSwitch(label);
    const canonicalLeaf = runtimes.get(source).sm.getLeafId();
    await page.waitForFunction(leaf => document.querySelector("[data-leaf]")?.getAttribute("data-leaf") === leaf, canonicalLeaf);
    await page.getByRole("button", { name: "Branches", exact: true }).click();
  }
  async function ask(message, expected, bytes = [mp4, avi]) {
    const before = f.requests.length;
    await page.locator("textarea").fill(message);
    const response = page.waitForResponse(r => r.request().postDataJSON()?.type === "prompt");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.getByText(`Captured answer ${before + 1}`, { exact: true }).waitFor();
    await deliveries; await displayed(expected);
    assert.equal(f.requests.length, before + 1);
    const request = f.requests.at(-1), parts = request.body.contents.flatMap((c,index) => (c.parts ?? []).filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, role: c.role, ...p.inlineData })));
    assert.deepEqual(parts.map(p => p.mimeType), expected.map(i => refs[i].mimeType));
    parts.forEach((p,n) => { const i = expected[n]; assert.equal(p.role, "user"); assert.deepEqual(Buffer.from(p.data,"base64"), bytes[i]); assert.equal(request.body.contents[p.index].parts[0].text, `Describe branch ${i === 0 ? "A" : "B"}`); });
    assert(!request.body.contents.at(-1).parts.some(p => p.inlineData));
    assert(request.bytes < MAX_VIDEO_REQUEST_BYTES);
    assert.equal(f.commands.at(-1).videos, undefined, "a follow-up must not silently attach the last selected video");
  }
  async function scrollHistoryToTop() {
    const region = page.locator(".chat-message-region");
    await region.evaluate(el => {
      if (el.scrollHeight <= el.clientHeight) throw new Error("Fixture must actually overflow before scrolling");
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForFunction(() => window.historyIntersections.at(-1)?.intersecting === false);
    const mark = await page.evaluate(() => window.historyIntersections.length);
    await region.evaluate(el => { el.scrollTop = 0; });
    await page.waitForFunction(mark => window.historyIntersections.slice(mark).some(e => e.intersecting), mark);
    // Recorded AFTER the genuine callback ran; any loadContext fetch starts
    // synchronously there, so a blocked-request check needs no arbitrary sleep.
    return page.evaluate(mark => window.historyIntersections.slice(mark).find(e => e.intersecting).reads, mark);
  }
  async function forkAt(question) {
    const row = page.locator("[data-entry-id]").filter({ has: page.getByText(question, { exact: true }) });
    await row.hover();
    const response = page.waitForResponse(r => r.request().postDataJSON()?.type === "fork");
    await row.getByRole("button", { name: "New session", exact: true }).click();
    const result = await (await response).json();
    await page.waitForFunction(id => document.querySelector("[data-session]")?.getAttribute("data-session") === id, result.data.newSessionId);
    return result.data.newSessionId;
  }
  return { f, source, refs, originals, base, a, b, runtimes, files, cwd, openPage, displayed, beginBranchSwitch, switchBranch, scrollHistoryToTop, ask, forkAt, sleep,
    get page() { return page; },
    async closePage() { await deliveries; await page.close(); page = undefined; },
    async close() { await sleep(); await page?.close(); for (const [id,file] of files) { invalidateSessionPathCache(id); invalidateSessionManagerCache(file); } assert.deepEqual(f.errors, []); },
  };
}

async function checkNavigationScroll(viewport, layout) {
  const c = await fixture(viewport, { longBranch: true });
  const historyResponse = r => /\/api\/sessions\/[^/]+\?/.test(r.url());
  const contextResponse = r => /\/api\/sessions\/[^/]+\/context\?/.test(r.url());
  async function pageOlderA() {
    const tail = c.f.history.at(-1).context;
    assert.equal(tail.hasMore, true);
    assert(!tail.entryIds.includes(c.originals[0].id), "A video must be outside the initial tail");
    const response = c.page.waitForResponse(contextResponse);
    await c.scrollHistoryToTop(); await (await response).finished(); await c.displayed([0]);
    const older = c.f.contexts.at(-1), query = new URL(older.url).searchParams;
    assert.equal(query.get("leafId"), c.a);
    assert.equal(query.get("before"), tail.oldestEntryId);
    assert(older.context.entryIds.includes(c.originals[0].id), "real context GET must page in A's native owner");
    assert(!older.context.entryIds.some(id => tail.entryIds.includes(id)), "normal pagination must not duplicate the tail");
    assert.equal(await c.page.locator(`[data-entry-id="${c.originals[0].id}"]`).count(), 1);
  }
  try {
    await c.openPage(); await c.displayed([1]);
    await c.switchBranch("Describe branch A"); await c.displayed([]);
    await pageOlderA();
    console.log(`PASS ${layout}: actual DOM scroll -> native IntersectionObserver -> real older-context GET reveals A's original owner without duplicate IDs`);

    await c.switchBranch("Describe branch B"); await c.displayed([1]);
    await c.switchBranch("Describe branch A"); await c.displayed([]);
    const historyGate = c.f.historyGate = { started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
    const contextGate = c.f.contextGate = { started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
    try {
      await c.beginBranchSwitch("Describe branch B");
      const canonical = await historyGate.started.promise;
      assert.equal(canonical.leafId, c.b, "SDK must have acknowledged B before the scroll");
      assert.equal(c.runtimes.get(c.source).sm.getLeafId(), c.b);
      assert.equal(await c.page.locator("[data-leaf]").getAttribute("data-leaf"), c.a, "canonical GET is held while UI still has A's leaf/cursor");
      await c.page.getByRole("button", { name: "Branches", exact: true }).click();
      const before = await c.page.evaluate(() => window.contextFetches.length);
      const after = await c.scrollHistoryToTop();
      if (after > before) await contextGate.started.promise;
      const canonicalResponse = c.page.waitForResponse(historyResponse);
      historyGate.release.resolve(); await historyGate.finished.promise; await (await canonicalResponse).finished();
      await c.page.waitForFunction(leaf => document.querySelector("[data-leaf]")?.getAttribute("data-leaf") === leaf, c.b);
      await c.displayed([1]);
      if (after > before) {
        // Red witness: let a wrongly-started old A page arrive AFTER canonical B.
        const lateResponse = c.page.waitForResponse(contextResponse);
        contextGate.release.resolve(); await contextGate.finished.promise; await (await lateResponse).finished();
      }
      await c.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.deepEqual(await c.page.locator("[data-sent-video]").evaluateAll(cards => cards.map(card => card.title)), [c.refs[1].path], "a late old-leaf page must not mix A into canonical B");
      await c.displayed([1]);
      assert.equal(after, before, "pending canonical GET must block new paging with the old UI leaf/cursor");
      assert.equal(c.f.contexts.length, 1, "only the normal pre-navigation page was requested");
    } finally {
      historyGate.release.resolve(); contextGate.release.resolve();
      c.f.historyGate = undefined; c.f.contextGate = undefined;
    }
    // The gate is local to navigation: both ordinary Send and scrolling work
    // again after canonical completion, not merely before the pending window.
    await c.ask("B after the canonical history wait", [1]);
    await c.switchBranch("Describe branch A"); await c.displayed([]);
    await pageOlderA();
    console.log(`PASS ${layout}: ACK-to-canonical wait rejects old-leaf paging from actual scroll; only B displays/sends, then ordinary A scrolling resumes`);
  } finally { await c.close(); }
}

try {
  for (const viewport of [{ width: 1100, height: 850 }, { width: 390, height: 844 }]) {
    const layout = viewport.width === 390 ? "mobile" : "desktop";
    await checkNavigationScroll(viewport, layout);
    const c = await fixture(viewport);
    try {
      await c.openPage(); await c.displayed([1]);
      assert.equal(c.f.builds, 1, "history GET must not start a runtime");
      await c.switchBranch("Describe branch A", c.a); await c.displayed([0]);
      await unlink(c.refs[1].path);
      await c.ask("Continue A without sibling B", [0]);
      await writeFile(c.refs[1].path, avi);
      await c.switchBranch("Describe branch B", c.b); await c.displayed([1]);
      await c.ask("Continue B without sibling A", [1]);
      console.log(`PASS ${layout}: real BranchNavigator switches SDK branches; UI/owner bytes exclude sibling media`);

      const historyGate = c.f.historyGate = { started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
      await c.ask("A late history flight belongs to B", [1]);
      await historyGate.started.promise;
      await c.switchBranch("Describe branch A"); await c.displayed([0]);
      // R2: keep the invalidated B flight alive through A's ordinary composer
      // follow-up and completion. The new generation must perform its own GET.
      const readsBeforeA = c.f.history.length;
      const question = "Only A while the stale B history read is still pending";
      try {
        await c.ask(question, [0]);
        const sm = c.runtimes.get(c.source).sm, leaf = sm.getLeafId();
        const owner = sm.getEntries().filter(e => e.message?.role === "user").at(-1);
        await c.page.waitForFunction(leaf => document.querySelector("[data-leaf]")?.getAttribute("data-leaf") === leaf, leaf);
        assert(c.f.history.length > readsBeforeA, "A completion must not join B's invalidated history flight");
        await c.page.waitForFunction(id => {
          const stack = [...window.branchTree];
          while (stack.length) {
            const node = stack.pop();
            if (node.entry.id === id || node.compressedEntryIds?.includes(id)) return true;
            stack.push(...node.children);
          }
          return false;
        }, owner.id);
        const row = c.page.locator(`[data-entry-id="${owner.id}"]`).filter({ has: c.page.getByText(question, { exact: true }) });
        await row.hover();
        for (const name of ["New session", "Edit from here"]) {
          const action = row.getByRole("button", { name, exact: true });
          assert.equal(await action.count(), 1, `${name} requires the new user's native entry ID`);
          assert.equal(await action.isEnabled(), true);
        }
      } finally {
        const lateResponse = c.page.waitForResponse(r => /\/api\/sessions\/[^/]+\?/.test(r.url()));
        historyGate.release.resolve(); await historyGate.finished.promise; await (await lateResponse).finished();
        c.f.historyGate = undefined;
      }
      await c.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await c.displayed([0]);
      assert.equal(await c.page.locator("[data-leaf]").getAttribute("data-leaf"), c.runtimes.get(c.source).sm.getLeafId());
      await c.ask("Only A after the stale B history read", [0]);
      console.log(`PASS ${layout}: A composer completion refreshes native leaf/tree/entry IDs and fork/edit actions while stale B flight is held; its late response cannot poison A`);

      const nav = c.page.waitForResponse(r => r.request().postDataJSON()?.type === "navigate_tree");
      await c.page.locator("[data-owner-boundary]").click(); assert.equal((await nav).status(), 200);
      assert.equal(c.runtimes.get(c.source).sm.getLeafId(), c.originals[0].parentId);
      await c.displayed([]);
      await c.ask("Before the selected video owner", []);
      console.log(`PASS ${layout}: selecting a native user shows SDK parent context, not the excluded video's UI`);

      await c.switchBranch("Describe branch A"); await c.displayed([0]);
      c.f.navigationGate = Promise.withResolvers();
      await c.page.getByRole("button", { name: "Branches", exact: true }).click();
      const pendingRequest = c.page.waitForRequest(r => r.postDataJSON()?.type === "navigate_tree");
      const pendingResponse = c.page.waitForResponse(r => r.request().postDataJSON()?.type === "navigate_tree");
      await c.page.locator("[data-branches]").getByText("Describe branch B", { exact: true }).click();
      await pendingRequest; await c.displayed([0]);
      const beforePrompts = c.f.commands.filter(cmd => cmd.type === "prompt").length, beforeWire = c.f.requests.length;
      await c.page.locator("textarea").fill("Kept while branch navigation is pending");
      await c.page.getByRole("button", { name: "Send", exact: true }).click();
      await c.page.getByText("Wait for branch navigation to finish before sending. Nothing was sent.", { exact: true }).waitFor();
      assert.equal(await c.page.locator("textarea").inputValue(), "Kept while branch navigation is pending");
      assert.equal(c.f.commands.filter(cmd => cmd.type === "prompt").length, beforePrompts);
      assert.equal(c.f.requests.length, beforeWire);
      c.f.navigationGate.resolve(); c.f.navigationGate = undefined;
      assert.equal((await pendingResponse).status(), 200); await c.displayed([1]);
      await c.page.locator("textarea").fill("");
      await c.page.getByRole("button", { name: "Branches", exact: true }).click();
      console.log(`PASS ${layout}: pending navigation keeps acknowledged UI; ordinary Send preserves input with zero prompt/fetch`);

      await c.switchBranch("Describe branch A"); await c.displayed([0]);
      c.f.navigationCancelled = true;
      await c.switchBranch("Describe branch B"); await c.displayed([0]);
      c.f.navigationCancelled = false;
      c.f.navigationFailure = true;
      await c.page.getByRole("button", { name: "Branches", exact: true }).click();
      const rejected = c.page.waitForResponse(r => r.request().postDataJSON()?.type === "navigate_tree");
      await c.page.locator("[data-branches]").getByText("Describe branch B", { exact: true }).click();
      assert.equal((await rejected).status(), 500);
      await c.displayed([0]);
      c.f.navigationFailure = false;
      await c.page.getByRole("button", { name: "Branches", exact: true }).click();
      await c.ask("Rejected navigation keeps source branch A", [0]);
      console.log(`PASS ${layout}: refused navigation cannot display sibling references while sending the old branch`);

      const beforeFiles = await readdir(c.cwd);
      // Fork before the video user: the video is NOT inherited or restored to a draft.
      const beforeChild = await c.forkAt("Describe branch A"); await c.displayed([]);
      await c.ask("Forked before video", []);
      await c.sleep(); await c.page.reload(); await c.displayed([]);
      await c.ask("Cold reopen before-video fork", []);
      assert.equal(SessionManager.open(c.files.get(beforeChild)).getEntries().some(e => e.message?.piWebVideos), false);
      console.log(`PASS ${layout}: user New session forks before video; refresh/cold follow-up has no media`);

      await c.closePage(); await c.openPage(c.source); await c.displayed([0]);
      const afterChild = await c.forkAt("Rejected navigation keeps source branch A"); await c.displayed([0]);
      const changed = Buffer.concat([mp4, Buffer.from("changed after browser fork")]); await writeFile(c.refs[0].path, changed);
      await c.ask("Forked after video", [0], [changed, avi]);
      await c.sleep(); await c.closePage(); await c.openPage(afterChild); await c.displayed([0]);
      await c.ask("Fresh page cold reopen after-video fork", [0], [changed, avi]);
      console.log(`PASS ${layout}: after-video fork preserves native reference and rereads current bytes after fresh-page reopen`);

      await c.page.locator("textarea").fill("/clone");
      const cloned = c.page.waitForResponse(r => r.request().postDataJSON()?.type === "clone");
      await c.page.getByRole("button", { name: "Send", exact: true }).click();
      const cloneResult = await (await cloned).json();
      await c.page.waitForFunction(id => document.querySelector("[data-session]")?.getAttribute("data-session") === id, cloneResult.data.newSessionId);
      await c.displayed([0]); await c.sleep(); await c.page.reload(); await c.displayed([0]);
      await unlink(c.refs[1].path);
      await c.ask("Clone refresh ordinary follow-up", [0], [changed, avi]);
      const saved = SessionManager.open(c.files.get(cloneResult.data.newSessionId)).getEntries().filter(e => e.message?.piWebVideos);
      assert.deepEqual(saved, [c.originals[0]]);
      assert.deepEqual((await readdir(c.cwd)).sort(), beforeFiles.filter(n => n !== "branch-b.avi").sort(), "copy never creates media assets");
      console.log(`PASS ${layout}: composer /clone + reload retain actual user identity, no sibling media/assets`);
    } finally { await c.close(); }
  }
} finally {
  await browser.close(); globalThis.fetch = oldFetch; globalThis.__piAllowedRootsCache = oldRoots;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(sandbox, { recursive: true, force: true });
}
