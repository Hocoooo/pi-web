// Whole-page /new navigation + first-send boundary. All APIs/SSE are fixtures;
// reuse checkout dev (not the installed service), never touch real sessions/providers.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const sourceId = "22222222-2222-4222-8222-222222222222";
const newId = "55555555-5555-4555-8555-555555555555";
const cwd = "/fixture/project";
const source = {id: sourceId, cwd, projectKey: cwd, projectRoot: cwd, name: "Source chat", created: "2026-10-10T00:00:00Z", modified: "2026-10-10T00:00:00Z", path: "/fixture/source.jsonl", firstMessage: "Source-only history", messageCount: 1};
const other = {...source, id: "66666666-6666-4666-8666-666666666666", cwd: "/fixture/other", projectKey: "/fixture/other", projectRoot: "/fixture/other", name: "Other project"};
const target = {...source, id: "77777777-7777-4777-8777-777777777777", name: "Target chat"};
const task = {id: "11111111-1111-4111-8111-111111111111", title: "Task A", status: "Review", revision: 3, archived: false};
const board = {columns: [{id: "review", label: "Review", isCompletion: false}], columnsRevision: 0, orderRevision: 0,
  viewsRevision: 0, savedViews: [], columnRemovalDigests: {}, tasks: [{...task, columnId: "review", archiveRevision: 0,
    project: {projectKey: cwd, projectRoot: cwd}, description: "", completionCriteria: "", priority: 1, labels: [],
    createdAt: source.created, updatedAt: source.modified, sessionIds: [sourceId, target.id], sessionContexts: [], sessionUpdates: [],
    sharedContext: {currentVersionId: null, versions: []}}]};
const model = {provider: "fixture", modelId: "reasoning"};
const browser = await chromium.launch({headless: true});
async function run(name, options, check) {
  const context = await browser.newContext({viewport: {width: 1200, height: 850}});
  await context.addInitScript(() => {
    localStorage.setItem("pi-locale", "en");
    window.EventSource = class {readyState = 1; constructor() {queueMicrotask(() => this.onmessage?.({data: JSON.stringify({type: "connected"})}));} close() {this.readyState = 2;}};
  });
  const state = {created: [], commands: [], prompts: [], tasks: [], sourceOwner: options.noTask ? null : task.id,
    newOwner: null, expectedOwner: options.noTask ? null : task.id, level: options.level ?? "high", failRead: false, failLink: false, errors: []};
  const tasks = [{...task, archived: options.archived ?? false}];
  await context.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname, body = req.postDataJSON();
    let data = {};
    if (path === "/api/tasks") {
      state.tasks.push(body);
      const owner = body?.sessionId === sourceId ? state.sourceOwner : state.newOwner;
      if (!body || body.action === "list") data = board;
      else if (body.action === "sessions") data = {linked: [source, target], candidates: []};
      else if (body?.action === "session-task") data = {task: tasks.find(item => item.id === owner) ?? null};
      else if (body?.action === "task-picker") {
        if (body.sessionId === sourceId && state.readGate) {state.readStarted(); await state.readGate;}
        if (state.failRead) return route.fulfill({status: 503, json: {error: "Task storage unavailable"}});
        data = {tasks, relation: body.sessionId ? {sessionId: body.sessionId, sourceTaskId: owner, generation: 0, updateRevision: 0} : null};
      } else if (body?.action === "link") {
        if (state.failLink) return route.fulfill({status: 503, json: {error: "Task link unavailable"}});
        assert.equal(body.sessionIds[0], newId);
        state.newOwner = body.id;
      }
    } else if (path === "/api/models") data = {
      models: {"fixture:reasoning": "Reasoning Model", "fixture:default": "Default Model"},
      modelList: [{...model, id: model.modelId, name: "Reasoning Model"}, {provider: "fixture", id: "default", name: "Default Model"}],
      defaultModel: {provider: "fixture", modelId: "default"}, defaultThinkingLevel: "medium",
      thinkingLevels: {"fixture:reasoning": ["off", "low", "medium", "high"], "fixture:default": ["off", "medium"]},
    };
    else if (path === "/api/agent/new") {
      state.created.push(body);
      data = {sessionId: options.startBlank && state.created.length === 1 ? sourceId : newId, model: {provider: body.provider ?? "fixture", modelId: body.modelId ?? "default"}, thinkingLevel: body.thinkingLevel ?? "medium"};
    } else if (path.startsWith("/api/agent/") && req.method() === "POST") {
      state.commands.push(body);
      if (body.type === "prompt") {
        assert.equal(state.newOwner, state.expectedOwner, "task association precedes the first prompt");
        state.prompts.push(body);
        if (state.promptGate) {state.promptStarted(); await state.promptGate;}
      }
      data = {success: true, data: body.type === "get_state" ? {model: {provider: "fixture", id: "reasoning"}, thinkingLevel: state.level} : body.type === "get_tools" ? [] : {}};
    } else if (path === "/api/sessions") data = {sessions: [source, other, target], runningSessionIds: options.running ? [sourceId] : []};
    else if (path === `/api/sessions/${target.id}`) {
      if (state.targetGate) {state.targetStarted(); await state.targetGate;}
      data = {sessionId: target.id, info: target, tree: [], leafId: null, context: {messages: [], entryIds: [], model, thinkingLevel: state.level}};
    }
    else if (path === `/api/sessions/${sourceId}`) data = {sessionId: sourceId, info: source, tree: [], leafId: null, context: {
      messages: [{role: "user", content: "Source-only history", timestamp: 1}], entryIds: ["entry1"], model, thinkingLevel: state.level,
    }};
    else if (path === `/api/sessions/${newId}`) data = {sessionId: newId, tree: [], leafId: null, context: {messages: [], entryIds: [], model, thinkingLevel: state.level}};
    else if (path === `/api/sessions/${sourceId}/state`) data = {running: options.running ?? false, state: {
      model: {provider: "fixture", id: "reasoning"}, thinkingLevel: state.level, isStreaming: options.running ?? false, isPromptRunning: options.running ?? false,
    }};
    else if (path.endsWith("/state")) data = {running: false};
    else if (path === "/api/cwd/validate") data = {cwd: body.cwd, projectRoot: body.cwd, projectKey: body.cwd};
    else if (path === "/api/home") data = {home: "/fixture"};
    else if (path === "/api/web-auth") data = {enabled: false};
    else if (path === "/api/agent/running") data = {runningSessionIds: options.running ? [sourceId] : []};
    else if (path === "/api/subagents/settings") data = {enabled: false};
    else if (path === "/api/worktrees") data = {worktrees: []};
    await route.fulfill({json: data});
  });
  const page = await context.newPage();
  page.on("pageerror", error => state.errors.push(error.message));
  try {
    await page.goto(options.startBlank ? `${base}/?cwd=${encodeURIComponent(cwd)}` : `${base}/?session=${sourceId}`);
    if (options.startBlank) await page.getByLabel("Session project", {exact: true}).waitFor();
    else await page.getByText("Source-only history", {exact: true}).waitFor();
    const input = page.locator("textarea").first();
    const navigateNew = async () => {
      await input.fill("/new"); await input.press("Enter");
      await page.waitForURL(url => !url.searchParams.has("session"));
      await page.getByLabel("Session project", {exact: true}).waitFor();
      assert.equal(await input.inputValue(), "");
      assert.equal(await page.getByText("Source-only history", {exact: true}).count(), 0);
      assert.equal(state.created.length, 0, "/new must not create an idle runtime");
    };
    await check({page, state, input, navigateNew});
    assert.deepEqual(state.errors, []);
    assert.equal(state.sourceOwner, options.noTask ? null : task.id, "source task is unchanged");
    assert.equal(state.commands.some(command => command.type === "abort" || command.type === "set_model"), false);
    console.log("PASS", name);
  } catch (error) {
    console.error(name, {url: page.url(), errors: state.errors, page: (await page.locator("body").innerText()).slice(-2200)});
    throw error;
  } finally {await context.close();}
}
try {
  for (const options of [{}, {running: true}, {level: "off"}, {archived: true}, {noTask: true}]) {
    await run(`same model/effort/task first send ${JSON.stringify(options)}`, options, async ({page, state, input, navigateNew}) => {
      await navigateNew();
      await page.getByRole("button", {name: options.noTask ? "Choose task" : "Preselected task: Task A", exact: true}).waitFor();
      await input.fill("Next message"); await input.press("Enter");
      await page.waitForFunction(() => new URLSearchParams(location.search).get("session") === "55555555-5555-4555-8555-555555555555");
      assert.deepEqual(state.created, [{cwd, type: "ensure_session", ...model, thinkingLevel: options.level ?? "high"}]);
      assert.deepEqual(state.prompts, [{type: "prompt", message: "Next message"}]);
      assert.equal(state.newOwner, options.noTask ? null : task.id);
      assert.equal(state.tasks.some(body => !["session-task", "task-picker", "link"].includes(body?.action)), false, "no task status/archive/context mutation");
    });
  }
  await run("task read failure stays on source, reports error and allows /new retry", {}, async ({page, state, input, navigateNew}) => {
    state.failRead = true;
    await input.fill("/new"); await input.press("Enter");
    await page.getByText(/Could not open a new chat with the current settings and task/).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("session"), sourceId);
    assert.equal(state.created.length, 0); assert.deepEqual(state.prompts, []);
    state.failRead = false;
    await navigateNew();
    await page.getByRole("button", {name: "Preselected task: Task A", exact: true}).waitFor();
  });
  await run("failed inherited link restores draft and retries the same session", {}, async ({page, state, input, navigateNew}) => {
    await navigateNew(); state.failLink = true;
    await input.fill("Keep this message"); await input.press("Enter");
    await page.getByRole("alert").filter({hasText: "Task link unavailable"}).waitFor();
    assert.equal(await input.inputValue(), "Keep this message");
    assert.equal(state.created.length, 1); assert.deepEqual(state.prompts, []);
    state.failLink = false;
    await input.press("Enter");
    await page.waitForURL(url => url.searchParams.get("session") === newId);
    assert.equal(state.created.length, 1);
    assert.deepEqual(state.prompts, [{type: "prompt", message: "Keep this message"}]);
  });
  await run("project change clears inherited task and model overrides", {}, async ({page, state, input, navigateNew}) => {
    await navigateNew();
    await page.getByLabel("Session project", {exact: true}).selectOption(other.cwd);
    await page.waitForURL(url => url.searchParams.get("cwd") === other.cwd);
    await page.getByRole("button", {name: "Choose task", exact: true}).waitFor();
    assert.equal(state.created.length, 0);
    state.expectedOwner = null;
    await input.fill("Other project message"); await input.press("Enter");
    await page.waitForURL(url => url.searchParams.get("session") === newId);
    assert.deepEqual(state.created, [{cwd: other.cwd, type: "ensure_session"}]);
  });
  await run("ordinary new-session shortcut does not reuse an inherited seed", {}, async ({page, state, input, navigateNew}) => {
    await navigateNew();
    const sourceInput = await input.elementHandle();
    await page.keyboard.press("Control+Alt+n");
    await page.waitForFunction(element => !element.isConnected, sourceInput);
    await page.getByRole("button", {name: "Choose task", exact: true}).waitFor();
    state.expectedOwner = null;
    await input.fill("Ordinary new chat"); await input.press("Enter");
    await page.waitForURL(url => url.searchParams.get("session") === newId);
    assert.deepEqual(state.created, [{cwd, type: "ensure_session"}]);
  });
  await run("a newer in-flight task-panel navigation wins over /new", {}, async ({page, state, input}) => {
    let releaseRead, releaseTarget;
    state.readGate = new Promise(resolve => {releaseRead = resolve;});
    state.targetGate = new Promise(resolve => {releaseTarget = resolve;});
    const reading = new Promise(resolve => {state.readStarted = resolve;});
    const navigating = new Promise(resolve => {state.targetStarted = resolve;});
    await page.locator("[data-session-task]").getByRole("button", {name: "Task details", exact: true}).waitFor();
    await input.fill("/new"); await input.press("Enter"); await reading;
    await page.locator("[data-session-task]").getByRole("button", {name: "Task details", exact: true}).click();
    await page.getByRole("dialog").getByRole("link", {name: "Target chat", exact: true}).click();
    await navigating;
    releaseRead();
    await page.waitForFunction(() => !document.querySelector("textarea").closest("fieldset").disabled);
    assert.equal(new URL(page.url()).searchParams.get("session"), sourceId, "old /new must not navigate while the newer destination is loading");
    releaseTarget();
    await page.waitForURL(url => url.searchParams.get("session") === target.id);
    assert.equal(state.created.length, 0);
  });
  await run("automatic source promotion does not cancel an already requested /new", {noTask: true, startBlank: true}, async ({page, state, input}) => {
    let releasePrompt, releaseRead;
    state.promptGate = new Promise(resolve => {releasePrompt = resolve;});
    state.readGate = new Promise(resolve => {releaseRead = resolve;});
    const prompting = new Promise(resolve => {state.promptStarted = resolve;});
    const reading = new Promise(resolve => {state.readStarted = resolve;});
    await input.fill("First source prompt"); await input.press("Enter"); await prompting;
    await input.fill("/new"); await input.press("Enter"); await reading;
    releasePrompt();
    await page.waitForURL(url => url.searchParams.get("session") === sourceId);
    releaseRead();
    await page.waitForURL(url => !url.searchParams.has("session"), {timeout: 5000});
    await page.getByLabel("Session project", {exact: true}).waitFor();
    assert.equal(state.created.length, 1, "only the source runtime was created");
    assert.deepEqual(state.prompts, [{type: "prompt", message: "First source prompt"}]);
  });
  await run("late source task read cannot navigate after the user leaves", {}, async ({page, state, input}) => {
    let release;
    state.readGate = new Promise(resolve => {release = resolve;});
    const started = new Promise(resolve => {state.readStarted = resolve;});
    await input.fill("/new"); await input.press("Enter"); await started;
    // The global new-session shortcut is a separate explicit navigation entry.
    await page.keyboard.press("Control+Alt+n");
    await page.waitForURL(url => !url.searchParams.has("session"));
    release();
    await page.getByRole("button", {name: "Choose task", exact: true}).waitFor();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole("button", {name: "Preselected task: Task A", exact: true}).count(), 0);
    assert.equal(state.created.length, 0);
  });
} finally {await browser.close();}
