// Real UI, all APIs intercepted: no user sessions or model/Agent writes.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = await mkdtemp(join(tmpdir(), "pi-web-search-filters-"));
const taskId = "11111111-1111-4111-8111-111111111111";
const project = {cwd:"/fixtures/unified-search", projectRoot:"/fixtures/unified-search", projectKey:"unified"};
const sessions = ["First conversation", "Unlinked conversation", "Archived conversation"].map((name,i) => ({...project,id:`unified-${i}`,name,firstMessage:name,path:`/fixtures/${i}.jsonl`,messageCount:1,created:"2026-01-01T00:00:00Z",modified:`2026-01-0${3-i}T00:00:00Z`,archived:i===2}));
const otherTaskId = "22222222-2222-4222-8222-222222222222";
const otherProject = {cwd:"/fixtures/other-project",projectRoot:`/fixtures/${"shared-directory/".repeat(15)}other-project`,projectKey:"other"};
const tasks = [{...project, project, id:taskId, title:"Migration task", description:"Database indexing", completionCriteria:"Durable acceptance", archived:false, updatedAt:"2026-01-01T00:00:00Z",sessionIds:["unified-0","unified-2"]},
  {project:otherProject,id:otherTaskId,title:"Migration task",description:"Different migration",completionCriteria:"Other acceptance",archived:true,updatedAt:"2026-01-01T00:00:00Z",sessionIds:[]}];
const browser = await chromium.launch({headless:true});
async function openMobileDrawer(page) {
  await page.waitForFunction(() => !document.getElementById("session-sidebar")?.classList.contains("sidebar-mobile-pending"));
  if(await page.locator('#session-sidebar').evaluate(element => element.classList.contains("sidebar-closed"))) await page.locator('button[aria-controls="session-sidebar"]').click();
  await page.waitForFunction(() => Math.abs(document.getElementById("session-sidebar").getBoundingClientRect().left) < 1);
}
try {
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  const page = await context.newPage(), errors = [], unexpected = [], searches = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(() => {localStorage.setItem("pi-locale","en");localStorage.setItem("pi-web:file-explorer:open","false");});
  await context.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    // The existing /task picker reads metadata through a POST action. Only
    // this read is allowed for the stacked-dialog check; writes still abort.
    if(url.pathname === "/api/tasks" && request.method() === "POST" && request.postDataJSON()?.action === "task-picker") return route.fulfill({json:{tasks:[],relation:null}});
    if(request.method() !== "GET" && url.pathname !== "/api/cwd/validate") {unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();}
    const json = data => route.fulfill({json:data});
    if(url.pathname === "/api/tasks/catalog") return json({tasks});
    if(url.pathname === "/api/sessions") return json({sessions,sessionListVersion:1,runningSessionIds:[]});
    if(url.pathname === "/api/agent/running") return json({sessionListVersion:1,runningSessionIds:[]});
    if(url.pathname === "/api/sessions/search") {
      searches.push(Object.fromEntries(url.searchParams));
      const matches = sessions.filter(session => Boolean(session.archived)===(url.searchParams.get("archive")==="archived") && (!url.searchParams.has("taskId") || tasks[0].sessionIds.includes(session.id)));
      return json({results:matches.map(session => ({session,blockIndex:0,before:"",match:"Matching excerpt",after:""})),truncated:false});
    }
    if(url.pathname === "/api/worktrees") return json({...project,isGit:false,isTopLevel:true,worktrees:[]});
    if(url.pathname === "/api/cwd/validate") return json(project);
    if(url.pathname === "/api/models") return json({models:[],modelList:[]});
    if(url.pathname === "/api/home") return json({home:"/home/fixture"});
    if(url.pathname.startsWith("/api/files")) return json({entries:[]});
    return json({});
  });
  await page.goto(`${base}/?cwd=${encodeURIComponent(project.cwd)}`,{waitUntil:"networkidle"});
  const opener = page.getByRole("button",{name:"Search and filters",exact:true});
  await opener.waitFor({timeout:5000});
  const sessionScope = page.getByRole("combobox",{name:"Session list",exact:true});
  assert.equal(await page.locator('#session-sidebar select').count(),1,"only the original session range selector is permanent");
  assert.equal(await sessionScope.inputValue(),"active","daily conversations remain the default");
  assert.deepEqual(await sessionScope.locator('option').allTextContents(),["Active sessions","Archived sessions (1)"]);
  assert.equal(await page.locator('#session-sidebar input[type="search"]').count(),0,"no permanent task/body search fields");
  assert.equal(await page.locator('[data-sidebar-filter-summary]').count(),0,"default view has no summary row");
  await opener.click();
  await page.getByRole("dialog",{name:"Search and filters",exact:true}).waitFor();
  const dialog = page.getByRole("dialog",{name:"Search and filters",exact:true});
  const originalUrl = page.url();
  await dialog.getByRole("button",{name:"Task",exact:true}).click();
  await dialog.getByRole("searchbox",{name:"Search tasks",exact:true}).fill("Database indexing");
  await dialog.locator(`[data-task-option="${taskId}"]`).waitFor();
  assert.equal(searches.length,0,"task metadata lookup never starts body search");
  await dialog.locator(`[data-task-option="${taskId}"]`).click();
  assert.equal(page.url(),originalUrl,"condition editing never navigates chat");
  await dialog.getByRole("button",{name:"Close filters",exact:true}).click();
  await page.locator('[data-sidebar-filter-summary]').waitFor();
  assert.equal(await page.locator('[data-sidebar-row="session:unified-1"]').count(),0,"task condition stays active after closing");
  assert.equal(await page.locator('#session-sidebar select').count(),1);
  await sessionScope.selectOption("archived");
  await page.locator('[data-sidebar-row="session:unified-2"]').waitFor();
  assert.equal(await page.locator('[data-sidebar-row="session:unified-0"]').count(),0);
  assert.equal(page.url(),originalUrl,"switching the original session range does not navigate chat");
  assert.equal(await opener.locator('[aria-label="1 active conditions"]').count(),1,"archive is not counted as an extra search condition");
  await opener.click();
  assert.equal(await dialog.getByRole("button",{name:"Conversation scope",exact:true}).count(),0,"session range is not duplicated inside the popup");
  await dialog.getByRole("button",{name:"Add condition",exact:true}).click();
  assert.equal(await dialog.getByRole("button",{name:"Conversation scope",exact:true}).count(),0,"the condition menu does not duplicate session range");
  await dialog.getByRole("button",{name:"Task",exact:true}).click();
  await dialog.getByRole("button",{name:"Back to filters",exact:true}).click();
  await dialog.getByRole("searchbox",{name:"Search conversation content",exact:true}).fill("a phrase");
  await page.getByText("Matching excerpt",{exact:true}).waitFor();
  assert.equal(searches.at(-1).taskId,taskId);
  assert.equal(searches.at(-1).archive,"archived");
  for(const [name,value] of [["Task","Migration task"]]) {
    const description = await dialog.getByRole("button",{name,exact:true}).evaluate(element => (element.getAttribute("aria-describedby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" "));
    assert.equal(description,value,"home condition controls expose their applied values to screen readers");
  }
  await page.screenshot({path:join(evidence,"desktop-active-panel.png"),fullPage:true});
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(),0,"Escape closes only the panel");
  assert.equal(await opener.getAttribute("aria-expanded"),"false");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")),"Search and filters","keyboard close restores the opener");
  await page.getByText("Matching excerpt",{exact:true}).waitFor();
  const summary = page.locator('[data-sidebar-filter-summary]');
  assert.match((await summary.innerText()).replace(/\s+/g," "),/Migration task.*a phrase/);
  assert.doesNotMatch(await summary.innerText(),/Archived conversations/);
  assert.equal(await opener.locator('[aria-label="2 active conditions"]').count(),1,"badge counts Task and body only");
  for(const archive of ["active","archived"]) {
    const scopedSearch = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/sessions/search" && url.searchParams.get("archive") === archive && url.searchParams.get("taskId") === taskId && url.searchParams.get("q") === "a phrase";
    });
    await sessionScope.selectOption(archive);
    await scopedSearch;
    assert.equal(searches.at(-1).archive,archive,"native scope switch refreshes the same Task/body search");
    assert.equal(searches.at(-1).taskId,taskId);
    assert.equal(searches.at(-1).q,"a phrase");
    assert.equal(await dialog.count(),0,"switching session range does not require opening filters");
    assert.equal(page.url(),originalUrl);
  }
  assert.equal(await summary.evaluate(element => element.scrollHeight > 34),false,"conditions do not grow into stacked rows");
  await opener.click();
  assert.equal(await dialog.getByRole("searchbox",{name:"Search conversation content",exact:true}).inputValue(),"a phrase");
  const clearedTaskSearch = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/sessions/search" && !url.searchParams.has("taskId") && url.searchParams.get("archive") === "archived";
  });
  await dialog.getByRole("button",{name:"Clear task filter",exact:true}).click();
  await clearedTaskSearch;
  assert.equal(searches.at(-1).taskId,undefined,"clearing one condition keeps content and archive search");
  assert.equal(searches.at(-1).archive,"archived");
  await page.locator('#session-sidebar').getByText("Pi Web",{exact:true}).click();
  assert.equal(await dialog.count(),0,"outside click dismisses the desktop panel");
  await summary.getByRole("button",{name:"Clear search and filters",exact:true}).click();
  assert.equal(await summary.count(),0);
  assert.equal(await sessionScope.inputValue(),"archived","clearing search/Task never switches back to daily sessions");
  await page.locator('[data-sidebar-row="session:unified-2"]').waitFor();
  assert.equal(await opener.locator('[aria-label$="active conditions"]').count(),0,"archive-only view has no filter badge");
  await opener.click();
  assert.equal(await dialog.getByRole("button",{name:"Clear search and filters",exact:true}).isDisabled(),true,"archive alone does not enable filter reset");
  await dialog.getByRole("button",{name:"Close filters",exact:true}).click();
  await sessionScope.selectOption("active");
  await page.locator('[data-sidebar-row="session:unified-1"]').waitFor();
  await opener.click();
  await dialog.getByRole("button",{name:"Task",exact:true}).click();
  await dialog.getByRole("searchbox",{name:"Search tasks",exact:true}).fill("Durable acceptance");
  await dialog.locator(`[data-task-option="${taskId}"]`).waitFor();
  await dialog.getByRole("searchbox",{name:"Search tasks",exact:true}).evaluate(input => input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",keyCode:229,bubbles:true})));
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("role")),null,"IME arrows remain in the task search field");
  await dialog.getByRole("searchbox",{name:"Search tasks",exact:true}).press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("role")),"option","ArrowDown enters task choices");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.taskOption),taskId);
  await page.keyboard.press("Enter");
  await dialog.getByRole("button",{name:"Task",exact:true}).click();
  await dialog.getByRole("button",{name:"Back to filters",exact:true}).click();
  const query = dialog.getByRole("searchbox",{name:"Search conversation content",exact:true});
  await query.fill("保留关键词");
  await query.evaluate(input => input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:229,isComposing:true,bubbles:true})));
  assert.equal(await dialog.count(),1,"IME Escape cannot close the panel or stop a session");
  await dialog.getByRole("button",{name:"Clear search and filters",exact:true}).click();
  await dialog.getByRole("button",{name:"Close filters",exact:true}).click();
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
  console.log("PASS: unified desktop entry, list task lookup, on-demand conditions, live combined search, close/outside/IME/reset, summary and unchanged navigation");
  const focusFailures = [];
  const focusCase = async (name, setup, check) => {
    const target = await context.newPage();
    target.on("pageerror",error => errors.push(error.message));
    try {
      await setup(target);
      await target.goto(`${base}/?cwd=${encodeURIComponent(project.cwd)}`,{waitUntil:"networkidle"});
      if(target.viewportSize().width <= 640) await openMobileDrawer(target);
      await target.getByRole("button",{name:"Search and filters",exact:true}).click();
      await check(target,target.getByRole("dialog",{name:"Search and filters",exact:true}));
      console.log(`PASS: ${name}`);
    } catch(error) {focusFailures.push(`${name}: ${error.message}`);console.error(`FAIL: ${name}: ${error.message}`);}
    finally {await target.close();}
  };
  await focusCase("popup reset keeps archived session scope",async () => {},async (target,popover) => {
    await popover.getByRole("button",{name:"Close filters",exact:true}).click();
    const scope = target.getByRole("combobox",{name:"Session list",exact:true});
    await scope.selectOption("archived");
    await target.getByRole("button",{name:"Search and filters",exact:true}).click();
    await popover.getByRole("button",{name:"Task",exact:true}).click();
    await popover.locator(`[data-task-option="${taskId}"]`).click();
    await popover.getByRole("searchbox").fill("reset content");
    await popover.getByRole("button",{name:"Clear search and filters",exact:true}).click();
    assert.equal(await scope.inputValue(),"archived","popup reset does not change the separate session range");
    assert.equal(await popover.getByRole("searchbox").inputValue(),"");
    assert.equal(await popover.getByRole("button",{name:"Clear search and filters",exact:true}).isDisabled(),true);
    assert.equal(await target.locator('[data-sidebar-filter-summary]').count(),0);
  });
  await focusCase("desktop reset preserves Tab containment",async () => {},async (target,popover) => {
    await popover.getByRole("searchbox").fill("reset content");
    await popover.getByRole("button",{name:"Clear search and filters",exact:true}).click();
    await target.keyboard.press("Tab");
    assert.equal(await popover.evaluate(element => element.contains(document.activeElement)),true,"Tab stays inside after the focused reset control disables itself");
  });
  await focusCase("desktop panel yields focus to composer",async () => {},async (target,popover) => {
    await popover.getByRole("searchbox").fill("kept content");
    await target.keyboard.press("Alt+ArrowRight");
    await target.waitForFunction(() => document.activeElement?.tagName==="TEXTAREA");
    assert.equal(await popover.count(),0,"a nonmodal popover closes when keyboard focus leaves it");
    await target.locator('[data-sidebar-filter-summary]').waitFor();
    const composer = target.locator('textarea').first();
    await composer.fill("/task");
    await composer.press("Enter");
    const picker = target.locator('[role="dialog"][aria-modal="true"]');
    await picker.waitFor();
    await target.keyboard.press("Escape");
    await picker.waitFor({state:"detached"});
    await target.locator('[data-sidebar-filter-summary]').waitFor();
  });
  await focusCase("higher Settings modal owns Escape",async () => {},async (target,popover) => {
    await popover.getByRole("searchbox").fill("kept content");
    // Keyboard/programmatic entry does not generate an outside pointerdown.
    await target.getByRole("button",{name:"Settings",exact:true}).evaluate(button => button.click());
    await target.locator('[role="dialog"][aria-modal="true"]').waitFor();
    assert.equal(await popover.count(),0,"lower popover yields to the higher modal");
    await target.keyboard.press("Escape");
    await target.waitForFunction(() => !document.querySelector('[role="dialog"][aria-modal="true"]'));
    await target.locator('[data-sidebar-filter-summary]').waitFor();
  });
  await focusCase("same-title Tasks expose project/archive descriptions",async target => {
    await target.addInitScript(() => localStorage.setItem("pi-web:sidebar-view",JSON.stringify({mode:"all",collapsedProjects:[]})));
  },async (target,popover) => {
    await popover.getByRole("button",{name:"Task",exact:true}).click();
    for(const [id,path,archived] of [[taskId,project.projectRoot,false],[otherTaskId,otherProject.projectRoot,true]]) {
      const option = popover.locator(`[data-task-option="${id}"]`);
      const description = await option.evaluate(element => (element.getAttribute("aria-describedby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" "));
      assert.ok(description.includes(path),"screen readers receive the disambiguating project path");
      if(archived) {
        assert.match(description,/Archived/);
        const marker = option.locator('[data-task-archived]');
        assert.equal(await marker.isVisible(),true,"long paths cannot clip the archived marker");
        assert.equal(await option.locator('[title]').getAttribute("title"),path,"full project path remains available");
        const markerBounds = await marker.boundingBox(), optionBounds = await option.boundingBox();
        assert.ok(markerBounds.x + markerBounds.width <= optionBounds.x + optionBounds.width,"archived marker fits within its option");
      }
    }
  });
  await focusCase("breakpoint dismissal restores a visible target",async () => {},async (target,popover) => {
    await popover.getByRole("searchbox").fill("kept content");
    await target.setViewportSize({width:390,height:844});
    await target.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Search and filters"]'),null,{timeout:2000});
    assert.equal(await target.evaluate(() => document.activeElement.getAttribute("aria-label")),"Show sidebar");
    await target.getByRole("button",{name:"Show sidebar",exact:true}).click();
    await target.waitForFunction(() => Math.abs(document.getElementById("session-sidebar").getBoundingClientRect().left)<1);
    await target.getByRole("button",{name:"Search and filters",exact:true}).click();
    assert.equal(await popover.getByRole("searchbox").inputValue(),"kept content","responsive dismissal preserves conditions");
  });
  await focusCase("mobile sheet bridges explicit panel shortcuts",async target => {
    await target.setViewportSize({width:390,height:844});
  },async (target,sheet) => {
    const content = sheet.getByRole("searchbox");
    await content.fill("reveal content");
    const imeHandled = await content.evaluate(input => !input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",altKey:true,keyCode:229,bubbles:true,cancelable:true})));
    assert.equal(imeHandled,false,"IME 229 remains with input rather than panel navigation");
    assert.equal(await sheet.count(),1);
    const handled = await content.evaluate(input => !input.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",altKey:true,bubbles:true,cancelable:true})));
    assert.equal(handled,true,"owned mobile sheet prevents browser Back for explicit Alt+Left");
    await target.waitForFunction(() => document.activeElement?.hasAttribute("data-sidebar-row"));
    assert.equal(await sheet.count(),0);
    assert.equal(await target.locator('[data-sidebar-filter-summary]').count(),0,"explicit reveal still clears body search");
    await target.getByRole("button",{name:"Search and filters",exact:true}).click();
    await sheet.getByRole("searchbox").fill("kept content");
    await target.keyboard.press("Alt+ArrowRight");
    await target.waitForFunction(() => document.activeElement?.tagName==="TEXTAREA");
    assert.equal(await sheet.count(),0);
    assert.equal(await target.getByRole("button",{name:"Show sidebar",exact:true}).isVisible(),true);
    assert.equal(new URL(target.url()).searchParams.get("cwd"),project.cwd,"shortcuts do not navigate history");
  });
  const desktopZh = await context.newPage();
  desktopZh.on("pageerror",error => errors.push(error.message));
  await desktopZh.addInitScript(() => localStorage.setItem("pi-locale","zh-CN"));
  await desktopZh.goto(`${base}/?cwd=${encodeURIComponent(project.cwd)}`,{waitUntil:"networkidle"});
  await desktopZh.addStyleTag({content:"nextjs-portal { display:none !important; }"});
  await desktopZh.screenshot({path:join(evidence,"zh-CN-desktop-default.png"),fullPage:true});
  await desktopZh.getByRole("button",{name:"搜索与筛选",exact:true}).click();
  const previewPanel = desktopZh.getByRole("dialog",{name:"搜索与筛选",exact:true});
  await previewPanel.getByRole("button",{name:"任务",exact:true}).click();
  await previewPanel.locator(`[data-task-option="${taskId}"]`).click();
  await desktopZh.screenshot({path:join(evidence,"zh-CN-desktop-panel.png"),fullPage:true});
  await previewPanel.getByRole("button",{name:"关闭筛选面板",exact:true}).click();
  await desktopZh.screenshot({path:join(evidence,"zh-CN-desktop-filtered.png"),fullPage:true});
  await desktopZh.locator('#session-sidebar select').selectOption("archived");
  await desktopZh.locator('[data-sidebar-filter-summary]').getByRole("button",{name:"清除搜索与筛选",exact:true}).click();
  await desktopZh.locator('[data-sidebar-row="session:unified-2"]').waitFor();
  await desktopZh.screenshot({path:join(evidence,"zh-CN-desktop-archived.png"),fullPage:true});
  await desktopZh.close();
  for(const localeId of ["en","zh-CN","zh-TW"]) {
    const locale = Object.values(await jiti.import(`../lib/i18n/messages/${localeId}.ts`))[0];
    const m = key => locale.messages[key];
    const mobile = await context.newPage();
    mobile.on("pageerror",error => errors.push(error.message));
    await mobile.setViewportSize({width:390,height:844});
    await mobile.addInitScript(id => localStorage.setItem("pi-locale",id),localeId);
    await mobile.goto(`${base}/?cwd=${encodeURIComponent(project.cwd)}`,{waitUntil:"networkidle"});
    await mobile.addStyleTag({content:"nextjs-portal { display:none !important; }"});
    await openMobileDrawer(mobile);
    const scopeM = mobile.getByRole("combobox",{name:m("sidebar.sessionListScope"),exact:true});
    assert.equal(await scopeM.inputValue(),"active");
    await scopeM.selectOption("archived");
    await mobile.locator('[data-sidebar-row="session:unified-2"]').waitFor();
    assert.equal(await mobile.locator('[data-sidebar-filter-summary]').count(),0,"archive-only mobile range has no search summary");
    const triggerM = mobile.getByRole("button",{name:m("sidebar.searchFilters"),exact:true});
    await triggerM.click();
    const panelM = mobile.getByRole("dialog",{name:m("sidebar.searchFilters"),exact:true});
    assert.equal(await panelM.getAttribute("aria-modal"),"true");
    const bounds = await panelM.boundingBox();
    assert.equal(Math.round(bounds.x),0);assert.equal(Math.round(bounds.width),390);assert.equal(Math.round(bounds.y+bounds.height),844,"mobile is a bottom sheet");
    await mobile.getByRole("button",{name:m("common.settings"),exact:true}).evaluate(button => button.focus());
    assert.equal(await panelM.evaluate(element => element.contains(document.activeElement)),true,"mobile modal owns focus");
    await panelM.getByRole("button",{name:m("sidebar.conditionTask"),exact:true}).click();
    await panelM.getByRole("searchbox",{name:m("sidebar.taskSearch"),exact:true}).fill("Database indexing");
    await panelM.locator(`[data-task-option="${taskId}"]`).click();
    await panelM.getByRole("searchbox",{name:m("sidebar.contentSearch"),exact:true}).fill("a phrase");
    await mobile.getByText("Matching excerpt",{exact:true}).waitFor();
    await mobile.screenshot({path:join(evidence,`${localeId}-mobile-light.png`),fullPage:true});
    await mobile.evaluate(() => {document.documentElement.dataset.theme="dark";document.documentElement.classList.add("dark");});
    await mobile.screenshot({path:join(evidence,`${localeId}-mobile-dark.png`),fullPage:true});
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth>innerWidth),false);
    await panelM.getByRole("button",{name:m("sidebar.clearSearchFilters"),exact:true}).focus();
    await mobile.keyboard.press("Tab");
    assert.equal(await mobile.evaluate(() => document.activeElement.getAttribute("aria-label")),m("sidebar.closeFilters"),"Tab wraps inside modal");
    await panelM.getByRole("searchbox",{name:m("sidebar.contentSearch"),exact:true}).focus();
    await mobile.evaluate(() => {Object.defineProperty(visualViewport,"height",{value:460,configurable:true});visualViewport.dispatchEvent(new Event("resize"));});
    await mobile.waitForFunction(() => document.documentElement.dataset.keyboardOpen==="true");
    const keyboardBounds = await panelM.boundingBox();
    assert.ok(keyboardBounds.y+keyboardBounds.height<=461,"sheet stays above the software keyboard viewport");
    await mobile.evaluate(() => {delete visualViewport.height;visualViewport.dispatchEvent(new Event("resize"));});
    await panelM.getByRole("button",{name:m("sidebar.closeFilters"),exact:true}).click();
    await mobile.locator('[data-sidebar-filter-summary]').waitFor();
    assert.equal(await panelM.count(),0);
    await mobile.locator('[data-sidebar-filter-summary]').getByRole("button",{name:m("sidebar.clearSearchFilters"),exact:true}).click();
    assert.equal(await scopeM.inputValue(),"archived","mobile reset also preserves the independent session range");
    assert.equal(await mobile.locator('[data-sidebar-filter-summary]').count(),0);
    await scopeM.selectOption("active");
    await mobile.locator('[data-sidebar-row="session:unified-1"]').waitFor();
    await mobile.close();
  }
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
  console.log(`PASS: 390px bottom sheet in 3 languages, modal focus/Tab, viewport keyboard sizing and themes; screenshots ${evidence}`);
  assert.deepEqual(focusFailures,[],"review focus/accessibility regressions");
} finally {await browser.close();}
