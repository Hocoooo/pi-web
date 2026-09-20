// Real-browser interaction contract for the model -> thinking picker.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, {useState} from "react";
    import {createRoot} from "react-dom/client";
    import {ModelSelector} from "./components/ModelSelector";
    import {I18nProvider} from "./hooks/useI18n";
    const options = Array.from({length:30}, (_,i)=>({provider:"p",modelId:"m"+i,name:"Model "+String(i).padStart(2,"0")}));
    window.calls=[];
    function App(){
      const [value,setValue]=useState({provider:"p",modelId:"m25"});
      const [level,setLevel]=useState("low");
      const [busy,setBusy]=useState(false);
      const [switching,setSwitching]=useState(false);
      window.setSwitching=setSwitching;
      return <I18nProvider><textarea aria-label="Composer"/><ModelSelector options={options} value={value} busy={busy || switching}
        onChange={(provider,modelId)=>{window.calls.push(["model",modelId]);setValue({provider,modelId})}}
        thinking={{level,levels:Object.fromEntries(options.map(m=>[m.provider+":"+m.modelId,m.modelId==="m29"?["off"]:["off","low","high"]])),
          onConfirm:async(provider,modelId,level)=>{setBusy(true);window.calls.push(["confirm",modelId,level]);await new Promise(resolve=>setTimeout(resolve,50));setBusy(false);if(window.failSave)return {error:"Save failed"};setValue({provider,modelId});setLevel(level);return {}}}}
      /></I18nProvider>;
    }createRoot(document.getElementById("root")).render(<App/>);
  ` },
});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
try {
  for(const viewport of [{width:1100,height:900},{width:390,height:844}]){
    const page=await browser.newPage({viewport,locale:"en-US"});
    await page.route("http://model-flow.test/**",r=>r.fulfill({contentType:"text/html",body:'<div id="root" style="padding-top:550px"></div>'}));
    await page.goto("http://model-flow.test"); await page.addScriptTag({content:outputFiles[0].text});
    await page.locator(".model-selector > button").click();
    const selected=page.getByRole("option",{selected:true});
    const row=await selected.boundingBox(); const list=await page.getByRole("listbox").boundingBox();
    assert.ok(row && list && row.y>=list.y && row.y+row.height<=list.y+list.height,"current model must be scrolled into view on open");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("Model 29");
    assert.equal(await page.locator(".model-selector input").inputValue(),"Model 29","typing after arrows must still filter");
    assert.equal(await page.getByRole("option").count(),1);
    await page.keyboard.press("ArrowRight");
    await page.getByRole("listbox",{name:/thinking|reasoning/i}).waitFor();
    assert.equal(await page.getByRole("option").count(),1,"target model's levels, not current model's levels");
    assert.equal((await page.evaluate(()=>window.calls)).length,0,"navigation must not mutate session settings");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator(".model-selector input").inputValue(),"Model 29");
    await page.locator(".model-selector input").fill("Model 26");
    await page.keyboard.press("Enter");
    await page.getByRole("listbox",{name:/thinking|reasoning/i}).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await page.getByRole("listbox").waitFor({state:"detached"});
    assert.deepEqual(await page.evaluate(()=>window.calls),[["confirm","m26","high"]]);
    await page.locator(".model-selector > button").click();
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    assert.equal((await page.evaluate(()=>window.calls)).length,1,"Escape cancels both pending selections");
    await page.locator(".model-selector > button").click();
    await page.keyboard.press("ArrowRight");
    await page.evaluate(()=>window.failSave=true);
    await page.keyboard.press("Enter");
    await page.getByRole("alert").filter({hasText:"Save failed"}).waitFor();
    assert.equal(await page.getByRole("listbox").count(),1,"failure keeps the picker open");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");
    await page.evaluate(()=>window.setSwitching(true));
    await page.waitForFunction(() => document.querySelector(".model-selector > button")?.getAttribute("title") === "Switching model");
    await page.locator(".model-selector > button").click({force:true});
    assert.equal(await page.getByRole("listbox").count(), 0, "busy selector must stay closed");
    await page.evaluate(()=>window.setSwitching(false));
    console.log("PASS model flow: current visibility, searchable arrows, target capabilities, left/right, deferred commit, cancellation, errors",viewport.width);
    await page.close();
  }
}finally{await browser.close();}
