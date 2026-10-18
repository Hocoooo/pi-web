// Lifecycle seam: real useAgentSession and composer; HTTP/SSE are boundary fixtures.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({absWorkingDir: root, bundle: true, write: false, outfile: "task-session-selection.js", platform: "browser", format: "iife", jsx: "automatic",
  define: {"process.env.NODE_ENV": '"development"'},
  stdin: {resolveDir: root, loader: "tsx", contents: `
    import React, {useRef} from "react";
    import {createRoot} from "react-dom/client";
    import {useAgentSession} from "./hooks/useAgentSession";
    import {ChatInput} from "./components/ChatInput";
    import {TaskSelectionDialog} from "./components/TaskSelectionDialog";
    import {I18nProvider} from "./hooks/useI18n";
    window.EventSource = class { readyState = 1; constructor() {queueMicrotask(() => this.onmessage?.({data: JSON.stringify({type:"connected"})}));} close() {this.readyState = 2;} };
    function App() {
      const input = useRef(null);
      const chat = useAgentSession({session: null, newSessionCwd: "/project", newSessionDraftKey: "task-draft", chatInputRef: input, newSessionSeed: window.newSessionSeed});
      window.chat = chat;
      const selection = chat.taskSelection;
      const close = () => {selection.close(); requestAnimationFrame(() => input.current?.focusComposer());};
      return <>
        <button onClick={() => selection.open()}>Choose task</button>
        <output aria-label="Selected task">{selection?.pendingTask?.title ?? "No task"}</output>
        <ChatInput ref={input} draftKey="task-draft" onSend={chat.handleSend} onAbort={chat.handleAbort} isStreaming={chat.agentRunning}
          onOpenTaskPicker={() => selection.open()} onLoadSlashCommands={chat.loadSlashCommands} />
        {selection && <TaskSelectionDialog selection={selection} onClose={close} />}
      </>;
    }
    createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);
  `}});
const browser = await chromium.launch({headless: true});
const task = {id: "11111111-1111-4111-8111-111111111111", title: "Login API", status: "Todo", revision: 1, archived: false};
const otherTask = {...task, id: "33333333-3333-4333-8333-333333333333", title: "Billing API"};
const sessionId = "22222222-2222-4222-8222-222222222222";
async function run(name, arrange, seed) {
  const page = await browser.newPage();
  await page.addInitScript(value => {window.newSessionSeed = value;}, seed);
  const state = {created: 0, owner: null, prompts: [], bashes: [], taskRequests: [], failLink: false, failTasks: false, expectedOwner: task.id};
  await page.route("http://task-session.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    let data = {};
    if (path === "/") return route.fulfill({contentType: "text/html", body: '<div id="root"></div>'});
    if (path === "/api/models") data = {models: {}, modelList: []};
    else if (path === "/api/tasks") {
      state.taskRequests.push(body);
      if (state.failTasks || body.action === "link" && state.failLink) return route.fulfill({status: 503, json: {error: "Task storage unavailable"}});
      if (body.action === "link" && state.loseLinkReply) {state.owner = body.id; return route.fulfill({status: 503, json: {error: "Link reply lost"}});}
      if (body.action === "task-picker") data = {tasks: [task, otherTask], relation: body.sessionId ? {sessionId, sourceTaskId: state.owner, generation: 0, updateRevision: 0} : null};
      else if (body.action === "link") {
        if (state.linkGate) {state.linkStarted(); await state.linkGate;}
        if (state.failLink) return route.fulfill({status: 503, json: {error: "Task storage unavailable"}});
        state.owner = body.id; data = {};
      }
      else if (body.action === "change-session-relation") {state.owner = body.targetTaskId; data = {};}
      else throw new Error(`Unexpected task action ${body.action}`);
    } else if (path === "/api/agent/new") {state.created++; data = {sessionId};}
    else if (path.endsWith("/state")) data = {running: false};
    else if (path.startsWith("/api/sessions/")) data = {sessionId, tree: [], leafId: null, context: {messages: [], entryIds: []}};
    else if (path.startsWith("/api/agent/")) {
      if (body?.type === "bash") state.bashes.push(body);
      if (body?.type === "prompt") {state.prompts.push(body); state.onPrompt?.(); assert.equal(state.owner, state.expectedOwner, "selected task must be bound before prompt admission");}
      data = {success: true, data: body?.type === "get_commands" ? {commands: []} : {}};
    }
    await route.fulfill({json: data});
  });
  try {
    await page.goto("http://task-session.test/");
    await page.addStyleTag({content: outputFiles.find(file => file.path.endsWith(".css")).text});
    await page.addScriptTag({content: outputFiles.find(file => file.path.endsWith(".js")).text});
    await page.locator("textarea").waitFor();
    const choose = async () => {
      await page.getByRole("button", {name: "Choose task", exact: true}).click();
      await page.getByRole("option", {name: /Login API/}).click();
      await page.getByRole("dialog").waitFor({state: "detached"});
    };
    await arrange({page, state, choose});
    console.log("PASS", name);
  } finally {await page.close();}
}
try {
  const inherited = {model: null, thinkingLevel: null, task};
  await run("an inherited task binds during early runtime initialization without opening a picker", async ({page, state}) => {
    assert.equal(await page.getByLabel("Selected task").textContent(), "Login API");
    await page.evaluate(() => window.chat.loadSlashCommands());
    assert.equal(state.owner, task.id); assert.equal(state.created, 1);
    assert.deepEqual(state.prompts, []);
  }, inherited);
  await run("a user can clear the inherited task before the first prompt", async ({page, state}) => {
    await page.getByRole("button", {name: "Choose task", exact: true}).click();
    await page.getByRole("option", {name: /No task/}).click();
    await page.getByRole("dialog").waitFor({state: "detached"});
    state.expectedOwner = null;
    await page.evaluate(() => window.chat.handleSend("Unassociated"));
    assert.equal(state.owner, null); assert.equal(state.created, 1);
    assert.deepEqual(state.prompts, [{type: "prompt", message: "Unassociated"}]);
  }, inherited);
  await run("/new reads the real owner instead of a retained failed preselection", async ({page, state, choose}) => {
    await choose(); state.failLink = true;
    await page.evaluate(() => window.chat.loadSlashCommands().catch(() => {}));
    state.failLink = false; state.owner = otherTask.id;
    const seed = await page.evaluate(() => window.chat.getNewSessionSeed());
    assert.equal(seed.task.id, otherTask.id);
    assert.equal(state.owner, otherTask.id); assert.equal(state.created, 1);
    assert.deepEqual(state.prompts, []);
  });
  await run("/new retains a task when an in-flight initial binding fails", async ({page, state, choose}) => {
    await choose();
    let release;
    state.linkGate = new Promise(resolve => {release = resolve;});
    const started = new Promise(resolve => {state.linkStarted = resolve;});
    const warming = page.evaluate(() => window.chat.loadSlashCommands().catch(() => {}));
    await started;
    const inheriting = page.evaluate(() => window.chat.getNewSessionSeed());
    state.failLink = true; release();
    const [, seed] = await Promise.all([warming, inheriting]);
    assert.equal(seed.task.id, task.id);
    assert.equal(state.created, 1); assert.deepEqual(state.prompts, []);
  });
  await run("new chat preselection creates no Agent and binds before its first prompt", async ({page, state, choose}) => {
    await choose();
    assert.equal(state.created, 0);
    assert.equal(state.owner, null);
    await page.evaluate(() => window.chat.handleSend("Hello"));
    assert.equal(state.created, 1);
    assert.equal(state.owner, task.id);
    assert.deepEqual(state.prompts, [{type: "prompt", message: "Hello"}]);
  });
  await run("preselection binds when command discovery initializes the session, without a prompt", async ({page, state, choose}) => {
    await choose();
    await page.evaluate(() => window.chat.loadSlashCommands());
    assert.equal(state.created, 1);
    assert.equal(state.owner, task.id);
    assert.deepEqual(state.prompts, []);
  });
  await run("an initialized session can bind, reassign and unlink without creating another session or prompting", async ({page, state, choose}) => {
    await page.evaluate(() => window.chat.loadSlashCommands());
    await choose();
    assert.equal(state.owner, task.id);
    await page.getByRole("button", {name: "Choose task", exact: true}).click();
    await page.getByRole("option", {name: /Billing API/}).click();
    await page.getByRole("dialog").waitFor({state: "detached", timeout: 3000});
    assert.equal(state.owner, otherTask.id);
    await page.getByRole("button", {name: "Choose task", exact: true}).click();
    await page.getByRole("option", {name: /No task/}).click();
    await page.getByRole("dialog").waitFor({state: "detached"});
    assert.equal(state.owner, null);
    assert.equal(state.created, 1);
    assert.deepEqual(state.prompts, []);
  });
  await run("failed initial binding restores draft and retries the same session without duplicating prompt", async ({page, state, choose}) => {
    await choose(); state.failLink = true;
    const input = page.locator("textarea");
    await input.fill("Keep my message"); await input.press("Enter");
    await page.waitForFunction(() => !window.chat.agentRunning && document.querySelector("textarea").value === "Keep my message");
    assert.equal(state.created, 1); assert.equal(state.prompts.length, 0); assert.equal(state.owner, null);
    state.failLink = false;
    const prompted = new Promise(resolve => { state.onPrompt = resolve; });
    await input.press("Enter");
    await prompted;
    assert.equal(state.created, 1); assert.equal(state.prompts.length, 1); assert.equal(state.owner, task.id);
    assert.deepEqual(state.taskRequests.filter(body => body.action === "link")[0], state.taskRequests.filter(body => body.action === "link")[1]);
  });
  await run("ordinary chat remains independent of task storage", async ({page, state}) => {
    state.failTasks = true; state.expectedOwner = null;
    await page.evaluate(() => window.chat.handleSend("Ordinary chat"));
    assert.equal(state.created, 1); assert.equal(state.prompts.length, 1); assert.equal(state.taskRequests.length, 0);
  });
  await run("picker read failures are explicit and can reload without an Agent", async ({page, state}) => {
    state.failTasks = true;
    await page.getByRole("button", {name: "Choose task", exact: true}).click();
    await page.getByRole("alert").filter({hasText: "Task storage unavailable"}).waitFor({timeout: 3000});
    assert.equal(await page.getByRole("option").count(), 0);
    state.failTasks = false;
    await page.getByRole("button", {name: "Reload tasks"}).click();
    await page.getByRole("option", {name: /Login API/}).waitFor();
    assert.equal(state.created, 0);
  });
  await run("changing a preselection during binding waits for that binding before unlinking", async ({page, state, choose}) => {
    await choose();
    let release;
    state.linkGate = new Promise(resolve => {release = resolve;});
    const started = new Promise(resolve => {state.linkStarted = resolve;});
    const initializing = page.evaluate(() => window.chat.loadSlashCommands());
    await started;
    await page.getByRole("button", {name: "Choose task", exact: true}).click();
    await page.getByRole("option", {name: /No task/}).click();
    release(); await initializing;
    await page.getByRole("dialog").waitFor({state: "detached"});
    assert.equal(state.owner, null);
    assert.equal(state.created, 1);
    assert.deepEqual(state.prompts, []);
  });
  await run("background initialization reports a failed task link and lets the user continue unassociated", async ({page, state, choose}) => {
    await choose(); state.failLink = true;
    await page.evaluate(() => window.chat.loadSlashCommands().catch(() => {}));
    await page.getByRole("alert").filter({hasText: "Task storage unavailable"}).waitFor({timeout: 3000});
    await page.getByRole("button", {name: "Choose task", exact: true}).first().click();
    await page.getByRole("option", {name: /No task/}).click();
    await page.getByRole("dialog").waitFor({state: "detached"});
    state.expectedOwner = null;
    await page.evaluate(() => window.chat.handleSend("Continue without a task"));
    assert.equal(state.created, 1); assert.equal(state.prompts.length, 1); assert.equal(state.owner, null);
  });
  for (const lostReply of [false, true]) await run(`changing a failed link choice to No task never replays the old choice (lost reply: ${lostReply})`, async ({page, state}) => {
    await page.evaluate(() => window.chat.loadSlashCommands());
    state.failLink = !lostReply; state.loseLinkReply = lostReply;
    await page.getByRole("button", {name: "Choose task", exact: true}).click();
    await page.getByRole("option", {name: /Login API/}).click();
    await page.getByRole("alert").waitFor();
    state.failLink = false; state.loseLinkReply = false;
    await page.getByRole("option", {name: /No task/}).click();
    await page.getByRole("dialog").waitFor({state: "detached"});
    assert.equal(state.owner, null);
    assert.deepEqual(state.prompts, []);
  });
  await run("shell retry honors pending task binding before executing or promoting the session", async ({page, state, choose}) => {
    await choose(); state.failLink = true;
    await page.evaluate(() => window.chat.handleSend("!echo hello"));
    assert.equal(state.created, 1); assert.equal(state.bashes.length, 0);
    assert.equal(await page.locator("textarea").inputValue(), "!echo hello");
    state.failLink = false;
    await page.evaluate(() => window.chat.handleSend("!echo hello"));
    assert.equal(state.owner, task.id); assert.equal(state.created, 1); assert.equal(state.bashes.length, 1);
  });
} finally {await browser.close();}
