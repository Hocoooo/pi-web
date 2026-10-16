// Mounted composer + real useAgentSession + MessageView. HTTP/SSE are fixtures;
// native Google bytes/auth are tested separately in lib/video-transport.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const mp4 = await readFile(new URL("../lib/fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("../lib/fixtures/video-attachments/blue.avi", import.meta.url));
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=","base64");
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, {useRef, useState} from "react";
    import {createRoot} from "react-dom/client";
    import {I18nProvider} from "./hooks/useI18n";
    import {useAgentSession} from "./hooks/useAgentSession";
    import {ChatInput} from "./components/ChatInput";
    import {MessageView} from "./components/MessageView";
    window.sources = [];
    window.emit = event => window.sources.forEach(s => s.readyState === 1 && s.onmessage?.({data: JSON.stringify(event)}));
    window.EventSource = class {
      readyState = 1;
      constructor() { window.sources.push(this); queueMicrotask(() => this.onmessage?.({data: JSON.stringify({type:"connected"})})); }
      close() { this.readyState = 2; }
    };
    function App() {
      const ref = useRef(null);
      const [busy,setBusy] = useState(false);
      const [model,setModel] = useState({provider:"tapsvc",modelId:"google/gemini-3.8-flash"});
      window.setBusy = setBusy; window.setModel = setModel;
      const chat = useAgentSession({session: window.existing ? {id:"fixture-session",cwd:"/video-workspace",name:"Fixture"} : null,
        newSessionCwd:"/video-workspace", newSessionDraftKey:"video-draft",chatInputRef:ref});
      window.chat = chat;
      return <I18nProvider>
        <ChatInput key={chat.messages.length ? "history" : "empty"} ref={ref}
          draftKey={window.existing ? "fixture-session" : "video-draft"} cwd="/video-workspace"
          isStreaming={busy || chat.agentRunning} onAbort={chat.handleAbort} onSend={chat.handleSend}
          onSteer={chat.handleSteer} onFollowUp={chat.handleFollowUp} model={model}
          unconfirmedSubmission={chat.unconfirmedSubmission} unconfirmedSubmissionError={chat.error} restoringSubmission={chat.restoringSubmission}
          onRestoreUnconfirmedSubmission={chat.restoreUnconfirmedSubmission}
          onBuiltinCommand={async () => {window.builtins++;return {handled:true};}} />
        {chat.messages.map((m,i) => <MessageView key={i} message={m}/>)}
      </I18nProvider>;
    }
    createRoot(document.getElementById("root")).render(<App/>);
  ` },
});
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  for (const [existing, viewport, mode] of [false,true].flatMap(existing =>
    ["basic","unknown-none","unknown-text","unknown-image","unknown-history","unknown-sse","unknown-late"].map(mode =>
      [existing, existing ? {width:390,height:844} : {width:1100,height:850}, mode]))) {
    const page = await browser.newPage({ viewport, locale: "en-US" });
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));
    await page.addInitScript(existing => {window.existing=existing;window.builtins=0;}, existing);
    let uploads = [], prompts = [], history = [], rejectPrompt = false, uploadResult = "uploaded", releaseUpload;
    let holdUpload = false, promptOutcome = mode === "basic" ? "accepted" : "abort", lastNative;
    let ensureCalls = 0, historyReadFail = false;
    const withVideo = mode !== "unknown-text" && mode !== "unknown-image";
    const withImage = mode !== "unknown-text";
    const nativeMessage = body => ({role:"user",content:body.images?.length ? [{type:"text",text:body.message},...body.images] : body.message,
      timestamp:Date.now(),...(body.video ? {piWebVideo:{...body.video,id:"11111111-1111-4111-8111-111111111111"}} : {})});
    // Prior identical text/images/video must not be mistaken for this Send.
    if (existing && mode !== "basic") history.push(nativeMessage({message:"What is visible?",
      ...(withImage ? {images:[{type:"image",data:png.toString("base64"),mimeType:"image/png"}]} : {}),
      ...(withVideo ? {video:{version:1,path:"/video-workspace/clip.avi",mimeType:"video/avi"}} : {})}));
    await page.route("http://video.test/**", async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === "/") return route.fulfill({contentType:"text/html",body:'<div id="root"></div>'});
      if (url.pathname.startsWith("/api/files/")) {
        const form = await new Request(req.url(), {method:"POST", headers:req.headers(), body:req.postDataBuffer()}).formData();
        const file = form.get("files");
        uploads.push({name:file.name, bytes:Buffer.from(await file.arrayBuffer()), url:url.href});
        if (holdUpload) await new Promise(resolve => {releaseUpload=resolve;});
        if (uploadResult === "error") return route.fulfill({status:500,json:{error:"fixture upload failure"}});
        return route.fulfill({json:{[uploadResult]:[file.name]}});
      }
      const body = req.method() === "POST" ? req.postDataJSON() : undefined;
      if (url.pathname === "/api/models") return route.fulfill({json:{models:{"tapsvc:google/gemini-3.8-flash":"Gemini"},modelList:[{id:"google/gemini-3.8-flash",provider:"tapsvc",name:"Gemini"}],defaultModel:{provider:"tapsvc",modelId:"google/gemini-3.8-flash"},defaultThinkingLevel:"off"}});
      if (url.pathname === "/api/skills") return route.fulfill({json:{skills:[]}});
      const state = {isStreaming:false,isPromptRunning:false,model:{provider:"tapsvc",id:"google/gemini-3.8-flash"},thinkingLevel:"off",steeringMessages:[],followUpMessages:[]};
      if (url.pathname === "/api/agent/new") {
        ensureCalls++;
        assert.equal(body.type,"ensure_session"); assert.equal(body.video,undefined);
        return route.fulfill({json:{sessionId:"fixture-session",model:{provider:"tapsvc",modelId:"google/gemini-3.8-flash"},thinkingLevel:"off"}});
      }
      if (url.pathname.endsWith("/state")) return route.fulfill({json:{running:true,state}});
      if (url.pathname.startsWith("/api/sessions/") && historyReadFail) return route.fulfill({status:500,json:{error:"fixture history unavailable"}});
      if (url.pathname.startsWith("/api/sessions/")) return route.fulfill({json:{sessionId:"fixture-session",filePath:"",tree:[],treeFormat:"summary",snapshotRevision:`fixture-${history.length}`,leafId:null,context:{messages:history,entryIds:history.map((_,i)=>`entry-${i}`),oldestEntryId:null,hasMore:false,model:state.model,thinkingLevel:"off"}}});
      if (url.pathname.startsWith("/api/agent/")) {
        if (body?.type === "prompt") {
          prompts.push(body);
          if (rejectPrompt) return route.fulfill({status:500,json:{error:"fixture preflight rejection",code:"prompt_rejected",accepted:false}});
          const message = lastNative = nativeMessage(body);
          if (promptOutcome === "abort") {
            if (mode === "unknown-history" || mode === "unknown-sse") history.push(message);
            if (mode === "unknown-sse") await page.evaluate(message => window.emit({type:"message_end",message}), message);
            return route.abort("failed");
          }
          history.push(message);
          await page.evaluate(message => window.emit({type:"message_end",message}), message);
          await route.fulfill({json:{success:true,data:{}}});
          await page.evaluate(() => window.emit({type:"prompt_done"}));
          return;
        }
        return route.fulfill({json:body ? {success:true,data:body.type === "get_state" ? state : {}} : {running:true,state}});
      }
      throw new Error(`Unexpected fixture request ${req.method()} ${url.pathname}`);
    });
    await page.goto("http://video.test/");
    await page.addScriptTag({content:outputFiles[0].text});
    await page.waitForFunction(() => window.chat && !window.chat.loading && window.chat.modelList.length);
    const input = page.locator("textarea"), picker = page.locator('input[accept=".mp4,.avi"]');
    const send = page.getByRole("button",{name:"Send",exact:true});
    const remove = () => page.getByRole("button",{name:"Remove video",exact:true}).click();
    const select = (name,buffer=mp4,mimeType="") => picker.setInputFiles({name,mimeType,buffer});
    await input.fill("What is visible?");
    if (mode !== "basic") {
      if (withImage) {
        await page.locator('input[accept="image/*"]').setInputFiles({name:"pixel.png",mimeType:"image/png",buffer:png});
        await page.locator('img[src^="blob:"]').waitFor();
      }
      if (withVideo) {
        await select("clip.avi",avi,"video/x-msvideo");
        await page.getByText(/Video ready/).waitFor();
      }
      await send.click();
      await page.waitForFunction(()=>!window.chat.agentRunning);
      assert.equal(prompts.length,1,"unknown results never retry automatically");
      assert.equal(await input.inputValue(),"","unknown results never auto-restore a sendable draft");
      assert.equal(await page.locator('[data-video-attachment]').count(),0);
      const received = mode === "unknown-history" || mode === "unknown-sse";
      if (received) {
        assert.equal(await page.evaluate(()=>window.chat.unconfirmedSubmission),null,"native receipt releases the snapshot");
        assert.equal(await page.locator('[data-unconfirmed-submission]').count(),0);
        assert.equal(await page.evaluate(()=>window.chat.messages.filter(m=>m.piWebVideo).length),existing ? 2 : 1);
      } else {
        const saved = await page.evaluate(()=>window.chat.unconfirmedSubmission);
        assert.equal(saved.value,"What is visible?");
        assert.equal(saved.images.length,withImage ? 1 : 0);
        if (withImage) assert.deepEqual(Buffer.from(saved.images[0].data,"base64"),png);
        assert.deepEqual(saved.video,withVideo ? {version:1,path:"/video-workspace/clip.avi",mimeType:"video/avi"} : undefined);
        await page.locator('[data-unconfirmed-submission]').waitFor();
        if (mode === "unknown-late") history.push(lastNative);
        const restore=page.getByRole("button",{name:"Check and restore saved input",exact:true});
        if (mode === "unknown-none") {
          historyReadFail=true;
          await restore.click();
          await page.waitForFunction(()=>window.chat.error && !window.chat.restoringSubmission);
          assert.deepEqual(await page.evaluate(()=>window.chat.unconfirmedSubmission),saved,"failed verification retains the complete snapshot");
          assert.equal(await input.inputValue(),"");
          assert.equal(prompts.length,1);
          historyReadFail=false;
        }
        await restore.click();
        await page.waitForFunction(()=>!window.chat.unconfirmedSubmission && !window.chat.restoringSubmission);
        assert.equal(prompts.length,1,"restoration itself never sends");
        if (mode === "unknown-late") {
          assert.equal(await input.inputValue(),"","late native owner wins the pre-restore recheck");
          assert.equal(await page.locator('[data-video-attachment]').count(),0);
        } else {
          assert.equal(await input.inputValue(),"What is visible?");
          assert.equal(await page.locator('fieldset img[src^="data:image/"]').count(),withImage ? 1 : 0);
          assert.equal(await page.locator('[data-video-attachment]').count(),withVideo ? 1 : 0);
          promptOutcome="accepted";
          await send.click();
          await page.waitForFunction(()=>!window.chat.agentRunning);
          assert.equal(prompts.length,2,"only explicit Send resubmits the recovered input");
          assert.equal(prompts[1].message,prompts[0].message);
          assert.deepEqual(prompts[1].images,prompts[0].images);
          assert.deepEqual(prompts[1].video,prompts[0].video);
          assert.equal(ensureCalls,existing ? 0 : 1,"recovery reuses the created session, not another new session");
        }
      }
      assert.deepEqual(pageErrors,[]);
      console.log(`PASS ${existing ? "existing/mobile" : "new/desktop"}: ${mode} snapshot/authoritative receipt/manual restore/no automatic resend`);
      await page.close();
      continue;
    }
    holdUpload = true;
    await select("UPPER.MP4");
    await page.waitForFunction(() => document.querySelector('[data-video-attachment]')?.textContent.includes("Uploading"));
    assert.equal(await send.isDisabled(),true);
    await input.press("Enter"); assert.equal(prompts.length,0,"Enter cannot bypass pending upload");
    await remove(); releaseUpload(); holdUpload=false;
    await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-video-attachment]').count(),0,"late upload cannot undo removal");
    assert.deepEqual(uploads[0].bytes,mp4); assert.match(uploads[0].url,/video-workspace\?type=upload&conflict=skip$/);

    uploadResult="skipped";
    await select("clip.avi",avi,"video/x-msvideo");
    await page.getByText(/referencing the existing file/).waitFor();
    assert.equal(await send.isEnabled(),true);
    await input.fill("/new"); assert.equal(await send.isDisabled(),true);
    await input.press("Enter"); assert.equal(await page.evaluate(()=>window.builtins),0);
    assert.equal(await page.locator('[data-video-attachment]').count(),1);
    await input.fill("!echo hello"); assert.equal(await send.isDisabled(),true);
    await input.fill("What is visible?");
    await page.evaluate(()=>window.setModel({provider:"other",modelId:"not-video"}));
    await page.getByRole("alert").filter({hasText:/requires tapsvc/}).waitFor(); assert.equal(await send.isDisabled(),true);
    await page.evaluate(()=>window.setModel({provider:"TapSVC",modelId:"google/gemini-3.8-flash"}));
    await page.waitForTimeout(20);
    assert.equal(await send.isDisabled(),true,"the former spelling is not a supported alias");
    await page.evaluate(()=>window.setModel({provider:"tapsvc",modelId:"google/gemini-3.8-flash"}));
    await page.evaluate(()=>window.setBusy(true));
    assert.equal(await page.getByRole("button", { name: "Steer", exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "Follow-up", exact: true }).isEnabled(), true);
    assert.equal(prompts.length,0); assert.equal(await page.locator('[data-video-attachment]').count(),1);
    await page.evaluate(()=>window.setBusy(false));

    rejectPrompt=true;
    await send.click();
    await page.waitForFunction(()=>window.chat.notices.some(n=>n.message.includes("fixture preflight rejection")));
    await page.getByText("clip.avi",{exact:true}).waitFor();
    assert.equal(await input.inputValue(),"What is visible?","rejection restores text through the empty/history remount");
    assert.deepEqual(prompts[0].video,{version:1,path:"/video-workspace/clip.avi",mimeType:"video/avi"});
    rejectPrompt=false;
    await send.click();
    await page.locator('[data-sent-video]').waitFor();
    assert.match(await page.locator('[data-sent-video]').textContent(),/clip.avi.*video\/avi/);
    await page.waitForFunction(()=>!window.chat.agentRunning);
    assert.equal(await page.locator('[data-video-attachment]').count(),0);
    assert.equal(prompts.length,2,"no implicit retry");
    await input.fill("Ordinary text path /video-workspace/clip.mp4"); await send.click();
    await page.waitForFunction(()=>!window.chat.agentRunning);
    assert.equal(prompts.at(-1).video,undefined,"ordinary paths stay text");

    await page.locator('input[accept="image/*"]').setInputFiles({name:"pixel.png",mimeType:"image/png",buffer:png});
    await page.locator('img[src^="blob:"]').waitFor();
    await input.fill("Ordinary image"); await send.click();
    await page.waitForFunction(()=>!window.chat.agentRunning);
    assert.equal(prompts.at(-1).video,undefined);
    assert.equal(prompts.at(-1).images[0].mimeType,"image/png");
    assert.deepEqual(Buffer.from(prompts.at(-1).images[0].data,"base64"),png);

    uploadResult="error";
    await select("bad.mp4"); await page.getByRole("alert").filter({hasText:/fixture upload failure/}).waitFor();
    await input.fill("Keep my question"); assert.equal(await send.isDisabled(),true); await remove();
    const before=uploads.length;
    await select("clip.mov"); await page.getByRole("alert").filter({hasText:/exactly one MP4 or AVI/}).waitFor();
    assert.equal(uploads.length,before); await remove();
    await select("large.mp4",Buffer.alloc(20*1024*1024+1));
    await page.getByRole("alert").filter({hasText:/20 MiB/}).waitFor(); assert.equal(uploads.length,before); await remove();
    assert.equal(await input.inputValue(),"Keep my question");
    assert.deepEqual(pageErrors,[]);
    console.log(`PASS ${existing ? "existing/mobile" : "new/desktop"}: picker/upload/removal/skip/blocked entrances/rejection/native reference/plain text/images`);
    await page.close();
  }
} finally { await browser.close(); }
