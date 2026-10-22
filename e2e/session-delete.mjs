// PI_WEB_TEST_URL=http://127.0.0.1:30142 node e2e/session-delete.mjs
// Every API request is intercepted. No real session data, DELETE, or model calls.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.PI_WEB_TEST_URL || "http://127.0.0.1:30142";
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const cwd = "E:/delete-fixture";
const makeSession = (id, relation) => ({
  id, path: `${cwd}/${id}.jsonl`, cwd, projectRoot: cwd, projectKey: cwd.toLowerCase(),
  name: `Delete fixture ${id}`, firstMessage: id, messageCount: 1,
  created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", ...(relation ? { relation } : {}),
});
const fixture = [makeSession("root"), makeSession("child", { kind: "subagent", parentSessionId: "root" }), makeSession("other")];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await wait(10);
  }
}

async function setup(selected = "root") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  const page = await context.newPage();
  const state = { sessions: [...fixture], version: 1, deletes: [], lists: 0, listUrls: [], holdLists: false, heldLists: [], holdPolls: false, heldPolls: [] };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (request.method() === "DELETE") {
      assert.equal(url.pathname, "/api/sessions/root", "only the synthetic root can be deleted");
      state.deletes.push(route);
      return;
    }
    if (url.pathname === "/api/sessions") {
      state.lists++;
      state.listUrls.push(url.pathname + url.search);
      const body = { sessions: [...state.sessions], sessionListVersion: state.version };
      if (state.holdLists) { state.heldLists.push({ route, body }); return; }
      return json(body);
    }
    if (url.pathname === "/api/agent/running") {
      const body = { runningSessionIds: [], sessionListVersion: state.version };
      if (state.holdPolls) { state.heldPolls.push({ route, body }); return; }
      return json(body);
    }
    if (url.pathname === "/api/tasks/catalog") return json({ tasks: [] });
    if (url.pathname.startsWith("/api/sessions/")) {
      const info = fixture.find(s => s.id === url.pathname.split("/")[3]);
      return json({ info, leafId: null, tree: [], context: { messages: [], entryIds: [] } });
    }
    if (url.pathname.startsWith("/api/agent/")) return json({ error: "Not running" }, 404);
    if (url.pathname === "/api/worktrees") return json({ forCwd: cwd, projectRoot: cwd, projectKey: cwd.toLowerCase(), isGit: false, isTopLevel: true, worktrees: [] });
    if (url.pathname === "/api/project-trust") return json({ trusted: true, requiresTrust: false });
    if (url.pathname === "/api/files") return json({ entries: [] });
    if (url.pathname === "/api/cwd/validate" || url.pathname === "/api/default-cwd") return json({ cwd, projectRoot: cwd, projectKey: cwd.toLowerCase() });
    return json({});
  });
  await page.goto(`${base}/?session=${selected}`);
  await page.locator('[data-sidebar-row="session:root"]').waitFor();
  await page.locator("textarea.chat-input-textarea").waitFor({ state: "visible" });
  await wait(1200); // Let the initial scheduled detail hydration finish.
  return { page, state, context };
}
const row = page => page.locator('[data-sidebar-row="session:root"]');
async function confirm(page, state, entry = "keyboard") {
  if (entry === "inline" || entry === "shift-click") {
    await row(page).hover();
    await row(page).getByTitle("Delete (Shift+click to delete without confirmation)").click({ modifiers: entry === "shift-click" ? ["Shift"] : [] });
  } else {
    await row(page).focus();
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => document.activeElement?.textContent === "Cancel");
  }
  if (entry !== "shift-click") {
    assert.equal(state.deletes.length, 0, "opening confirmation never sends DELETE");
    await row(page).getByRole("button", { name: "Delete", exact: true }).click();
  } else {
    assert.equal(await row(page).getByRole("button", { name: "Cancel", exact: true }).count(), 0, "only Shift+click bypasses confirmation");
  }
  await page.waitForFunction(() => document.querySelector('[data-sidebar-row="session:root"]')?.style.opacity === "0.5");
  await waitUntil(() => state.deletes.length > 0, "DELETE request");
}
async function succeed(state) {
  state.sessions = state.sessions.filter(s => !["root", "child"].includes(s.id));
  state.version++;
  await state.deletes[0].fulfill({ json: { ok: true, deletedSessionIds: ["root", "child"], sessionListVersion: state.version } });
}
try {
  // A pre-delete GET arriving after success cannot resurrect the removed row;
  // neither a 3-second refresh nor a version poll may postpone local removal.
  {
    const { page, state, context } = await setup("other");
    await row(page).focus();
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => document.activeElement?.textContent === "Cancel");
    await page.keyboard.press("Escape");
    assert.equal(state.deletes.length, 0);
    assert.equal(await row(page).evaluate(el => el === document.activeElement), true, "Escape restores row focus");
    state.holdLists = true;
    state.version++;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => state.heldLists.length > 0, "pre-delete list request");
    await confirm(page, state);
    const before = state.lists;
    await succeed(state);
    await row(page).waitFor({ state: "detached", timeout: 1500 });
    assert.match(page.url(), /session=other/);
    const stale = state.heldLists.shift();
    await stale.route.fulfill({ json: stale.body });
    await wait(3000);
    assert.equal(await row(page).count(), 0, "late pre-delete response cannot resurrect root");
    assert.equal(state.lists, before + 1, `one reconciliation, even across polling: ${state.listUrls.join(", ")}`);
    state.holdLists = false;
    for (const pending of state.heldLists) await pending.route.fulfill({ json: pending.body });
    await context.close();
  }
  // A poll started before deletion must not schedule another refresh even
  // when it completes after the authoritative reconciliation has finished.
  {
    const { page, state, context } = await setup("other");
    state.holdPolls = true;
    state.version++;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitUntil(() => state.heldPolls.length > 0, "pre-delete version poll");
    await confirm(page, state, "inline");
    const before = state.lists;
    await succeed(state);
    await row(page).waitFor({ state: "detached" });
    await waitUntil(() => state.lists === before + 1, "authoritative reconciliation");
    await wait(200);
    state.holdPolls = false;
    for (const pending of state.heldPolls) await pending.route.fulfill({ json: pending.body });
    await wait(3000);
    assert.equal(state.lists, before + 1, "late pre-delete poll cannot trigger a duplicate refresh");
    assert.equal(await row(page).count(), 0);
    await context.close();
  }
  for (const failure of ["http500", "invalid2xx", "network", "partial"]) {
    const { page, state, context } = await setup();
    await confirm(page, state, failure === "http500" ? "inline" : failure === "network" ? "shift-click" : "keyboard");
    const before = state.lists;
    if (failure === "network") await state.deletes[0].abort("failed");
    else if (failure === "invalid2xx") await state.deletes[0].fulfill({ json: { ok: true } });
    else {
      if (failure === "partial") {
        state.sessions = state.sessions.filter(s => s.id !== "child");
        state.version++;
      }
      await state.deletes[0].fulfill({ status: 500, json: { error: "fixture failure", ...(failure === "partial" ? { deletedSessionIds: ["child"], sessionListVersion: state.version } : {}) } });
    }
    await page.getByRole("alert").filter({ hasText: "could not be confirmed" }).waitFor();
    assert.match(page.url(), /session=root/, `${failure} must not navigate`);
    assert.equal(await row(page).count(), 1);
    await page.waitForFunction(() => document.querySelector('[data-sidebar-row="session:root"]')?.style.opacity === "1");
    if (failure === "partial") await waitUntil(() => state.lists === before + 1, "partial-failure reconciliation");
    await wait(2700);
    assert.equal(state.lists, before + (failure === "partial" ? 1 : 0), `${failure}: no duplicate refresh on the next version poll`);
    await page.getByRole("button", { name: "Retry deletion", exact: true }).click();
    await waitUntil(() => state.deletes.length === 2, "explicit retry request");
    await state.deletes[1].fulfill({ status: 500, json: { error: "retry failed" } });
    await context.close();
  }
  {
    const { page, state, context } = await setup();
    await confirm(page, state);
    await page.locator('[data-sidebar-row="session:other"]').click();
    await page.waitForURL(/session=other/);
    await succeed(state);
    await row(page).waitFor({ state: "detached" });
    assert.match(page.url(), /session=other/, "late deletion keeps the newer selection");
    await context.close();
  }
  {
    const { page, state, context } = await setup("child");
    await confirm(page, state, "inline");
    await succeed(state);
    await page.waitForURL(/\?cwd=/);
    await row(page).waitFor({ state: "detached" });
    await context.close();
  }
  console.log("PASS: immediate removal, stale-list fence, single refresh/poll, 500/invalid2xx/network/partial failure and retry, inline/Shift-click/keyboard deletion, navigation-away fence, selected cascade child");
} finally {
  await browser.close();
}
