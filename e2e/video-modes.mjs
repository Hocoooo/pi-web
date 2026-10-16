// Ticket08 only: reuse the mounted ChatWindow/HTTP bridge/final-fetch seam.
// Real new/existing agent, history, default-cwd and upload handlers + SDK startup.
// Temporary settings/credentials/media; final gateway responses are synthetic.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { startRpcSession, getRpcSession } = await jiti.import("../lib/rpc-manager.ts");
const { POST: newPost } = await jiti.import("../app/api/agent/new/route.ts");
const { POST: agentPost, GET: agentGet } = await jiti.import("../app/api/agent/[id]/route.ts");
const { GET: historyGet } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { POST: uploadPost } = await jiti.import("../app/api/files/[...path]/route.ts");
const { POST: defaultCwdPost } = await jiti.import("../app/api/default-cwd/route.ts");
const { VIDEO_MODEL_ID, VIDEO_GOOGLE_BASE_URL } = await jiti.import("../lib/video-attachments.ts");
const { encodeFilePathForApi } = await jiti.import("../lib/file-paths.ts");
const { invalidateSessionListCache, invalidateSessionManagerCache } = await jiti.import("../lib/session-reader.ts");
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4z8CAFWEXHbQSACj/P8FTKqelAAAAAElFTkSuQmCC", "base64");
const { outputFiles } = await build({ absWorkingDir: root, bundle: true, write: false, outfile: "video-modes.js", platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  plugins: [{ name: "url-context", setup(build) { build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" })); build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(location.search);" })); } }],
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React,{useState} from "react"; import {createRoot} from "react-dom/client";
    import {ChatWindow} from "./components/ChatWindow"; import {I18nProvider} from "./hooks/useI18n";
    import {getDraft} from "./lib/draft-store"; window.readDraft=getDraft;
    window.sources=[]; window.emit=(id,event)=>window.sources.forEach(s=>s.id===id&&s.readyState===1&&s.onmessage?.({data:JSON.stringify(event)}));
    window.EventSource=class {readyState=1;constructor(url){this.id=url.split("/")[3];window.sources.push(this);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:"connected"})}));}close(){this.readyState=2;}};
    function App(){const [session,setSession]=useState(window.initialSession);return <I18nProvider><ChatWindow
      session={session} newSessionCwd={window.cwd} independentChat={window.noProject} newSessionDraftKey="modes-draft"
      soundEnabled={false} onSessionCreated={setSession}/></I18nProvider>;}
    createRoot(document.getElementById("root")).render(<App/>);
  ` } });
const sandbox = await mkdtemp(join(tmpdir(), "pi-video08-ui-"));
const envKeys = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_WEB_DISABLE_MCP"];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const previousRoots = globalThis.__piAllowedRootsCache, previousAdditional = globalThis.__piAdditionalAllowedRoots, previousFetch = globalThis.fetch;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
let active;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init), f = active;
  const raw = await req.text(), body = JSON.parse(raw);
  const video = body.contents?.flatMap(c => c.parts ?? []).some(p => p.inlineData?.mimeType.startsWith("video/"));
  assert.equal(req.url, `${video ? VIDEO_GOOGLE_BASE_URL : "https://text-only.invalid/v1beta"}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`, "no uncaptured network request");
  if (video) assert.equal(req.headers.get("authorization"), "Bearer isolated-video08-key");
  f.requests.push({ url: req.url, body });
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `Captured mode answer ${f.requests.length}` }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const model = { id: VIDEO_MODEL_ID, name: "Video Gemini", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 };
const modelsData = { models: { [`tapsvc:${VIDEO_MODEL_ID}`]: "Video Gemini", [`other-google:${VIDEO_MODEL_ID}`]: "Other Gemini" },
  modelList: [{ ...model, provider: "tapsvc" }, { ...model, name: "Other Gemini", provider: "other-google" }], defaultModel: { provider: "other-google", modelId: VIDEO_MODEL_ID }, defaultThinkingLevel: "medium",
  thinkingLevels: { [`tapsvc:${VIDEO_MODEL_ID}`]: ["off", "low", "medium", "high"], [`other-google:${VIDEO_MODEL_ID}`]: ["off", "low", "medium", "high"] } };
async function fixture({ noProject, chatOnly, existing }) {
  const dir = await mkdtemp(join(sandbox, "case-")), agentDir = join(dir, "agent"), project = join(dir, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true }); await mkdir(project);
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1"; process.env.PI_WEB_DISABLE_MCP = "1";
  globalThis.__piAdditionalAllowedRoots = new Set(); globalThis.__piAllowedRootsCache = { roots: new Set([project]), expiresAt: Infinity };
  const settingsPath = join(agentDir, "settings.json"), modelsPath = join(agentDir, "models.json");
  await writeFile(settingsPath, JSON.stringify({ defaultProvider: "other-google", defaultModel: VIDEO_MODEL_ID, defaultThinkingLevel: "medium", defaultTools: ["read"], compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off", packages: [] }));
  await writeFile(modelsPath, JSON.stringify({ providers: {
    tapsvc: { api: existing ? "anthropic-messages" : "google-generative-ai", baseUrl: "https://llm-proxy.tapsvc.com", apiKey: "isolated-video08-key", models: [model] },
    "other-google": { api: "google-generative-ai", baseUrl: "https://text-only.invalid/v1beta", apiKey: "isolated-text08-key", models: [{ ...model, name: "Other Gemini" }] },
  } }));
  await writeFile(join(agentDir, "AGENTS.md"), "GLOBAL_VIDEO08_CONTEXT");
  // A real discovered extension must remain absent from Chat-only sessions.
  await writeFile(join(agentDir, "extensions", "marker.ts"), `export default function(pi){pi.registerTool({name:"video08_marker",label:"Marker",description:"Isolated resource marker",parameters:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:"unused"}]})});}`);
  const cwd = noProject ? (await (await defaultCwdPost()).json()).cwd : project;
  assert.equal(cwd, noProject ? join(agentDir, "chat-workspace") : project);
  await writeFile(join(cwd, "AGENTS.md"), "WORKSPACE_VIDEO08_CONTEXT");
  const frozen = [await readFile(settingsPath, "utf8"), await readFile(modelsPath, "utf8")];
  const f = active = { requests: [], commands: [], uploads: [], errors: [], wrapper: null, ensureCalls: 0 };
  if (existing) {
    f.wrapper = (await startRpcSession(`__video08_${dir}`, "", cwd, { headless: true, ...(chatOnly ? { toolNames: [] } : {}) })).session;
    await f.wrapper.send({ type: "set_session_name", name: "Video08 fixture" });
    const done = Promise.withResolvers(), off = f.wrapper.onEvent(e => { if (e.type === "prompt_done") done.resolve(); });
    await f.wrapper.send({ type: "prompt", message: "Earlier ordinary text question" }); await done.promise; off();
    assert.equal(f.wrapper.inner.model.provider, "other-google");
  }
  const page = await browser.newPage({ viewport: existing ? { width: 390, height: 844 } : { width: 1100, height: 850 }, locale: "en-US" }); page.setDefaultTimeout(12000);
  page.on("pageerror", e => f.errors.push(e.message));
  let deliveries = Promise.resolve(), offEvents;
  function attach() {
    assert(f.wrapper); const w = f.wrapper;
    offEvents = w.onEvent(event => { deliveries = deliveries.then(() => page.evaluate(({ id, event }) => window.emit(id, event), { id: w.sessionId, event })); });
    f.tools = [...w.inner.getActiveToolNames()].sort();
    assert.equal(w.isChatOnly(), chatOnly); assert.equal(w.inner.getAllTools().some(tool => tool.name === "video08_marker"), !chatOnly);
    if (chatOnly) assert.deepEqual(f.tools, []); else assert(f.tools.includes("read"), "normal configured loadout remains present");
    f.exact = w.inner.resourceLoader.getAgentsFiles().agentsFiles.map(file => file.content).join("\n\n");
  }
  if (f.wrapper) attach();
  await page.addInitScript(data => {
    Object.assign(window, data); localStorage.setItem("pi-tool-preset", data.chatOnly ? "none" : "configured");
    window.promptCompletions = 0;
    const native = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await native(input, init);
      if (init?.method === "POST" && JSON.parse(init.body ?? "{}").type === "prompt") {
        const json = response.json.bind(response);
        response.json = async () => { try { return await json(); } finally { window.promptCompletions++; } };
      }
      return response;
    };
  }, { cwd, noProject, chatOnly, initialSession: existing ? { id: f.wrapper.sessionId, cwd, name: "Video08 fixture", ...(noProject ? { sessionKind: "chat", projectKey: "pi-web:chat" } : {}) } : null });
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    try {
      assert.equal(url.origin, "http://video-modes.test", "browser network is isolated");
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<style>html,body,#root{height:100%;margin:0}.chat-content,.h-full{height:100%}.relative{position:relative}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.min-w-0,fieldset{min-width:0}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}</style><div id="root"></div>' });
      if (url.pathname === "/api/models") return route.fulfill({ json: modelsData });
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [] } });
      if (url.pathname === "/api/app-update") return route.fulfill({ json: { updateAvailable: false } });
      if (url.pathname === "/api/tasks/membership") return route.fulfill({ json: { task: null } });
      if (url.pathname.endsWith("/next-cue")) return route.fulfill({ status: 204 });
      if (url.pathname === "/_next/image") return route.fulfill({ contentType: "image/png", body: png });
      let result;
      if (url.pathname.startsWith("/api/files/")) {
        assert.equal(url.pathname, `/api/files/${encodeFilePathForApi(cwd)}`); assert.equal(url.searchParams.get("conflict"), "skip");
        f.uploads.push(url.href);
        result = await uploadPost(new NextRequest(`http://localhost${url.pathname}${url.search}`, { method: "POST", headers: { ...req.headers(), host: "localhost", origin: "http://localhost" }, body: req.postDataBuffer() }), { params: Promise.resolve({ path: encodeFilePathForApi(cwd).split("/") }) });
      } else if (url.pathname === "/api/agent/new") {
        const body = req.postDataJSON(); f.commands.push(body); f.ensureCalls++;
        assert.equal(body.type, "ensure_session"); assert.equal(body.videos, undefined); assert.equal(body.cwd, cwd);
        assert.equal(body.provider, "tapsvc"); assert.equal(body.modelId, VIDEO_MODEL_ID); assert.equal(body.thinkingLevel, "high");
        assert.deepEqual(body.toolNames, chatOnly ? [] : undefined);
        result = await newPost(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ ...body, headless: true }) }));
        const data = await result.clone().json(); assert.equal(result.status, 200, JSON.stringify(data));
        f.wrapper = getRpcSession(data.sessionId); await f.wrapper.send({ type: "set_session_name", name: "Video08 fixture" }); attach();
      } else {
        const id = f.wrapper?.sessionId; assert(id && url.pathname.includes(id), `unexpected fixture request ${url.pathname}`);
        const params = { params: Promise.resolve({ id }) };
        if (req.method() === "POST") {
          const body = req.postDataJSON(); f.commands.push(body);
          result = await agentPost(new Request(`http://localhost${url.pathname}`, { method: "POST", body: JSON.stringify(body) }), params);
        } else if (url.pathname === `/api/sessions/${id}`) result = await historyGet(new Request(`http://localhost${url.pathname}${url.search}`), params);
        else result = await agentGet(new Request(`http://localhost${url.pathname}`), params);
      }
      return route.fulfill({ status: result.status, contentType: "application/json", body: await result.text() });
    } catch (error) { f.errors.push(error.stack); return route.fulfill({ status: 500, json: { error: error.message } }); }
  });
  await page.goto("http://video-modes.test/");
  for (const file of outputFiles) { if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text }); else await page.addScriptTag({ content: file.text }); }
  const input = page.locator("textarea"), send = page.getByRole("button", { name: "Send", exact: true }), card = page.locator("[data-video-attachment]");
  await input.waitFor(); await page.getByRole("button", { name: "Other Gemini", exact: true }).waitFor();
  return Object.assign(f, { page, input, send, card, cwd,
    async choose(name) {
      await page.getByRole("button", { name: /^(Other|Video) Gemini$/ }).click();
      await page.getByRole("option").filter({ hasText: name }).click();
      await page.getByRole("listbox", { name: /thinking|reasoning/i }).waitFor();
      await page.getByRole("option").filter({ hasText: /^high$/i }).click();
      await page.getByRole("listbox", { name: /thinking|reasoning/i }).waitFor({ state: "hidden" });
      await page.getByRole("button", { name, exact: true }).waitFor();
    },
    async submit() {
      const before = await page.evaluate(() => window.promptCompletions); await send.click();
      await page.waitForFunction(count => window.promptCompletions === count, before + 1);
      await f.wrapper.inner.waitForIdle(); await deliveries;
      await send.waitFor();
    },
    async close() {
      offEvents?.(); await f.wrapper?.shutdown(); await deliveries; await page.close();
      assert.deepEqual(f.errors, []); assert.deepEqual([await readFile(settingsPath, "utf8"), await readFile(modelsPath, "utf8")], frozen, "session/video/model operations never rewrite settings/provider config");
      invalidateSessionListCache(); invalidateSessionManagerCache();
    },
  });
}
function videos(request) { return request.body.contents.flatMap((c, index) => (c.parts ?? []).filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, role: c.role, ...p.inlineData }))); }
try {
  for (const noProject of [false, true]) for (const chatOnly of [false, true]) for (const existing of [false, true]) {
    const label = `${noProject ? "no-project" : "project"}/${chatOnly ? "Chat-only" : "normal"}/${existing ? "existing-mobile-Anthropic" : "new-desktop-Google"}`;
    const f = await fixture({ noProject, chatOnly, existing });
    try {
      const bytes = existing ? avi : mp4, name = existing ? "mode.avi" : "mode.mp4", mimeType = existing ? "video/avi" : "video/mp4";
      await f.input.fill("What is visible in this clip?");
      await f.page.locator('input[accept=".mp4,.avi"]').setInputFiles({ name, buffer: bytes, mimeType });
      await f.card.getByText(/Video ready/).waitFor(); assert.deepEqual(await readFile(join(f.cwd, name)), bytes);
      assert.equal(await f.send.isDisabled(), true, "unsupported current provider blocks a new attachment");
      assert.equal(await f.input.inputValue(), "What is visible in this clip?");
      assert.equal(f.ensureCalls, 0, "attaching does not create or switch the runtime");
      const firstRequest = f.requests.length;
      console.log(`PASS ${label}: unsupported initial selection retains question/reference; zero implicit create/switch/send`);
      await f.choose("Video Gemini");
      await f.submit(); await f.page.getByText(`Captured mode answer ${firstRequest + 1}`, { exact: true }).waitFor();
      await f.page.locator("[data-sent-video]").waitFor(); assert.equal(f.ensureCalls, existing ? 0 : 1);
      assert.equal(f.wrapper.inner.model.provider, "tapsvc"); assert.equal(f.wrapper.inner.model.id, VIDEO_MODEL_ID);
      const wire = f.requests.at(-1), parts = videos(wire);
      for (const tool of (wire.body.tools ?? []).flatMap(group => group.functionDeclarations ?? [])) {
        assert(f.tools.includes(tool.name), "final request declares only tools already active before the video");
      }
      assert.equal(parts.length, 1); assert.equal(parts[0].role, "user"); assert.equal(parts[0].mimeType, mimeType); assert.deepEqual(Buffer.from(parts[0].data, "base64"), bytes);
      assert.equal(wire.body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
      if (chatOnly) { assert.equal(wire.body.systemInstruction.parts.map(p => p.text).join("\n\n"), f.exact); assert.equal(wire.body.tools?.length ?? 0, 0); }
      const owners = structuredClone(f.wrapper.inner.sessionManager.getEntries().filter(e => e.message?.piWebVideos));
      assert.equal(owners.length, 1); assert.equal(await f.card.count(), 0);
      console.log(`PASS ${label}: current selected first video/upload cwd/SDK final bytes/resource policy`);

      await f.choose("Other Gemini");
      await f.input.fill("Keep this follow-up and PNG");
      await f.page.locator('input[accept="image/*"]').setInputFiles({ name: "pixel.png", buffer: png, mimeType: "image/png" });
      await f.page.locator('fieldset img[src^="blob:"]').waitFor();
      const count = f.requests.length, users = f.wrapper.inner.messages.filter(m => m.role === "user").length;
      await f.submit(); await f.page.getByText(/Video requires tapsvc/).waitFor();
      await f.page.waitForFunction(() => document.querySelector("textarea").value === "Keep this follow-up and PNG").catch(async error => {
        throw new Error(`${error.message}\nRecovery state: ${JSON.stringify(await f.page.evaluate(id => ({ value: document.querySelector("textarea")?.value, draft: window.readDraft(id), completions: window.promptCompletions }), f.wrapper.sessionId))}`);
      });
      assert.equal(f.requests.length, count); assert.equal(f.wrapper.inner.model.provider, "other-google");
      assert.equal(f.wrapper.inner.messages.filter(m => m.role === "user").length, users, "not accepted or persisted");
      assert.equal(await f.card.count(), 0); assert.equal(await f.page.locator("fieldset img").count(), 1);
      const draft = await f.page.evaluate(id => window.readDraft(id), f.wrapper.sessionId);
      assert.deepEqual(draft, { value: "Keep this follow-up and PNG", images: [{ data: png.toString("base64"), mimeType: "image/png" }] });
      console.log(`PASS ${label}: effective video + unsupported same-id provider rejects; text/PNG draft recoverable; no switch/fetch`);

      await f.choose("Video Gemini"); await f.submit();
      await f.page.getByText(`Captured mode answer ${count + 1}`, { exact: true }).waitFor();
      assert.equal(f.requests.length, count + 1); assert.deepEqual(Buffer.from(videos(f.requests.at(-1))[0].data, "base64"), bytes);
      const image = f.requests.at(-1).body.contents.at(-1).parts.find(p => p.inlineData?.mimeType === "image/png");
      assert.deepEqual(Buffer.from(image.inlineData.data, "base64"), png);
      assert.deepEqual(f.wrapper.inner.sessionManager.getEntries().filter(e => e.message?.piWebVideos), owners);
      assert.deepEqual([...f.wrapper.inner.getActiveToolNames()].sort(), f.tools); assert.equal(await f.input.inputValue(), "");
      assert(!f.commands.some(c => c.type === "set_tools"));
      console.log(`PASS ${label}: switch back + explicit Send keeps original owner/current bytes/PNG/tools`);

      const outside = join(sandbox, "outside.mp4"), linked = join(f.cwd, "escape.mp4"); await writeFile(outside, mp4); await symlink(outside, linked);
      for (const path of [outside, linked]) {
        const result = await agentPost(new Request("http://localhost/api/agent/test", { method: "POST", body: JSON.stringify({ type: "prompt", message: "Must not widen roots", videos: [{ version: 1, path, mimeType: "video/mp4" }] }) }), { params: Promise.resolve({ id: f.wrapper.sessionId }) });
        const data = await result.json(); assert.equal(result.status, 500); assert.equal(data.accepted, false); assert.match(data.error, /outside the allowed/);
      }
      assert.equal(f.requests.length, count + 1); assert.deepEqual([...f.wrapper.inner.getActiveToolNames()].sort(), f.tools);
      console.log(`PASS ${label}: out-of-root and link-target refusal + unchanged settings/provider/tools`);
    } finally { await f.close(); }
  }
} finally {
  await browser.close(); globalThis.fetch = previousFetch; globalThis.__piAllowedRootsCache = previousRoots; globalThis.__piAdditionalAllowedRoots = previousAdditional;
  for (const key of envKeys) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
  await rm(sandbox, { recursive: true, force: true });
}
