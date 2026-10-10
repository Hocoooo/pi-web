// Public UI seam: real composer and task picker, no server or model credentials.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "task-picker.js", platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, { useRef, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { ChatInput } from "./components/ChatInput";
    import { TaskPicker } from "./components/TaskPicker";
    import { I18nProvider } from "./hooks/useI18n";
    window.sent = []; window.aborts = 0; window.failSave = false; window.commandLoads = 0;
    function App() {
      const [open, setOpen] = useState(false);
      const [task, setTask] = useState(null);
      const input = useRef(null);
      const close = () => { setOpen(false); requestAnimationFrame(() => input.current?.focusComposer()); };
      return <I18nProvider>
        <output aria-label="Selected task">{task?.title ?? "No task"}</output>
        <button onClick={() => setOpen(true)}>Choose task</button>
        <ChatInput ref={input} isStreaming={true} onAbort={() => window.aborts++}
          onSend={text => window.sent.push(text)} onSteer={text => window.sent.push(text)}
          onFollowUp={text => window.sent.push(text)} onLoadSlashCommands={() => {window.commandLoads++; return [];}} onOpenTaskPicker={() => setOpen(true)} />
        {open && <TaskPicker tasks={[
          {id: "a", title: "Login API", archived: false, status: "todo", statusKey: "todo"},
          {id: "b", title: "Login UI", archived: false, status: "in-progress"},
          {id: "c", title: "Old login", archived: true, status: "Done"}
        ]} selectedId={task?.id ?? null} onClose={close} onSelect={async value => {if (window.delaySave) await new Promise(resolve => {window.releaseSave = resolve;}); if (window.failSave) throw new Error("Save unavailable"); setTask(value); close();}} />}
      </I18nProvider>;
    }
    createRoot(document.getElementById("root")).render(<App />);
  ` },
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("http://task-picker.test/**", route => route.fulfill({contentType: "text/html", body: '<div id="root"></div>'}));
  await page.goto("http://task-picker.test/");
  await page.addStyleTag({content: outputFiles.find(file => file.path.endsWith(".css")).text});
  await page.addScriptTag({content: outputFiles.find(file => file.path.endsWith(".js")).text});
  const composer = page.locator("textarea");
  await composer.pressSequentially("/task", {delay: 80});
  await composer.press("Enter");
  const search = page.getByRole("combobox", {name: "Search tasks"});
  await search.waitFor({timeout: 3000});
  assert.match(await page.getByRole("option", {name: /Login API/}).textContent(), /To do/, "built-in status should use the locale, not an internal column ID");
  assert.match(await page.getByRole("option", {name: /Login UI/}).textContent(), /in-progress/, "a custom label that looks like a built-in ID must stay literal");
  await search.fill("Login");
  await search.press("ArrowDown");
  await search.press("Enter");
  await page.getByRole("dialog").waitFor({state: "detached"});
  assert.equal(await page.getByLabel("Selected task").textContent(), "Login UI");
  await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));
  assert.deepEqual(await page.evaluate(() => window.sent), []);
  assert.equal(await page.evaluate(() => window.commandLoads), 0, "typing /task must not initialize a runtime just to discover extension commands");
  console.log("PASS /task selects a task entirely by keyboard while streaming without sending a prompt");
  await composer.fill("Keep this draft");
  await page.getByRole("button", {name: "Choose task", exact: true}).click();
  assert.equal(await page.getByRole("option", {name: /Login UI/}).getAttribute("aria-selected"), "true");
  await search.dispatchEvent("keydown", {key: "Escape", isComposing: true});
  assert.equal(await page.getByRole("dialog").count(), 1);
  await search.press("Escape");
  assert.equal(await composer.inputValue(), "Keep this draft");
  assert.equal(await page.evaluate(() => window.aborts), 0);
  await page.getByRole("button", {name: "Choose task", exact: true}).click();
  assert.equal(await page.getByRole("option", {name: /Old login/}).count(), 0);
  await page.getByRole("checkbox", {name: "Show archived tasks"}).check();
  await search.fill("Old");
  await page.evaluate(() => window.failSave = true);
  await search.press("Enter");
  await page.getByRole("alert").filter({hasText: "Save unavailable"}).waitFor();
  assert.equal(await page.getByLabel("Selected task").textContent(), "Login UI");
  await page.evaluate(() => window.failSave = false);
  await search.press("Enter");
  await page.getByRole("dialog").waitFor({state: "detached"});
  assert.equal(await page.getByLabel("Selected task").textContent(), "Old login");
  console.log("PASS cancel/IME preserve membership and draft; archived choice and failed save can retry");
  await page.getByRole("button", {name: "Choose task", exact: true}).click();
  await page.evaluate(() => {window.delaySave = true;});
  await page.getByRole("option", {name: /Login API/}).click();
  await page.waitForFunction(() => !!window.releaseSave);
  await page.getByRole("heading", {name: "Choose task"}).click();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true, "slow saves must not let Tab escape to the background");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 1, "saving must not be dismissed");
  await page.evaluate(() => window.releaseSave());
  await page.getByRole("dialog").waitFor({state: "detached"});
  console.log("PASS slow-save focus containment after clicking non-focusable dialog content");
} finally { await browser.close(); }
