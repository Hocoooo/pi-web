// Real ChatWindow/useDragDrop/composer/hook -> existing upload POST -> real SDK ->
// native Google adapter/final fetch capture. Only Next URL context, browser HTTP/SSE
// bridges and the final gateway response are supplied by this isolated harness.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const { VIDEO_MODEL_ID, VIDEO_GOOGLE_BASE_URL } = await jiti.import("../lib/video-attachments.ts");
const { encodeFilePathForApi } = await jiti.import("../lib/file-paths.ts");
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
// Valid synthetic 8x8 PNG: the SDK actually decodes images (unlike HTTP-only UI fixtures).
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4z8CAFWEXHbQSACj/P8FTKqelAAAAAElFTkSuQmCC", "base64");
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "video-drop.js", platform: "browser", format: "iife", jsx: "automatic",
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
    window.sources = []; window.uploadRefreshes = 0;
    window.emit = event => window.sources.forEach(s => s.readyState === 1 && s.onmessage?.({data:JSON.stringify(event)}));
    window.EventSource = class {
      readyState = 1;
      constructor() { window.sources.push(this); queueMicrotask(() => this.onmessage?.({data:JSON.stringify({type:"connected"})})); }
      close() { this.readyState = 2; }
    };
    createRoot(document.getElementById("root")).render(<I18nProvider><ChatWindow
      session={window.existing ? {id:window.sessionId,cwd:window.cwd,name:"Video fixture"} : null}
      newSessionCwd={window.cwd} newSessionDraftKey="drop-draft" soundEnabled={false}
      onFilesUploaded={() => window.uploadRefreshes++} /></I18nProvider>);
  ` },
});
const sandbox = await mkdtemp(join(tmpdir(), "pi-web-video-drop-"));
const oldRoots = globalThis.__piAllowedRootsCache, oldFetch = globalThis.fetch;
let activeRequests, modelGate;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, `${VIDEO_GOOGLE_BASE_URL}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`, "no unexpected network calls");
  assert.equal(request.headers.get("authorization"), "Bearer isolated-video-drop-key");
  const raw = await request.text();
  activeRequests.push({ body: JSON.parse(raw), bytes: Buffer.byteLength(raw) });
  await modelGate?.promise;
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Captured video answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });

async function fixture(existing) {
  const dir = await mkdtemp(join(sandbox, "case-")), cwd = join(dir, "workspace");
  await mkdir(cwd);
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Infinity };
  const services = await createAgentSessionServices({ cwd, agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off" }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
  });
  services.modelRuntime.registerProvider("tapsvc", { api: "anthropic-messages", baseUrl: "https://llm-proxy.tapsvc.com", apiKey: "isolated-video-drop-key",
    models: [{ id: VIDEO_MODEL_ID, name: "Isolated Gemini", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
  });
  const sm = SessionManager.create(cwd, join(dir, "sessions"));
  const { session } = await createAgentSessionFromServices({ services, model: services.modelRuntime.getModel("tapsvc", VIDEO_MODEL_ID), thinkingLevel: "high", tools: [], sessionManager: sm });
  const wrapper = new AgentSessionWrapper(session, { headless: true });
  wrapper.start(); wrapper.beginExtensionBinding();
  const page = await browser.newPage({ viewport: existing ? { width: 390, height: 844 } : { width: 1100, height: 850 }, locale: "en-US" });
  page.setDefaultTimeout(10000);
  const errors = [], uploads = [], prompts = [], requests = activeRequests = [];
  let deliveries = Promise.resolve(), holdUpload = false, releaseUpload, failUpload = false;
  const offEvents = wrapper.onEvent(event => { deliveries = deliveries.then(() => page.evaluate(event => window.emit(event), event)); });
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(data => Object.assign(window, data), { cwd, sessionId: wrapper.sessionId, existing });
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    try {
      // Match the layout utilities used by ChatWindow (as in the other video harnesses).
      // Without flex-1 the history collapses and mobile Send sits under the top toast shelf.
      if (url.href === "http://video-drop.test/") return route.fulfill({ contentType: "text/html", body: '<style>html,body,#root{height:100%;margin:0}.chat-content,.h-full{height:100%}.relative{position:relative}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.shrink-0{flex-shrink:0}.min-h-0{min-height:0}.min-w-0,fieldset{min-width:0}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}</style><div id="root"></div>' });
      assert.equal(url.origin, "http://video-drop.test", "browser must not make external requests");
      if (url.pathname.startsWith("/api/files/")) {
        assert.equal(url.searchParams.get("type"), "upload"); assert.equal(url.searchParams.get("conflict"), "skip");
        const data = req.postDataBuffer(), headers = { ...req.headers(), host: "localhost", origin: "http://localhost" };
        const form = await new Request(req.url(), { method: "POST", headers, body: data }).formData();
        uploads.push(await Promise.all(form.getAll("files").map(async f => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) }))));
        if (holdUpload) await new Promise(resolve => { releaseUpload = resolve; });
        if (failUpload) return route.fulfill({ status: 500, json: { error: "fixture upload failure" } });
        const response = await uploadPost(new NextRequest(`http://localhost${url.pathname}${url.search}`, { method: "POST", headers, body: data }), { params: Promise.resolve({ path: encodeFilePathForApi(cwd).split("/") }) });
        return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
      }
      const body = req.method() === "POST" ? req.postDataJSON() : null;
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: { [`tapsvc:${VIDEO_MODEL_ID}`]: "Gemini" }, modelList: [{ provider: "tapsvc", id: VIDEO_MODEL_ID, name: "Gemini" }], defaultModel: { provider: "tapsvc", modelId: VIDEO_MODEL_ID }, defaultThinkingLevel: "high" } });
      if (url.pathname === "/_next/image") return route.fulfill({ contentType: "image/png", body: png });
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [] } });
      if (url.pathname === "/api/app-update") return route.fulfill({ json: { updateAvailable: false } });
      if (url.pathname === "/api/tasks/membership") return route.fulfill({ json: { task: null } });
      const state = await wrapper.send({ type: "get_state" });
      if (url.pathname === "/api/agent/new") {
        assert.equal(body.type, "ensure_session"); assert.equal(body.videos, undefined);
        return route.fulfill({ json: { sessionId: wrapper.sessionId, model: { provider: "tapsvc", modelId: VIDEO_MODEL_ID }, thinkingLevel: "high" } });
      }
      if (url.pathname.endsWith("/state")) return route.fulfill({ json: { running: true, state } });
      if (url.pathname.startsWith("/api/sessions/")) return route.fulfill({ json: { sessionId: wrapper.sessionId, filePath: sm.getSessionFile(), tree: [], treeFormat: "summary", leafId: sm.getLeafId(), snapshotRevision: `fixture-${session.messages.length}`, context: { messages: session.messages, entryIds: sm.getEntries().filter(e => e.type === "message").map(e => e.id), oldestEntryId: null, hasMore: false, model: state.model, thinkingLevel: "high" } } });
      if (url.pathname.startsWith("/api/agent/")) {
        if (!body) return route.fulfill({ json: { running: true, state } });
        if (body.type === "prompt") {
          prompts.push(body);
          const done = Promise.withResolvers();
          const off = wrapper.onEvent(e => { if (e.type === "prompt_done") done.resolve(); });
          try { await wrapper.send(body); await done.promise; await deliveries; }
          finally { off(); }
          return route.fulfill({ json: { success: true, data: {} } });
        }
        return route.fulfill({ json: { success: true, data: await wrapper.send(body) } });
      }
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    } catch (error) {
      errors.push(error.message);
      await route.fulfill({ status: 500, json: { error: error.message, accepted: false } });
    }
  });
  await page.goto("http://video-drop.test/");
  for (const f of outputFiles) {
    if (f.path.endsWith(".css")) await page.addStyleTag({ content: f.text });
    else await page.addScriptTag({ content: f.text });
  }
  await page.locator(".chat-content textarea").waitFor();
  await page.getByRole("button", { name: "Gemini" }).waitFor();
  const input = page.locator("textarea"), card = page.locator("[data-video-attachment]");
  const send = page.getByRole("button", { name: "Send", exact: true });
  const remove = () => page.getByRole("button", { name: "Remove video", exact: true }).click();
  async function drop(files, folders = []) {
    await page.locator("textarea").evaluate((target, { files, folders }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([Uint8Array.from(f.bytes)], f.name, { type: f.type ?? "" }));
      if (folders.length) {
        const items = [...dt.items, ...folders.map(name => ({ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name }), getAsFile: () => null }))];
        Object.defineProperty(dt, "items", { value: items });
      }
      // Dispatch through DOM/React handlers, never call classification or the imperative composer API.
      for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { files: files.map(f => ({ ...f, bytes: [...f.bytes] })), folders });
  }
  return { page, cwd, sm, session, wrapper, uploads, prompts, requests, input, card, send, remove, drop,
    select: (name, bytes, mimeType = "") => page.locator('input[accept=".mp4,.avi"]').setInputFiles({ name, buffer: bytes, mimeType }),
    hold: () => { holdUpload = true; }, release: () => { holdUpload = false; releaseUpload(); }, fail: value => { failUpload = value; },
    holdModel: () => { modelGate = Promise.withResolvers(); }, releaseModel: () => { modelGate?.resolve(); modelGate = undefined; },
    async close() { modelGate?.resolve(); modelGate = undefined; offEvents(); await deliveries; await wrapper.shutdown(); await page.close(); assert.deepEqual(errors, []); },
  };
}
function media(request) {
  return request.body.contents.flatMap((c, index) => c.parts.filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, role: c.role, ...p.inlineData })));
}

try {
  for (const existing of [false, true]) {
    const layout = existing ? "existing/mobile" : "new/desktop";
    for (const [name, bytes, mimeType] of [["CLIP.MP4", mp4, "video/mp4"], ["clip.AVI", avi, "video/avi"]]) {
      const payloads = [];
      for (const entry of ["select", "drop"]) {
        const f = await fixture(existing);
        try {
          await f.input.fill("What is visible?");
          if (entry === "select") await f.select(name, bytes);
          else await f.drop([{ name, bytes }]);
          await f.card.getByText(/Video ready/).waitFor().catch(async error => { throw new Error(`${error.message}\nAttachment: ${await f.card.textContent()}`); });
          assert.equal(await f.input.inputValue(), "What is visible?", "video never becomes an ordinary @mention");
          assert.deepEqual(f.uploads.map(batch => batch.map(file => file.name)), [[name]]);
          assert.deepEqual(await readFile(join(f.cwd, name)), bytes, "existing upload route writes original bytes");
          await f.send.click();
          await f.page.getByText("Captured video answer", { exact: true }).waitFor();
          await f.page.locator("[data-sent-video]").waitFor();
          assert.equal(f.prompts.length, 1); assert.equal(f.requests.length, 1);
          assert.deepEqual(f.prompts[0].videos, [{ version: 1, path: `${f.cwd}/${name}`, mimeType }]);
          const parts = media(f.requests[0]);
          assert.equal(parts.length, 1); assert.equal(parts[0].index, 0); assert.equal(parts[0].role, "user");
          assert.equal(parts[0].mimeType, mimeType); assert.deepEqual(Buffer.from(parts[0].data, "base64"), bytes);
          assert.equal(f.requests[0].body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
          assert.equal(f.session.model.provider, "tapsvc");
          const native = f.session.messages.find(m => m.piWebVideos);
          assert.deepEqual(native.piWebVideos.map(({ version, path, mimeType }) => ({ version, path, mimeType })), f.prompts[0].videos);
          // Selection and drop fixtures have different authorized cwd labels.
          payloads.push(JSON.stringify(f.requests[0].body.contents).replaceAll(f.cwd, "/fixture-workspace"));
          console.log(`PASS ${layout} ${name} ${entry}: UI/upload POST/native owner/final Google bytes/answer`);
        } finally { await f.close(); }
      }
      assert.deepEqual(payloads[1], payloads[0], "drop and selection send identical Google contents");
    }

    const f = await fixture(existing);
    try {
      await f.input.fill("Keep my question");
      await f.drop(Array.from({ length: 5 }, (_, i) => ({ name: `excess-${i}.mp4`, bytes: mp4 })));
      await f.page.getByRole("alert").filter({ hasText: /up to 4 videos/ }).waitFor();
      assert.equal(f.uploads.length, 0); assert.equal(await f.card.count(), 0);
      f.hold();
      await f.drop([{ name: "pending.mp4", bytes: mp4 }]);
      await f.card.getByText(/Uploading video/).waitFor();
      assert.equal(await f.send.isDisabled(), true);
      await f.input.press("Control+Alt+Enter"); assert.equal(f.prompts.length, 0);
      await f.drop(Array.from({ length: 4 }, (_, i) => ({ name: `cannot-replace-${i}.avi`, bytes: avi })));
      await f.page.getByRole("alert").filter({ hasText: /up to 4 videos/ }).waitFor();
      assert.match(await f.card.textContent(), /pending.mp4/); assert.equal(f.uploads.length, 1);
      await f.remove(); f.release();
      await f.page.waitForTimeout(80); assert.equal(await f.card.count(), 0, "removed upload cannot reappear");
      await f.drop([{ name: "ready.mp4", bytes: mp4 }]);
      await f.card.getByText(/Video ready/).waitFor();
      await f.drop(Array.from({ length: 4 }, (_, i) => ({ name: `replacement-${i}.avi`, bytes: avi })));
      await f.page.getByRole("alert").filter({ hasText: /up to 4 videos/ }).waitFor();
      assert.equal(f.uploads.length, 2); assert.match(await f.card.textContent(), /ready.mp4/);
      await f.remove();
      for (const file of [{ name: "bad.mov", type: "video/quicktime", bytes: mp4 }, { name: "bad.mp4", type: "image/png", bytes: png }, { name: "bad.avi", type: "video/mp4", bytes: avi }]) {
        await f.drop([file]);
        await f.card.getByRole("alert").filter({ hasText: /matching file type/ }).waitFor();
        assert.equal(f.uploads.length, 2); assert.equal(await f.send.isDisabled(), true); await f.remove();
      }
      f.fail(true);
      await f.drop([{ name: "failed.mp4", bytes: mp4 }]);
      await f.card.getByRole("alert").filter({ hasText: /fixture upload failure/ }).waitFor();
      await f.drop(Array.from({ length: 4 }, (_, i) => ({ name: `cannot-replace-error-${i}.avi`, bytes: avi })));
      await f.page.getByRole("alert").filter({ hasText: /up to 4 videos/ }).waitFor();
      assert.equal(f.uploads.length, 3); assert.match(await f.card.textContent(), /failed.mp4/); await f.remove(); f.fail(false);
      const existingBytes = Buffer.concat([mp4, Buffer.from("existing file, not new bytes")]);
      await writeFile(join(f.cwd, "same.mp4"), existingBytes);
      await f.drop([{ name: "same.mp4", bytes: mp4 }, { name: "photo.png", type: "image/png", bytes: png }, { name: "notes.txt", type: "text/plain", bytes: Buffer.from("notes") }, { name: "unknown.bin", bytes: Buffer.from("binary") }], ["folder.mp4"]);
      await f.card.getByText(/Not replaced.*referencing the existing file/).waitFor();
      await f.page.getByText(/Folders cannot be dropped here/).waitFor();
      await f.page.locator('img[src^="blob:"]').waitFor();
      await f.page.waitForFunction(() => document.querySelector("textarea").value.includes("@notes.txt") && document.querySelector("textarea").value.includes("@unknown.bin"));
      assert(!await f.input.inputValue().then(value => value.includes("@same.mp4")));
      assert(!f.uploads.flat().some(file => file.name === "photo.png" || file.name === "folder.mp4"));
      assert.deepEqual(await readFile(join(f.cwd, "same.mp4")), existingBytes, "skip never overwrites old content");
      assert.equal(await f.page.evaluate(() => window.uploadRefreshes), 2, "ready upload and ordinary mixed upload refresh; skip does not");
      assert(await f.page.locator(".notice-shelf-item").count() > 0, "mixed-drop notices remain visible");
      assert.equal(await f.send.evaluate(button => {
        const rect = button.getBoundingClientRect();
        return rect.top > innerHeight / 2 && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, "the real bottom composer Send remains pointer-reachable with notices visible");
      f.holdModel();
      await f.send.click();
      await f.page.getByRole("button", { name: "Steer", exact: true }).waitFor();
      const uploadCount = f.uploads.length;
      await f.drop([{ name: "busy.mp4", bytes: mp4 }]);
      await f.page.locator("[data-video-attachment]").getByText(/Video ready/).waitFor();
      assert.equal(f.uploads.length, uploadCount + 1); assert.equal(f.prompts.length, 1, "busy upload does not implicitly submit");
      await f.page.getByRole("button", { name: "Remove video", exact: true }).click();
      f.releaseModel();
      await f.page.getByText("Captured video answer", { exact: true }).waitFor();
      assert.equal(f.prompts.length, 1); assert.equal(f.requests.length, 1);
      assert.deepEqual(Buffer.from(media(f.requests[0])[0].data, "base64"), existingBytes, "skip transmits the existing content, not the dropped bytes");
      assert.deepEqual(Buffer.from(f.prompts[0].images[0].data, "base64"), png);
      const image = f.requests[0].body.contents[0].parts.find(p => p.inlineData?.mimeType === "image/png");
      assert(image, "mixed-drop image must reach the final Google request beside the video");
      assert.deepEqual(Buffer.from(image.inlineData.data, "base64"), png);
      console.log(`PASS ${layout}: multi/existing/pending/error conflicts, MIME, busy, late removal, skip + mixed image/file/folder and original wire`);
    } finally { await f.close(); }
  }
} finally {
  await browser.close(); globalThis.fetch = oldFetch; globalThis.__piAllowedRootsCache = oldRoots;
  await rm(sandbox, { recursive: true, force: true });
}
