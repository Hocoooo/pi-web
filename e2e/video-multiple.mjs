// Mounted ChatWindow/useDragDrop/composer/useAgentSession. HTTP/SSE are fixtures;
// this tests client arrays and recovery, not provider wire limits or reception.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "video-multiple.js", platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  plugins: [{ name: "navigation", setup(build) {
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(location.search);" }));
  } }],
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React,{useRef} from "react"; import {createRoot} from "react-dom/client";
    import {ChatWindow} from "./components/ChatWindow"; import {I18nProvider} from "./hooks/useI18n";
    window.sources=[];
    window.emit=event=>window.sources.forEach(s=>s.readyState===1&&s.onmessage?.({data:JSON.stringify(event)}));
    window.EventSource=class {readyState=1;constructor(){window.sources.push(this);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:"connected"})}));}close(){this.readyState=2;}};
    function App(){const ref=useRef(null);window.composer=ref;return <I18nProvider><ChatWindow
      session={{id:"multi-session",cwd:"/video-workspace",name:"Multi video"}} chatInputRef={ref} soundEnabled={false}/></I18nProvider>;}
    createRoot(document.getElementById("root")).render(<App/>);
  ` },
});
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  for (const viewport of [{ width: 1100, height: 850 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, locale: "en-US" });
    page.setDefaultTimeout(10000);
    const errors = [], uploads = [], prompts = [], recalls = [], history = [];
    page.on("pageerror", error => errors.push(error.message));
    let rejectPrompt = true, failedFile, heldFile, releaseUpload, loseRecall = false;
    let queue = { steering: [], followUp: [] };
    const state = () => ({ isStreaming: false, isPromptRunning: false, model: { provider: "tapsvc", id: "google/gemini-3.8-flash" }, thinkingLevel: "off",
      steeringMessages: queue.steering.map(i => i.text), followUpMessages: queue.followUp.map(i => i.text),
      queuedMessages: { steering: queue.steering.map(i => i.text), followUp: queue.followUp.map(i => i.text), inputs: queue } });
    const native = (text, videos) => ({ role: "user", content: text, timestamp: Date.now(), piWebVideos: videos });
    await page.route("http://video-multiple.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<style>html,body,#root{height:100%;margin:0}.chat-content,.h-full{height:100%}.relative{position:relative}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.min-w-0,fieldset{min-width:0}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}</style><div id="root"></div>' });
      if (url.pathname.startsWith("/api/files/")) {
        const form = await new Request(request.url(), { method: "POST", headers: request.headers(), body: request.postDataBuffer() }).formData();
        const file = form.get("files");
        uploads.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
        assert.equal(url.searchParams.get("conflict"), "skip");
        if (file.name === heldFile) await new Promise(resolve => { releaseUpload = resolve; });
        if (file.name === failedFile) return route.fulfill({ status: 500, json: { error: "fixture failed file" } });
        return route.fulfill({ json: { uploaded: [file.name] } });
      }
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: { "tapsvc:google/gemini-3.8-flash": "Gemini" }, modelList: [{ provider: "tapsvc", id: "google/gemini-3.8-flash", name: "Gemini" }], defaultModel: { provider: "tapsvc", modelId: "google/gemini-3.8-flash" }, defaultThinkingLevel: "off" } });
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: [] } });
      if (url.pathname === "/api/app-update") return route.fulfill({ json: { updateAvailable: false } });
      if (url.pathname === "/api/tasks/membership") return route.fulfill({ json: { task: null } });
      if (url.pathname.endsWith("/next-cue")) return route.fulfill({ status: 204 });
      if (url.pathname.endsWith("/state")) return route.fulfill({ json: { running: true, state: state() } });
      if (url.pathname.startsWith("/api/sessions/")) return route.fulfill({ json: { sessionId: "multi-session", filePath: "", tree: [], treeFormat: "summary", snapshotRevision: `revision-${history.length}`, leafId: null,
        context: { messages: history, entryIds: history.map((_, i) => `entry-${i}`), oldestEntryId: null, hasMore: false, model: state().model, thinkingLevel: "off" } } });
      if (url.pathname.startsWith("/api/agent/")) {
        const body = request.method() === "POST" ? request.postDataJSON() : null;
        if (body?.type === "prompt") {
          prompts.push(body);
          if (rejectPrompt) return route.fulfill({ status: 500, json: { error: "fixture preflight rejection", code: "prompt_rejected", accepted: false } });
          const message = native(body.message, body.videos?.map((video, i) => ({ ...video, id: `sent-${prompts.length}-${i}` })));
          history.push(message);
          await page.evaluate(message => window.emit({ type: "message_end", message }), message);
          await route.fulfill({ json: { success: true, data: {} } });
          await page.evaluate(() => window.emit({ type: "prompt_done" }));
          return;
        }
        if (body?.type === "clear_queue") {
          recalls.push(body);
          const inputs = queue;
          assert.deepEqual(body.recallInputs, inputs);
          queue = { steering: [], followUp: [] };
          await page.evaluate(() => window.emit({ type: "queue_update", steering: [], followUp: [], inputs: { steering: [], followUp: [] } }));
          if (loseRecall) return route.abort("failed");
          return route.fulfill({ json: { success: true, data: { steering: inputs.steering.map(i => i.text), followUp: inputs.followUp.map(i => i.text), inputs } } });
        }
        return route.fulfill({ json: body ? { success: true, data: body.type === "get_state" ? state() : {} } : { running: true, state: state() } });
      }
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    });
    await page.goto("http://video-multiple.test/");
    for (const file of outputFiles) {
      if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
      else await page.addScriptTag({ content: file.text });
    }
    const input = page.locator("textarea"), cards = page.locator("[data-video-attachment]"), send = page.getByRole("button", { name: "Send", exact: true });
    await input.waitFor(); await page.getByRole("button", { name: "Gemini", exact: true }).waitFor();
    const drop = files => input.evaluate((target, files) => {
      const dataTransfer = new DataTransfer();
      for (const file of files) dataTransfer.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: file.name.endsWith(".avi") ? "video/x-msvideo" : "video/mp4" }));
      for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }, files.map(name => ({ name, bytes: [...(name.endsWith(".avi") ? avi : mp4)] })));
    const waitCount = count => page.waitForFunction(count => document.querySelectorAll("[data-video-attachment]").length === count, count);
    const readyCount = count => page.waitForFunction(count => [...document.querySelectorAll("[data-video-attachment]")].filter(e => e.textContent.includes("Video ready")).length === count, count);
    const remove = name => cards.filter({ hasText: name }).getByRole("button", { name: "Remove video", exact: true }).click();
    await input.fill("Compare these videos");
    heldFile = "one.mp4";
    await drop(["one.mp4", "two.avi"]); await waitCount(2);
    for (let wait = 0; !releaseUpload && wait < 100; wait++) await page.waitForTimeout(10);
    assert(releaseUpload, "first upload reached the held response");
    await drop(["three.mp4"]); await waitCount(3);
    assert.deepEqual(uploads.map(f => f.name), ["one.mp4"], "later batch/drop waits behind the first selection");
    assert.equal(await send.isDisabled(), true);
    heldFile = undefined; releaseUpload(); await readyCount(3);
    assert.deepEqual(uploads.map(f => f.name), ["one.mp4", "two.avi", "three.mp4"]);
    assert.deepEqual(uploads.find(f => f.name === "one.mp4").bytes, mp4);
    assert.deepEqual(uploads.find(f => f.name === "two.avi").bytes, avi);
    await remove("two.avi"); await waitCount(2);
    failedFile = "failed.avi";
    await drop([failedFile]); await cards.getByRole("alert").filter({ hasText: "fixture failed file" }).waitFor();
    assert.equal(await send.isDisabled(), true);
    await input.press("Enter"); assert.equal(prompts.length, 0);
    heldFile = "pending.mp4";
    await drop([heldFile]); await cards.getByRole("status").filter({ hasText: "Uploading video" }).waitFor();
    await drop(["over-cap.mp4"]);
    await page.getByRole("alert").filter({ hasText: "Attach up to 4 videos" }).waitFor();
    assert.equal(uploads.some(f => f.name === "over-cap.mp4"), false);
    await remove(failedFile); assert.equal(await send.isDisabled(), true, "remaining upload still blocks Send");
    await remove(heldFile); releaseUpload(); await page.waitForTimeout(80); await readyCount(2);
    assert.equal(await cards.count(), 2, "late removed upload cannot return");
    await page.locator('input[accept=".mp4,.avi"]').setInputFiles([
      { name: "four.avi", mimeType: "video/avi", buffer: avi }, { name: "five.mp4", mimeType: "video/mp4", buffer: mp4 },
    ]);
    await readyCount(4);
    assert.equal(await page.getByRole("button", { name: "Attach video (MP4/AVI)", exact: true }).isDisabled(), true);
    await remove("four.avi"); await remove("five.mp4");
    await send.click();
    await page.getByText("fixture preflight rejection", { exact: true }).waitFor(); await readyCount(2);
    assert.equal(await input.inputValue(), "Compare these videos");
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].videos.map(v => v.path), ["/video-workspace/one.mp4", "/video-workspace/three.mp4"]);
    rejectPrompt = false;
    await send.click();
    await page.waitForFunction(() => document.querySelectorAll("[data-sent-video]").length === 2);
    await send.waitFor(); assert.equal(await cards.count(), 0);
    assert.deepEqual(prompts[1].videos, prompts[0].videos);

    // Recall combines separate SDK input rows within the cap, preserving every
    // UUID in the snapshot and retaining it until every native owner is seen.
    const refs = ["recall-one.mp4", "recall-two.avi"].map((name, i) => ({ version: 1, id: `recall-${i}`, path: `/video-workspace/${name}`, mimeType: i ? "video/avi" : "video/mp4" }));
    const showQueue = async refs => {
      queue = { steering: [{ text: "First queued question", videos: [refs[0]] }], followUp: [{ text: "Second queued question", videos: refs.slice(1) }] };
      await page.evaluate(inputs => window.emit({ type: "queue_update", steering: inputs.steering.map(i => i.text), followUp: inputs.followUp.map(i => i.text), inputs }), queue);
    };
    await showQueue(refs);
    await page.waitForFunction(() => document.querySelectorAll("[data-queued-video]").length === 2);
    await page.getByRole("button", { name: "Recall to input", exact: true }).click(); await readyCount(2);
    assert.equal(await input.inputValue(), "First queued question\n\nSecond queued question");
    assert.equal(recalls.length, 1);
    await input.fill(""); await remove("recall-one.mp4"); await remove("recall-two.avi");
    await showQueue(refs); loseRecall = true;
    await page.getByRole("button", { name: "Recall to input", exact: true }).click();
    await page.locator("[data-unconfirmed-submission]").waitFor();
    assert.equal(await cards.count(), 0);
    const first = native("First queued question", [refs[0]]); history.push(first);
    await page.evaluate(message => window.emit({ type: "message_end", message }), first);
    assert.equal(await page.locator("[data-unconfirmed-submission]").count(), 1, "one UUID cannot confirm the whole recall");
    await page.getByRole("button", { name: "Check and restore saved input", exact: true }).click();
    await page.getByText(/matching video question may have been transformed and received/).waitFor();
    assert.equal(await cards.count(), 0, "partly consumed snapshot cannot restore duplicate video");
    const second = native("Second queued question", [refs[1]]); history.push(second);
    await page.evaluate(message => window.emit({ type: "message_end", message }), second);
    // Idle SSE messages are deliberately ignored; a fresh authoritative read
    // confirms owners without resurrecting a finished streaming run.
    await page.getByRole("button", { name: "Check and restore saved input", exact: true }).click();
    await page.locator("[data-unconfirmed-submission]").waitFor({ state: "detached" });
    assert.equal(recalls.length, 2, "unknown clear never retries automatically");
    assert.equal(prompts.length, 2, "recall and confirmation never send prompts");
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width < 500 ? "mobile" : "desktop"}: multi-drop/append/remove/cap/failure/pending gates/chooser/rejection/native arrays/multi-row Recall/all UUID confirmation`);
    await page.close();
  }
} finally { await browser.close(); }
