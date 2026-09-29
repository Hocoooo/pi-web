// Real ChatInput + hook, mocked optional HTTP inference. No server/credentials/provider charges.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { ChatInput } from "./components/ChatInput";
    import { I18nProvider } from "./hooks/useI18n";
    import { setDraftCompletionEnabled, setDraftCompletionModel } from "./lib/draft-completion-preference";
    window.enable = setDraftCompletionEnabled; window.pickModel = setDraftCompletionModel;
    window.sent = []; window.requests = []; window.policy = {delay:20, text:"的错误处理"};
    window.fetch = async (url, options) => {
      if (url === "/api/draft-completion") {
        const body = JSON.parse(options.body), policy = {...window.policy};
        window.requests.push(body);
        // Intentionally ignore AbortSignal to verify late replies cannot revive old suggestions.
        await new Promise(resolve => setTimeout(resolve, policy.delay));
        return policy.status === 204 ? new Response(null,{status:204}) : new Response(JSON.stringify({text:policy.text,leafId:body.leafId}),{status:200});
      }
      return new Response(JSON.stringify({files:[], skills:[], commands:[]}),{status:200});
    };
    function App() {
      const [context, setContext] = useState({sessionId:null,leafId:null});
      const [busy, setBusy] = useState(false);
      const [compact,setCompact] = useState(false);
      window.context = setContext; window.busy = setBusy; window.compact = setCompact;
      return <I18nProvider><ChatInput onAbort={() => {}} onSend={text => window.sent.push(text)}
        isStreaming={busy} compact={compact} cwd="/test-project" model={{provider:"p",modelId:"chat"}}
        draftCompletionContext={context} nextCue="Try the next step" /></I18nProvider>;
    }
    createRoot(document.getElementById("root")).render(<React.StrictMode><App/></React.StrictMode>);
  ` },
});
const browser = await chromium.launch({headless:true});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:1100,height:800}});
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://draft.test/**", route => route.fulfill({contentType:"text/html",body:'<html><body style="--text:#222;--text-dim:#888;--bg:#fff;font-family:Arial"><div id="root" style="width:480px;margin:260px auto 0"></div></body></html>'}));
  await page.goto("http://draft.test/");
  await page.addScriptTag({content:outputFiles[0].text});
  const input=page.locator("textarea"), ghost=page.locator("[data-draft-completion-ghost]");
  const count=()=>page.evaluate(()=>window.requests.length);
  const ready=()=>ghost.waitFor({timeout:5000});
  const noGhost=async()=>assert.equal(await ghost.count(),0);
  await input.fill("帮我检查这个接口"); await page.waitForTimeout(750);
  assert.equal(await count(),0,"default off never uploads draft");
  await page.evaluate(()=>window.enable(true));
  await ready(); assert.equal((await page.evaluate(()=>window.requests[0])).sessionId,null,"first message supported");
  assert.equal((await page.evaluate(()=>window.requests[0])).model.modelId,"chat");
  await input.press("Tab"); assert.equal(await input.inputValue(),"帮我检查这个接口的错误处理");
  assert.deepEqual(await page.evaluate(()=>window.sent),[]);
  const acceptedCount=await count(); await page.waitForTimeout(800); assert.equal(await count(),acceptedCount,"no automatic chain after acceptance");
  await input.press("Enter"); assert.deepEqual(await page.evaluate(()=>window.sent),["帮我检查这个接口的错误处理"]);
  await page.waitForFunction(()=>document.querySelector('textarea').value === '');
  await input.fill("再检查这个接口"); await ready(); await input.press("Enter");
  assert.equal((await page.evaluate(()=>window.sent)).at(-1),"再检查这个接口","Enter does not adopt unaccepted ghost");
  await page.waitForFunction(()=>document.querySelector('textarea').value === '');
  await input.fill("取消这个补全"); await ready(); await input.press("Escape"); await noGhost();
  const cancelledCount=await count(); await page.waitForTimeout(800);assert.equal(await count(),cancelledCount);
  await input.fill("还没请求就取消"); await input.press("Escape"); await page.waitForTimeout(750);assert.equal(await count(),cancelledCount);

  await input.dispatchEvent("compositionstart"); await input.fill("中文输入组合期间");await page.waitForTimeout(750);
  assert.equal(await count(),cancelledCount,"composition does not upload");
  await input.dispatchEvent("compositionend");await ready();
  await input.press("Home");await noGhost();
  await input.fill("选中文字时不补全");
  await input.evaluate(el=>{el.setSelectionRange(0,2);el.dispatchEvent(new Event("select",{bubbles:true}));});
  const selectionCount=await count();await page.waitForTimeout(750);assert.equal(await count(),selectionCount);

  for (const text of ["/model", "@source", "!echo private"]) {
    await input.fill(text);const before=await count();await page.waitForTimeout(750);assert.equal(await count(),before,`${text} stays in its own mode`);
  }
  await page.evaluate(()=>window.busy(true)); await input.fill("运行中暂不补全");const busyCount=await count();await page.waitForTimeout(750);assert.equal(await count(),busyCount);
  await page.evaluate(()=>window.busy(false));await ready();
  await page.evaluate(()=>window.enable(false));await noGhost();
  const disabledCount=await count();
  await page.evaluate(()=>window.enable(true));await page.waitForTimeout(750);await noGhost();
  assert.equal(await count(),disabledCount,"re-enabling cannot resurrect or repay for the last completed draft");
  await input.fill("切换会话前的草稿");
  await page.evaluate(()=>{window.policy={delay:1400,text:"旧补全"};});
  const beforeSlow=await count();await page.waitForFunction(n=>window.requests.length>n,beforeSlow);
  await page.evaluate(()=>{window.context({sessionId:"session-b",leafId:"leaf-b"});window.policy={delay:20,text:"新分支补全"};});
  await ready();assert.equal(await ghost.textContent(),"新分支补全");
  await page.waitForTimeout(1450);assert.equal(await ghost.textContent(),"新分支补全","late response cannot overwrite new branch");
  await page.evaluate(()=>window.pickModel({provider:"q",modelId:"fast"}));await ready();
  await page.waitForFunction(()=>window.requests.at(-1).model.modelId === "fast");
  assert.equal((await page.evaluate(()=>window.requests.at(-1))).model.provider,"q");

  await input.fill("请帮我\n检查多行布局");await ready();
  assert.equal(await input.inputValue(), "请帮我\n检查多行布局", "editing over an existing ghost must preserve the controlled input");
  const geometry=await page.evaluate(()=>{
    const el=document.querySelector("textarea"), mirror=document.querySelector("[data-draft-completion-ghost]").parentElement;
    return {width:el.clientWidth,mirrorWidth:mirror.clientWidth,font:getComputedStyle(el).font,mirrorFont:getComputedStyle(mirror).font};
  });
  assert.equal(geometry.width,geometry.mirrorWidth);assert.equal(geometry.font,geometry.mirrorFont);
  assert.equal(await ghost.evaluate(el=>{
    const viewport=document.querySelector('textarea').getBoundingClientRect();
    return Array.from(el.getClientRects()).every(line=>line.top>=viewport.top-0.5 && line.bottom<=viewport.bottom+0.5);
  }),true,"every offered suffix line must be visible");
  await page.evaluate(()=>{window.policy={delay:20,text:'较长的续写内容'.repeat(12)};});
  const longDraft=Array(14).fill('这是已经填满输入框的多行草稿').join('\n');
  const longCount=await count();await input.fill(longDraft);
  await input.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
  await page.waitForFunction(n=>window.requests.length>n,longCount);await page.waitForTimeout(200);await noGhost();
  await input.press('Tab');assert.equal(await input.inputValue(),longDraft,"invisible overflow must not be accepted");
  await page.evaluate(()=>{window.policy={delay:20,text:'有效补全'};});
  await page.evaluate(()=>window.compact(true));await noGhost();const compactCount=await count();await input.fill("引用提问不补全");await page.waitForTimeout(750);assert.equal(await count(),compactCount);
  await page.evaluate(()=>window.compact(false));
  await page.setViewportSize({width:390,height:844});await input.fill("移动端不补全");const mobileCount=await count();await page.waitForTimeout(750);assert.equal(await count(),mobileCount);await noGhost();
  assert.deepEqual(errors,[]);
  console.log("PASS: default-off, fresh draft, model selection, Tab/Enter/Esc, IME, selection, menus, busy, stale branch, multiline, compact and mobile guards");
} finally { await browser.close(); }
