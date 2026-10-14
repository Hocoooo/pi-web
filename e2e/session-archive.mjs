// Existing dev server + intercepted API only. Never changes real user sessions.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createJiti } from "jiti";
const { getLocalePlugin } = await createJiti(import.meta.url).import("../lib/i18n/registry.ts");

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const browser = await chromium.launch({ headless: true });
const id = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const cwd = "/fixtures/session-archive";
const fixtures = [id, otherId].map((id, i) => ({ id, path: `${cwd}/${id}.jsonl`, cwd, projectRoot: cwd, projectKey: cwd, sessionKind: "project", name: i ? "Other conversation" : "Archive conversation", firstMessage: "Preserved older history", messageCount: 2, created: "2026-01-01T00:00:00Z", modified: `2026-01-0${2-i}T00:00:00Z`, archived: false }));
const archivedIds = new Set();
const mutations = [], errors = [], scopes = [];
let version = 1, refuseNext = false;
const catalog = () => fixtures.map(s => ({...s, archived: archivedIds.has(s.id)}));
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
const fulfillApi = async route => {
  const req = route.request(), url = new URL(req.url()), path = url.pathname;
  const json = (data, status = 200) => route.fulfill({status, json:data});
  if (req.method() === "POST" && path === "/api/tasks" && req.postDataJSON()?.action === "session-task") return json({ task:null });
  if (req.method() === "POST" && path.endsWith("/lease")) return json({ok:true});
  if (req.method() !== "GET") {
    mutations.push({ method:req.method(), path, body:req.postDataJSON() });
    if (path === `/api/sessions/${id}/archive`) {
      if (refuseNext) { refuseNext = false; return json({ error:"Fixture write refused" }, 503); }
      const { archived } = req.postDataJSON();
      if (archived) archivedIds.add(id); else archivedIds.delete(id);
      version++;
      return json({ok:true, sessionId:id, archived});
    }
    return json({ error:"Unexpected mutation" }, 400);
  }
  if (path === "/api/tasks/catalog") return json({tasks:[]});
  if (path === "/api/sessions") return json({sessions:catalog(), sessionListVersion:version, runningSessionIds:[id]});
  if (path === "/api/agent/running") return json({runningSessionIds:[id], sessionListVersion:version});
  if (path === "/api/sessions/search") {
    const scope = url.searchParams.get("archive"); scopes.push(scope);
    return json({results:catalog().filter(s => s.archived === (scope === "archived")).map(session => ({ session, blockIndex:0, before:"", match:"Preserved", after:" older history" })), truncated:false});
  }
  if (path.startsWith("/api/sessions/")) {
    const info = catalog().find(s => s.id === path.split("/")[3]);
    return json({ info, sessionId:info?.id, filePath:info?.path, leafId:"answer", tree:[], context:{ messages:[{role:"user", content:"Preserved older history", timestamp:1000}, {role:"assistant", content:[{type:"text", text:"Complete answer remains available"}], timestamp:2000}], entryIds:["question", "answer"], hasMore:false } });
  }
  if (path.startsWith("/api/agent/")) return json({running:false});
  if (path === "/api/home") return json({home:"/home/fixture"});
  if (path === "/api/worktrees") return json({projectRoot:cwd, projectKey:cwd, isGit:false, isTopLevel:true, worktrees:[]});
  if (path === "/api/project-trust") return json({trusted:true, requiresTrust:false});
  if (path === "/api/models") return json({models:[], modelList:[]});
  if (path.startsWith("/api/files")) return json({entries:[]});
  return json({});
};
await context.route("**/api/**", fulfillApi);
const page = await context.newPage(), peer = await context.newPage();
for (const p of [page, peer]) p.on("pageerror", e => errors.push(e.message));
const row = p => p.locator(`[data-sidebar-row="session:${id}"]`);
const filters = (p, messages = getLocalePlugin("en").messages) => {
  const label = key => messages[`sidebar.${key}`];
  const dialog = p.getByRole("dialog", {name:label("searchFilters"), exact:true});
  const open = async () => {
    if (!await dialog.isVisible()) await p.getByRole("button", {name:label("searchFilters"), exact:true}).click();
    const back = dialog.getByRole("button", {name:label("filtersBack"), exact:true});
    if (await back.isVisible()) await back.click();
    await dialog.getByRole("searchbox", {name:label("contentSearch"), exact:true}).waitFor();
  };
  const scopeOptions = async () => {
    await open();
    await dialog.getByRole("button", {name:label("conditionArchive"), exact:true}).click();
  };
  return {
    open,
    close: async () => { if (await dialog.isVisible()) await dialog.getByRole("button", {name:label("closeFilters"), exact:true}).click(); },
    scope: async value => {
      await scopeOptions();
      await dialog.locator(`[data-archive-option="${value}"]`).click();
      await dialog.getByRole("searchbox", {name:label("contentSearch"), exact:true}).waitFor();
    },
    assertScope: async value => {
      await scopeOptions();
      assert.equal(await dialog.locator(`[data-archive-option="${value}"]`).getAttribute("aria-selected"), "true", "applied conversation scope is retained");
      await dialog.getByRole("button", {name:label("filtersBack"), exact:true}).click();
    },
    body: async query => { await open(); await dialog.getByRole("searchbox", {name:label("contentSearch"), exact:true}).fill(query); },
  };
};
const assertActionSizes = async (p, archived, messages = getLocalePlugin("en").messages) => {
  const names = [
    messages["sidebar.rename"],
    `${messages[archived ? "sidebar.restoreSession" : "sidebar.archiveSession"]}: Archive conversation`,
    messages["sidebar.deleteWithShiftClick"],
  ];
  const sizes = await Promise.all(names.map(name => row(p).getByRole("button", {name, exact:true}).evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const icon = button.querySelector("svg").getBoundingClientRect();
    return { width:bounds.width, height:bounds.height, iconWidth:icon.width, iconHeight:icon.height };
  })));
  assert.deepEqual(sizes, names.map(() => ({ width:32, height:32, iconWidth:14, iconHeight:14 })),
    "rename, archive/restore and delete must share 32px targets and 14px icons");
};
try {
  await page.goto(`${base}/?session=${id}`);
  await row(page).waitFor();
  const panel = filters(page);
  await panel.open();
  await panel.close();
  await peer.goto(`${base}/?session=${id}`);
  await row(peer).waitFor();
  const composer = page.locator("textarea.chat-input-textarea").first();
  await composer.fill("draft is preserved");
  const originalUrl = page.url();
  const archiveButton = page.getByRole("button", {name:"Archive session: Archive conversation", exact:true});
  await page.mouse.move(1100, 400);
  assert.equal(await archiveButton.count(), 0, "archive is hidden before hover");
  assert.equal(await row(page).getByRole("button", {name:"Rename", exact:true}).count(), 0);
  await row(page).hover();
  await archiveButton.waitFor();
  await row(page).getByRole("button", {name:"Rename", exact:true}).waitFor();
  await row(page).getByRole("button", {name:"Delete (Shift+click to delete without confirmation)", exact:true}).waitFor();
  await assertActionSizes(page, false);
  await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
  await assertActionSizes(page, false);
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
  await page.mouse.move(1100, 400);
  await archiveButton.waitFor({state:"detached"});
  assert.equal(await row(page).getByRole("button").count(), 0, "all three actions hide together on leave");
  await row(page).hover();
  refuseNext = true;
  await page.getByRole("button", {name:"Archive session: Archive conversation", exact:true}).click();
  await page.getByRole("alert").filter({hasText:"Archive or restore was not confirmed"}).waitFor();
  assert.equal(await row(page).count(), 1, "failed archive does not optimistically hide a session");
  await page.getByRole("button", {name:"Retry", exact:true}).click();
  await row(page).waitFor({state:"detached"});
  assert.equal(page.url(), originalUrl, "archiving selected conversation does not navigate");
  assert.equal(await composer.inputValue(), "draft is preserved");
  await page.getByText("Complete answer remains available", {exact:true}).waitFor();
  await row(peer).waitFor({state:"detached"});
  assert.equal(archivedIds.has(id), true);
  await panel.scope("archived");
  await panel.close();
  await row(page).waitFor();
  await row(page).click();
  assert.equal(archivedIds.has(id), true, "opening archived history does not restore");
  assert.equal(await composer.inputValue(), "draft is preserved");
  await panel.body("Preserved");
  await panel.close();
  await page.getByRole("button").filter({hasText:"Archive conversation"}).filter({hasText:"Preserved older history"}).waitFor();
  assert.equal(scopes.at(-1), "archived");
  await panel.scope("active");
  await panel.close();
  await page.getByRole("button").filter({hasText:"Other conversation"}).filter({hasText:"Preserved older history"}).waitFor();
  assert.equal(scopes.at(-1), "active");
  assert.equal(await page.getByRole("button").filter({hasText:"Archive conversation"}).count(), 0);
  await panel.body("");
  await panel.scope("archived");
  await panel.close();
  await row(page).waitFor();
  await row(page).hover();
  const restore = page.getByRole("button", {name:"Restore session: Archive conversation", exact:true});
  await assertActionSizes(page, true);
  await restore.focus();
  await page.keyboard.press("Enter");
  await row(page).waitFor({state:"detached"});
  assert.equal(archivedIds.has(id), false);
  await row(peer).waitFor();
  await panel.scope("active");
  await panel.close();
  await row(page).waitFor();
  assert.equal(await composer.inputValue(), "draft is preserved");
  await row(page).click({button:"right"});
  const archiveMenu = page.getByRole("menuitem", {name:"Archive session", exact:true});
  await archiveMenu.waitFor();
  await row(peer).hover();
  await peer.getByRole("button", {name:"Archive session: Archive conversation", exact:true}).click();
  await row(page).waitFor({state:"detached"});
  const confirmedMenu = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${id}/archive`) && response.request().method() === "PUT");
  await archiveMenu.click();
  await confirmedMenu;
  assert.equal(archivedIds.has(id), true, "stale Archive menu must not restore after another tab archives");
  await page.reload();
  await panel.assertScope("active");
  await panel.close();
  assert.equal(await row(page).count(), 0, "refresh retains server archive state and default active scope");
  await page.getByText("Complete answer remains available", {exact:true}).waitFor();
  await page.keyboard.press("Alt+ArrowLeft");
  await row(page).waitFor();
  await panel.assertScope("archived");
  await panel.close();
  assert.equal(archivedIds.has(id), true);
  assert.ok(mutations.every(m => m.method === "PUT" && m.path.endsWith("/archive")), "no delete, stop, prompt or task mutation");
  assert.deepEqual(mutations.map(m => m.body.archived), [true,true,false,true,true]);
  assert.deepEqual(errors, []);
  await context.close();
  for (const locale of ["en", "zh-CN", "zh-TW"]) for (const theme of ["light", "dark"]) {
    archivedIds.add(id);
    const messages = getLocalePlugin(locale).messages;
    const mobile = await browser.newContext({ locale: locale === "en" ? "en-US" : locale, viewport: { width:390, height:844 }, hasTouch:true, isMobile:true });
    await mobile.addInitScript(({locale,theme}) => { localStorage.setItem("pi-locale", locale); localStorage.setItem("pi-theme", theme); }, {locale,theme});
    await mobile.route("**/api/**", fulfillApi);
    const touchPage = await mobile.newPage();
    touchPage.on("pageerror", e => errors.push(e.message));
    await touchPage.goto(`${base}/?session=${id}`);
    await touchPage.getByText("Complete answer remains available", {exact:true}).waitFor();
    await touchPage.getByRole("button", {name:messages["sidebar.show"], exact:true}).tap();
    const mobilePanel = filters(touchPage, messages);
    await mobilePanel.scope("archived");
    await mobilePanel.close();
    await row(touchPage).waitFor();
    await touchPage.mouse.move(385, 400);
    await row(touchPage).hover(); // Reveal with a pointer, then validate the touch target.
    const restoreButton = touchPage.getByRole("button", {name:`${messages["sidebar.restoreSession"]}: Archive conversation`, exact:true});
    await assertActionSizes(touchPage, true, messages);
    const bounds = await restoreButton.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, `${locale}/${theme} touch action stays in viewport`);
    await restoreButton.tap();
    await row(touchPage).waitFor({state:"detached"});
    assert.equal(archivedIds.has(id), false);
    await mobilePanel.scope("active");
    await mobilePanel.close();
    await row(touchPage).waitFor();
    await touchPage.mouse.move(385, 400);
    await row(touchPage).hover();
    await assertActionSizes(touchPage, false, messages);
    await touchPage.getByRole("button", {name:`${messages["sidebar.archiveSession"]}: Archive conversation`, exact:true}).tap();
    await row(touchPage).waitFor({state:"detached"});
    assert.equal(archivedIds.has(id), true);
    await mobile.close();
  }
  assert.deepEqual(errors, []);
  assert.ok(mutations.every(m => m.method === "PUT" && m.path.endsWith("/archive")));
  console.log("PASS: shared hover-only rename/archive/delete actions with matching 32px targets and 14px icons at 14px/16px root font sizes, failure/retry, selected chat + draft/history preservation, archived opening/search/keyboard restore, cross-tab sync + stale menu intent, reload, explicit focus, 390px pointer-revealed touch targets in 3 languages × 2 themes; no delete/stop/prompt/task mutation");
} catch (error) {
  console.error(JSON.stringify({ mutations, errors }));
  if (!page.isClosed()) await page.screenshot({ path: "/tmp/pi-web-session-archive-failure.png" });
  throw error;
} finally { await browser.close(); }
