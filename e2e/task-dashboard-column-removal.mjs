import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30144";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "remove-browser-")); await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "remove-data-")), options = { agentDir }, file = path.join(agentDir, "tasks/board.json");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const { GET, POST } = await jiti.import("../app/api/tasks/route.ts");
const call = r => taskOperation(r, options), list = () => call({ action: "list" });
const create = async (title, cwd = null) => (await call({ action: "create", id: randomUUID(), title, description: "Fixture", completionCriteria: "Confirm", cwd })).task;
const move = async (id, columnId) => { const b = await list(); return call({ action: "move", id, columnId, expectedRevision: b.tasks.find(t => t.id === id).revision, expectedOrderRevision: b.orderRevision, operationId: randomUUID(), position: { edge: "end" } }); };
const visible = await create("Visible source"), hidden = await create("Hidden source"), archived = await create("Archived source"), target = await create("Existing target");
await move(target.id, "review"); await call({ action: "set-archive", id: archived.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
const initial = await list();
const filter = { text: "", project: null, columnIds: ["todo"], priorities: [], labels: [], activity: "all" };
await call({ action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0, name: "Deleted status filter", filter, sort: "manual" });
const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
await context.addInitScript(() => {
  if (location.protocol.startsWith("http")) localStorage.setItem("pi-locale", "en");
  Object.defineProperty(crypto, "subtle", { configurable: true, get: () => undefined });
});
const errors = [], cases = [], posts = []; let failNext = false, loseNext = false, unexpectedApis = 0;
context.on("page", p => p.on("pageerror", e => errors.push(e.message)));
await context.route("**/api/**", async route => {
  const req = route.request(), u = new URL(req.url());
  if (u.pathname === "/api/tasks") {
    const input = req.method() === "GET" ? { action: "list" } : req.postDataJSON(); if (req.method() === "POST") posts.push(input);
    if (input.action === "remove-column" && failNext) { failNext = false; return route.fulfill({ status: 503, json: { code: "storage-unavailable", error: "Removal fixture unavailable" } }); }
    try { const response = req.method() === "GET" ? await GET() : await POST(new Request("http://localhost/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: req.postData() }));
      if (input.action === "remove-column" && loseNext && response.ok) { loseNext = false; return route.fulfill({ status: 503, json: { code: "storage-unavailable", error: "Removal response lost after commit" } }); }
      return route.fulfill({ status: response.status, json: await response.json() });
    } catch (e) { return route.fulfill({ status: e.code === "conflict" ? 409 : e.code === "storage-unavailable" ? 503 : 400, json: { error: e.message, code: e.code } }); }
  }
  if (u.pathname === "/api/agent/running" && req.method() === "GET") return route.fulfill({ json: { runningSessionIds: [], sessionActivity: {} } });
  unexpectedApis++; return route.fulfill({ json: {} });
});
const page = await context.newPage(), form = p => p.getByRole("form", { name: "Column settings", exact: true });
const row = (p,id) => form(p).locator(`[data-column-setting="${id}"]`);
const removeButton = (p,id) => row(p,id).getByRole("button", { name: /^Remove column:/ });
async function open(p) { await p.locator("header").getByRole("button", { name: "Column settings", exact: true }).click(); await form(p).waitFor(); }
async function cancel(p) { await form(p).getByRole("button", { name: "Cancel", exact: true }).click(); }
async function prepare(p,id) { await open(p); await removeButton(p,id).click(); }
const receiving = p => form(p).getByRole("combobox", { name: "Receiving column", exact: true });
const confirm = p => form(p).getByRole("button", { name: "Confirm transfer and remove column", exact: true });
async function saved(p) { await form(p).waitFor({ state: "hidden" }); await p.getByRole("status").filter({ hasText: "All source tasks transferred" }).waitFor(); }
try {
  await page.goto(`${base}/tasks`); await page.locator('[data-task-column="todo"]').waitFor();
  await page.getByLabel("Search task text", { exact: true }).fill("Visible");
  await page.locator(`[data-task-card="${visible.id}"]`).waitFor(); assert.equal(await page.locator("[data-task-card]").count(), 1);
  await open(page); assert.equal(await removeButton(page,"done").isDisabled(), true);
  await removeButton(page,"todo").focus(); await page.keyboard.press("Enter");
  assert.equal(await form(page).getByRole("list", { name: "Affected tasks" }).locator("li").count(), 3);
  assert.ok((await form(page).innerText()).includes("Archived source")); assert.ok((await form(page).innerText()).includes("Hidden source"));
  assert.equal(await receiving(page).locator('option[value="todo"]').count(), 0); assert.equal(await confirm(page).isDisabled(), true);
  const bytes = await readFile(file), count = posts.length; await receiving(page).selectOption("done");
  await form(page).getByRole("alert").filter({ hasText: "ALL affected tasks complete" }).waitFor(); assert.equal(await confirm(page).isDisabled(), true);
  await cancel(page); await cancel(page); assert.deepEqual(await readFile(file), bytes); assert.equal(posts.length, count);
  cases.push("full scope preview includes filtered-out/archived; done protected; target required and cancellation writes nothing");

  await prepare(page,"todo"); await receiving(page).selectOption("done");
  const completeCheck = form(page).getByRole("checkbox", { name: "I separately confirm marking all affected tasks complete." });
  await completeCheck.focus(); await page.keyboard.press("Space"); await confirm(page).focus(); await page.keyboard.press("Enter"); await saved(page);
  let b = await list(); assert.ok(b.tasks.filter(t => [visible.id,hidden.id,archived.id].includes(t.id)).every(t => t.columnId === "done")); assert.equal(b.tasks.find(t => t.id === archived.id).archived,true);
  assert.equal(await page.locator('[data-task-column="todo"]').count(),0);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Saved views", exact: true }).selectOption({ label: "Deleted status filter" });
  await page.getByRole("alert").filter({ hasText: "missing status column" }).waitFor(); assert.equal(await page.locator("[data-task-card]").count(),0);
  assert.deepEqual((await list()).savedViews[0].filter,filter);
  await page.reload(); await page.getByRole("combobox", { name: "Saved views", exact: true }).selectOption({ label: "Deleted status filter" });
  assert.equal(await page.locator("[data-task-card]").count(),0); await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  cases.push("keyboard separate completion consent transfers all tasks without restore; saved deleted-ID filter fails closed after reload");

  // Create via real form after default todo was removed.
  await page.getByRole("button", { name: "New task", exact: true }).click(); await page.getByLabel("Title", { exact: true }).fill("Created after todo deletion");
  await page.getByRole("button", { name: "Create task", exact: true }).click(); await page.locator('[data-task-column="in-progress"]').getByText("Created after todo deletion", { exact: true }).waitFor();
  cases.push("ordinary browser creation after todo deletion uses first saved unfinished column");

  await prepare(page,"in-progress"); await receiving(page).selectOption("review"); failNext = true; await confirm(page).click();
  await form(page).getByRole("alert").filter({ hasText: "Removal fixture unavailable" }).waitFor();
  const failed = posts.at(-1); await page.evaluate(() => window.dispatchEvent(new Event("online"))); await receiving(page).waitFor();
  await form(page).getByRole("button", { name: "Retry exact column removal", exact: true }).click(); await saved(page); assert.deepEqual(posts.at(-1),failed);
  b = await list(); assert.deepEqual(b.tasks.filter(t => t.columnId === "review").map(t => t.title), ["Existing target","Created after todo deletion"]);
  cases.push("failure and online preserve fixed request/target; exact retry keeps target order and appends source");

  await prepare(page,"blocked"); await receiving(page).selectOption("review"); loseNext = true; await confirm(page).click();
  await form(page).getByRole("alert").filter({ hasText: "response lost after commit" }).waitFor();
  const lost = posts.at(-1), stable = await readFile(file); assert.equal((await list()).columns.some(c=>c.id==="blocked"),false);
  await page.locator("header").getByRole("button", { name: "Refresh", exact: true }).click();
  await form(page).getByRole("button", { name: "Retry exact column removal", exact: true }).click(); await saved(page);
  assert.deepEqual(posts.at(-1),lost); assert.deepEqual(await readFile(file),stable);
  cases.push("empty column deletion and lost-success response: refresh does not rebase; receipt confirmation writes no second change");

  // Introduce a custom source then race confirmation with a new incoming task.
  b = await list(); const custom = randomUUID(); await call({ action: "set-columns", expectedColumnsRevision: b.columnsRevision, columns: [...b.columns.map(({id,label})=>({id,label})),{id:custom,label:"Race source"}] });
  const race = await create("Race task"); await move(race.id,custom); await page.locator("header").getByRole("button",{name:"Refresh",exact:true}).click();
  await prepare(page,custom); await receiving(page).selectOption("review");
  const added = await create("Incoming after preview"); await move(added.id,custom); await confirm(page).click();
  await form(page).getByRole("alert").filter({hasText:"Columns or task order changed"}).waitFor(); assert.equal((await list()).columns.some(c=>c.id===custom),true);
  await cancel(page); await cancel(page); await prepare(page,custom);
  assert.equal(await form(page).getByRole("list",{name:"Affected tasks"}).locator("li").count(),2); await receiving(page).selectOption("review"); await confirm(page).click(); await saved(page);
  cases.push("concurrent incoming task rejects fixed confirmation; explicit cancel/reopen rechecks complete scope");

  await page.setViewportSize({width:390,height:844}); await page.reload(); await page.locator('[data-task-column="review"]').waitFor();
  await open(page); assert.equal(await removeButton(page,"review").isDisabled(),true); assert.equal(await removeButton(page,"done").isDisabled(),true); await cancel(page);
  b=await list();const mobile=randomUUID();await call({action:"set-columns",expectedColumnsRevision:b.columnsRevision,columns:[...b.columns.map(({id,label})=>({id,label})),{id:mobile,label:"Mobile source"}]});
  const longProject=path.join(agentDir,"p".repeat(220));await mkdir(longProject);
  const longTask=await create("L".repeat(200),longProject);await move(longTask.id,mobile);
  await call({action:"set-archive",id:longTask.id,archived:true,expectedArchiveRevision:0,operationId:randomUUID()});
  await page.reload();
  await page.locator("header").getByRole("button",{name:"Column settings",exact:true}).tap();await removeButton(page,mobile).tap();await receiving(page).selectOption("review");
  assert.equal(await receiving(page).evaluate(e=>getComputedStyle(e).fontSize),"16px");assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await form(page).getByRole("button",{name:"Cancel",exact:true}).tap();await cancel(page);assert.equal((await list()).columns.some(c=>c.id===mobile),true);
  await prepare(page,mobile);await receiving(page).selectOption("review");failNext=true;await confirm(page).tap();await form(page).getByRole("alert").filter({hasText:"Removal fixture unavailable"}).waitFor();
  await page.screenshot({path:path.join(evidence,"mobile-failure.png"),fullPage:true});await form(page).getByRole("button",{name:"Retry exact column removal",exact:true}).tap();await saved(page);
  cases.push("390px touch cancel/failure/retry with archived long-title/long-project task, 16px receiving select, no overflow; last unfinished and done disabled");
  // Real HTTP handler, not an unlimited public-operation mock: preview all 3500,
  // including 3499 archived tasks, but submit only the fixed server digest.
  await page.setViewportSize({width:1360,height:900});
  b=await list();const large=randomUUID();await call({action:"set-columns",expectedColumnsRevision:b.columnsRevision,columns:[...b.columns.map(({id,label})=>({id,label})),{id:large,label:"Large source"}]});
  const templateTask=await create("Capacity template"),largeDoc=JSON.parse(await readFile(file));
  const template=largeDoc.tasks.find(t=>t.id===templateTask.id),largeCount=3500;
  const largeTasks=Array.from({length:largeCount},(_,i)=>({...structuredClone(template),id:randomUUID(),title:i===0?"Large visible source":`Archived capacity source ${i}`,columnId:large,archived:i>0,archiveRevision:i>0?1:0}));
  largeDoc.tasks.push(...largeTasks);largeDoc.orderRevision+=largeCount;await writeFile(file,JSON.stringify(largeDoc));
  await page.getByLabel("Search task text",{exact:true}).fill("Large visible source");await page.locator("header").getByRole("button",{name:"Refresh",exact:true}).click();
  await page.locator(`[data-task-card="${largeTasks[0].id}"]`).waitFor();assert.equal(await page.locator("[data-task-card]").count(),1);
  await prepare(page,large);const fullScope=form(page).getByRole("list",{name:"Affected tasks"});
  assert.equal(await fullScope.locator("li").count(),largeCount);assert.ok((await fullScope.locator("li").last().innerText()).includes(`Archived capacity source ${largeCount-1}`));
  await receiving(page).selectOption("done");assert.equal(await confirm(page).isDisabled(),true);
  await form(page).getByRole("checkbox",{name:"I separately confirm marking all affected tasks complete."}).check();await confirm(page).click();await saved(page);
  const compact=posts.at(-1);assert.equal("expectedTasks" in compact,false);assert.match(compact.expectedSourceDigest,/^[0-9a-f]{64}$/);assert.ok(Buffer.byteLength(JSON.stringify(compact))<512);
  assert.equal(await page.evaluate(()=>typeof crypto.subtle),"undefined");
  const capacityBoard=await list();const sourceIds=new Set(largeTasks.map(t=>t.id));const transferred=capacityBoard.tasks.filter(t=>sourceIds.has(t.id));
  assert.equal(transferred.length,largeCount);assert.ok(transferred.every(t=>t.columnId==="done"));assert.equal(transferred.filter(t=>t.archived).length,largeCount-1);
  cases.push("3500-task full hidden/archive preview and actual HTTP bounded digest removal succeeds without crypto.subtle; separate completion consent retained");
  assert.equal(unexpectedApis,0);assert.deepEqual(errors,[]);assert.equal(new Set(capacityBoard.tasks.map(t=>t.id)).size,capacityBoard.tasks.length);
  await writeFile(path.join(evidence,"results.json"),JSON.stringify({cases,errors,unexpectedApis,posts,agentDir,initial,board:await list()},null,2));
  console.log(`PASS ${cases.length} safe removal scenarios; evidence=${evidence}`);
} catch(e) {await page.screenshot({path:path.join(evidence,"failure.png"),fullPage:true}).catch(()=>{});await writeFile(path.join(evidence,"failure.json"),JSON.stringify({error:String(e),cases,errors,posts,unexpectedApis},null,2));throw e;}
finally {await browser.close();if(originalAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=originalAgentDir;}
