import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { chromium } from "playwright";

// An independent source copy has its own .next lock and real isolated APIs.
// Never stop the user's dev service, use their agent-dir, or send a model prompt.
const root = await mkdtemp(join(tmpdir(), "pi-task-project-real-"));
const checkout = join(root, "checkout"), agentDir = join(root, "agent"), home = join(root, "home");
const known = join(root, "existing-project"), second = join(root, "second-project");
await Promise.all([checkout, agentDir, home, known, second].map(path => mkdir(path)));
for (const name of ["app", "components", "hooks", "lib", "public", "bin", "package.json", "package-lock.json", "next.config.ts", "next-env.d.ts", "tsconfig.json", "postcss.config.mjs", "proxy.ts", "node_modules"]) {
  await cp(resolve(name), join(checkout, name), { recursive: true, mode: constants.COPYFILE_FICLONE });
}
const sessionId = "project-ui-existing-session", timestamp = new Date().toISOString();
const sessions = join(agentDir, "sessions", "fixture"); await mkdir(sessions, { recursive: true });
const sessionFile = join(sessions, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
const nativeBytes = [
  { type: "session", version: 3, id: sessionId, cwd: known, timestamp },
  { type: "message", id: "root", parentId: null, timestamp, message: { role: "user", content: "Existing project conversation", timestamp: Date.now() } },
].map(value => JSON.stringify(value)).join("\n") + "\n";
await writeFile(sessionFile, nativeBytes);
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], enableSkillCommands: false }));
const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const log = createWriteStream(join(root, "server.log"));
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: home, NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=8192" };
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|PASSWORD|SECRET/.test(key)) delete env[key];
const server = spawn(process.execPath, ["--require", "./bin/stdio-guard.js", "./node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.pipe(log); server.stderr.pipe(log);
let browser;
const errors = [], agentWrites = [], scenarios = [];
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`Isolated dev server exited: ${server.exitCode}`);
    try { if ((await fetch(base, { signal: AbortSignal.timeout(3000) })).ok) { ready = true; break; } } catch {}
    await delay(1000);
  }
  assert.ok(ready, "isolated dev server ready");
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-theme", "light"); });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/agent/") && request.method() === "POST") agentWrites.push(request.url()); });
  await page.goto(base);
  await page.getByRole("button", { name: "Task dashboard", exact: true }).click();
  const dashboard = page.getByRole("dialog", { name: "Task dashboard", exact: true });
  const api = async input => {
    const response = await context.request.post(`${base}/api/tasks`, { data: input });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const board = async () => (await context.request.get(`${base}/api/tasks`)).json();
  await dashboard.getByRole("button", { name: "New task", exact: true }).click();
  await dashboard.getByLabel("Title", { exact: true }).fill("Existing project task");
  await dashboard.getByRole("combobox", { name: "Project directory (optional)", exact: true }).selectOption(known);
  await page.screenshot({ path: join(root, "desktop-create.png"), fullPage: true });
  await dashboard.getByRole("button", { name: "Create task", exact: true }).click();
  await dashboard.getByRole("button", { name: "Existing project task", exact: true }).waitFor();
  const task = (await board()).tasks.find(task => task.title === "Existing project task");
  assert.equal(task.project.cwd, known);
  scenarios.push("existing Pi project selection and persisted task creation");

  await dashboard.getByRole("button", { name: "New task", exact: true }).click();
  await dashboard.getByLabel("Title", { exact: true }).fill("New directory task");
  await dashboard.getByRole("button", { name: "Choose project…", exact: true }).click();
  const directory = page.getByRole("dialog", { name: "Select directory", exact: true });
  await directory.waitFor();
  await page.screenshot({ path: join(root, "directory-picker.png"), fullPage: true });
  await directory.getByRole("button", { name: "New directory", exact: true }).click();
  await directory.getByRole("textbox", { name: "Directory name", exact: true }).fill("new-task-project");
  await directory.getByRole("button", { name: "Create", exact: true }).click();
  await directory.getByRole("button", { name: "Select this folder", exact: true }).click();
  await directory.waitFor({ state: "hidden" });
  const addedCwd = await dashboard.getByRole("combobox", { name: "Project directory (optional)", exact: true }).inputValue();
  assert.ok(addedCwd.endsWith("new-task-project"));
  assert.equal((await board()).tasks.length, 1, "creating a directory must not submit the outer task form");
  await dashboard.getByRole("button", { name: "Create task", exact: true }).click();
  await dashboard.getByRole("button", { name: "New directory task", exact: true }).waitFor();
  assert.equal((await board()).tasks.find(task => task.title === "New directory task").project.cwd, addedCwd);
  assert.ok((await api({ action: "projects" })).projects.some(project => project.cwd === addedCwd));
  scenarios.push("real directory creation, selection, persistence and task-only project reuse");

  await api({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: [sessionId] });
  await dashboard.getByRole("button", { name: "Refresh", exact: true }).click();
  await dashboard.getByRole("button", { name: "Existing project task", exact: true }).click();
  const inspector = dashboard.locator("[data-task-inspector]:visible");
  await inspector.getByRole("button", { name: "Change project", exact: true }).click();
  const project = inspector.getByRole("combobox", { name: "Project directory (optional)", exact: true });
  await project.selectOption(addedCwd);
  await inspector.getByRole("button", { name: "Save project", exact: true }).click();
  await inspector.getByText("1 chat will be unlinked. Chats will not be deleted or stopped.", { exact: true }).waitFor();
  await page.screenshot({ path: join(root, "desktop-confirm.png"), fullPage: true });
  await inspector.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await board()).tasks.find(t => t.id === task.id).project.cwd, known);
  await inspector.getByRole("button", { name: "Change project", exact: true }).click();
  await project.selectOption(addedCwd);
  await inspector.getByRole("button", { name: "Save project", exact: true }).click();
  await inspector.getByRole("button", { name: "Change project and unlink", exact: true }).click();
  await inspector.getByRole("button", { name: "Change project", exact: true }).waitFor();
  const changed = (await board()).tasks.find(t => t.id === task.id);
  assert.equal(changed.project.cwd, addedCwd); assert.deepEqual(changed.sessionIds, []);
  assert.equal((await api({ action: "session-task", sessionId })).task, null);
  assert.equal(await readFile(sessionFile, "utf8"), nativeBytes, "native session bytes unchanged");
  scenarios.push("cancel and confirm cross-project change with atomic unlink and native history preservation");

  await page.setViewportSize({ width: 390, height: 844 });
  await inspector.getByRole("button", { name: "Change project", exact: true }).click();
  await project.selectOption("");
  await page.screenshot({ path: join(root, "mobile-project.png"), fullPage: true });
  assert.ok(await inspector.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "mobile inspector does not overflow horizontally");
  await inspector.getByRole("button", { name: "Save project", exact: true }).click();
  await inspector.getByRole("button", { name: "Change project", exact: true }).waitFor();
  assert.equal((await board()).tasks.find(t => t.id === task.id).project, null);
  scenarios.push("390px mobile layout, no horizontal overflow, change to no project");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await inspector.getByRole("button", { name: "Change project", exact: true }).click();
  await page.screenshot({ path: join(root, "mobile-dark.png"), fullPage: true });
  await inspector.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.getByRole("button", { name: "Task dashboard", exact: true }).click();
  await dashboard.getByRole("button", { name: "Existing project task", exact: true }).click();
  await inspector.getByText("No project", { exact: true }).waitFor();
  scenarios.push("reload persistence");
  assert.deepEqual(agentWrites, [], "no Agent write requests");
  assert.deepEqual(errors, [], "no browser runtime errors");
  await writeFile(join(root, "result.json"), JSON.stringify({ status: "passed", scenarios, errors, agentWrites, base }, null, 2));
  console.log(`PASS real unmocked browser/API verification: ${scenarios.join("; ")}. Evidence: ${root}`);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(root, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(root, "result.json"), JSON.stringify({ status: "failed", error: String(error), scenarios, errors, agentWrites }, null, 2));
  console.error(`Real browser evidence: ${root}`); throw error;
} finally {
  await browser?.close(); server.kill("SIGTERM");
  await Promise.race([new Promise(resolve => server.once("exit", resolve)), delay(10000)]);
  if (server.exitCode === null) { server.kill("SIGKILL"); await delay(500); }
  log.end();
  await rm(checkout, { recursive: true, force: true });
}
