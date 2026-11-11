// Mounted SettingsPanel with fully intercepted transport: no Next server, Git remote or config writes.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url);
const locales = [];
for (const id of ["en", "zh-CN", "zh-TW"]) locales.push(Object.values(await jiti.import(`../lib/i18n/messages/${id}.ts`))[0]);
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "config-sync.js", platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { SettingsPanel } from "./components/SettingsPanel";
    import { I18nProvider } from "./hooks/useI18n";
    import { getLastSettingsSection } from "./lib/settings-navigation";
    createRoot(document.getElementById("root")).render(<I18nProvider><SettingsPanel cwd={null}
      sessionId={new URLSearchParams(location.search).has("session") ? "fixture-session" : null}
      initialSection={getLastSettingsSection(null)} onClose={()=>{}} onSessionReloaded={()=>{window.configReloads = (window.configReloads || 0) + 1}}
      quoteSelectionEnabled={false} onQuoteSelectionChange={()=>{}} /></I18nProvider>);
  ` },
});
const css = await readFile(join(root, "app/settings.css"), "utf8");
const evidence = await mkdtemp(join(tmpdir(), "pi-web-config-sync-ui-"));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
try {
  for (const locale of locales) for (const width of [1100, 390]) {
    const hasSession = width === 1100;
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.setDefaultTimeout(10_000);
    const errors = [], unexpected = [], requests = [], commands = [];
    let status = { repository: "", branch: "main", lastSync: null };
    let failLoad = true, failSave = true, failPush = true, failReload = true;
    const pullFailures = [
      { error: "Local configuration changed since the last sync.", code: "local-changes" },
      { error: "fixture installer failed", code: "install-failed", applied: true },
    ];
    let hold = { method: "GET", gate: deferred() };
    const firstLoad = hold.gate;
    const m = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), locale.messages[`configSync.${key}`]);
    const title = locale.messages["settings.configSync"];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((id) => {
      localStorage.setItem("pi-locale", id);
      if (!localStorage.getItem("pi-web:settings-navigation")) localStorage.setItem("pi-web:settings-navigation", JSON.stringify({ section: "config-sync" }));
    }, locale.id);
    await page.route("**/*", async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
      const json = (data, status = 200) => route.fulfill({ status, json: data });
      if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      if (path === "/api/config-sync") {
        const body = request.postDataJSON();
        requests.push({ method, body });
        if (hold?.method === method) { const gate = hold.gate; hold = null; await gate.promise; }
        if (method === "GET") {
          if (failLoad) { failLoad = false; return json({ error: "fixture status unavailable" }, 503); }
          return json(status);
        }
        if (method === "PUT") {
          assert.deepEqual(Object.keys(body).sort(), ["branch", "repository", "trusted"]);
          assert.equal(body.trusted, true);
          if (failSave) { failSave = false; return json({ error: "fixture save refused", code: "invalid-repository" }, 400); }
          status = { repository: body.repository, branch: body.branch, lastSync: null };
          return json(status);
        }
        assert.equal(method, "POST");
        assert.deepEqual(Object.keys(body), ["action"]);
        assert.ok(["push", "pull"].includes(body.action));
        if (body.action === "push" && failPush) { failPush = false; return json({ error: "fixture push failed" }, 502); }
        if (body.action === "pull" && pullFailures.length) return json(pullFailures.shift(), 409);
        status = { ...status, lastSync: { action: body.action, commit: "1234567890abcdef".repeat(4), at: "2026-10-20T10:30:00.000Z" } };
        return json({ ...status, changed: body.action === "pull", files: body.action === "pull" ? 3 : 0, packages: body.action === "pull" ? 2 : 0, reloadRequired: body.action === "pull" });
      }
      if (path === "/api/agent/fixture-session") {
        assert.ok(hasSession);
        commands.push(request.postDataJSON());
        if (failReload) { failReload = false; return json({ error: "fixture session busy" }, 409); }
        return json({ success: true, data: {} });
      }
      // Only visited General's harmless settings reads are allowed. No model/remote requests.
      if (path === "/api/web-auth") return json({ enabled: false });
      if (path === "/api/tools/settings") return json({ isWindows: false, powerShellEnabled: false });
      if (path === "/api/task-reports/settings") return json({ selection: null, availability: "unconfigured", models: [], thinkingLevels: {} });
      unexpected.push(`${method} ${request.url()}`);
      return route.abort();
    });
    try {
      const mount = async () => {
        await page.goto(`http://config-sync.test/${hasSession ? "?session=1" : ""}`);
        await page.addStyleTag({ content: `*{box-sizing:border-box}body{margin:0;font-family:Arial}:root{--bg:#fff;--bg-panel:#f5f5f5;--border:#ddd;--text:#222;--text-dim:#666;--text-muted:#555;--accent:#245bce;--font-mono:monospace}${css}\n${outputFiles.find(file => file.path.endsWith(".css")).text}` });
        await page.addScriptTag({ content: outputFiles.find(file => file.path.endsWith(".js")).text });
        await page.waitForFunction(() => document.documentElement.lang === localStorage.getItem("pi-locale"));
      };
      const panel = page.getByRole("region", { name: title, exact: true });
      const repo = panel.getByRole("textbox", { name: m("repository"), exact: true });
      const branch = panel.getByRole("textbox", { name: m("branch"), exact: true });
      const trust = panel.getByRole("checkbox", { name: m("trust"), exact: true });
      const button = (key) => panel.getByRole("button", { name: m(key), exact: true });
      const selectSection = async (label, value) => {
        if (width <= 640) await page.getByRole("combobox", { name: locale.messages["settings.title"], exact: true }).selectOption(value);
        else await page.getByRole("navigation", { name: locale.messages["settings.title"] }).getByRole("button", { name: label, exact: true }).click();
      };
      await mount();
      await panel.getByRole("status").filter({ hasText: m("loading") }).waitFor();
      assert.deepEqual(requests.map(item => item.method), ["GET"]);
      firstLoad.resolve();
      await panel.getByRole("alert").filter({ hasText: "fixture status unavailable" }).waitFor();
      await button("retry").click();
      await repo.waitFor();
      assert.equal(await branch.inputValue(), "main");
      assert.equal(await panel.getByText(title, { exact: true }).count(), 0, "selected tab needs no repeated panel title");
      assert.equal(await panel.locator('.config-scope-tag').count(), 0, "global-only scope needs no secondary tag");
      assert.doesNotMatch(await panel.innerText(), /\b(?:configSync|config|settings)\.[a-zA-Z]/, "no untranslated panel copy");
      assert.equal(await button("save").isDisabled(), true);
      assert.equal(await button("push").isDisabled(), true);
      assert.equal(await button("pull").isDisabled(), true);
      const options = await page.locator(".settings-mobile-section-picker option").evaluateAll(nodes => nodes.map(node => ({ value: node.value, disabled: node.disabled })));
      assert.deepEqual(options.slice(-2), [{ value: "mcp", disabled: false }, { value: "config-sync", disabled: false }]);
      assert.equal(await page.locator('.settings-section-tab svg.settings-section-icon').count(), 7);

      const repository = "git@example.test:team/pi-config.git";
      await repo.fill(repository);
      await branch.fill("desktop");
      await trust.check();
      await branch.fill("");
      assert.equal(await trust.isChecked(), false, "changing branch invalidates consent");
      await trust.check();
      // A visited section remains mounted: leaving and returning preserves the draft and consent.
      await selectSection(locale.messages["settings.general"], "general");
      await selectSection(title, "config-sync");
      assert.equal(await repo.inputValue(), repository);
      assert.equal(await trust.isChecked(), true);
      assert.equal(requests.length, 2, "navigation must not trigger background sync/status polling");
      await button("save").click();
      await panel.getByRole("alert").filter({ hasText: "fixture save refused" }).waitFor();
      assert.equal(await repo.inputValue(), repository);
      assert.equal(await branch.inputValue(), "");
      assert.equal(await trust.isChecked(), true);
      assert.equal(await button("push").isDisabled(), true);
      hold = { method: "PUT", gate: deferred() };
      const saving = hold.gate;
      await button("save").click();
      await panel.getByRole("status").filter({ hasText: m("saving") }).waitFor();
      for (const control of [repo, branch, trust, button("save"), button("push"), button("pull")]) assert.equal(await control.isDisabled(), true, "busy controls disabled");
      saving.resolve();
      await panel.getByRole("status").filter({ hasText: m("saved") }).waitFor();
      assert.equal(await branch.inputValue(), "main");
      assert.equal(await button("push").isDisabled(), false);
      assert.deepEqual(requests.filter(item => item.method === "PUT").map(item => item.body), Array(2).fill({ repository, branch: "main", trusted: true }));

      await branch.fill("other");
      assert.equal(await button("push").isDisabled(), true);
      assert.equal(await button("pull").isDisabled(), true);
      await branch.fill("main");
      await button("push").click();
      await panel.getByRole("alert").filter({ hasText: "fixture push failed" }).waitFor();
      assert.equal(await repo.inputValue(), repository);
      await button("push").click();
      await panel.getByRole("status").filter({ hasText: m("pushSuccess") }).waitFor();
      await panel.getByText(m("noChanges"), { exact: false }).waitFor();
      assert.equal(await panel.locator("time").getAttribute("datetime"), "2026-10-20T10:30:00.000Z");
      await panel.getByText(status.lastSync.commit.slice(0, 8), { exact: true }).waitFor();
      await button("pull").click();
      await panel.getByRole("alert").filter({ hasText: "Local configuration changed since the last sync." }).waitFor();
      assert.equal(await repo.inputValue(), repository);
      assert.equal(await branch.inputValue(), "main");
      assert.equal(await button("pull").isDisabled(), false, "conflicts allow explicit retry, never a force override");
      assert.deepEqual(commands, []);
      await button("pull").click();
      await panel.getByRole("alert").filter({ hasText: m("appliedWarning") }).waitFor();
      assert.deepEqual(commands, [], "an applied error must not auto-reload");
      hold = { method: "POST", gate: deferred() };
      const pulling = hold.gate;
      await button("pull").click();
      await panel.getByRole("status").filter({ hasText: m("pulling") }).waitFor();
      for (const control of [repo, branch, button("save"), button("push"), button("pull")]) assert.equal(await control.isDisabled(), true);
      assert.equal(await trust.count(), 0, "saved binding does not repeat initial risk consent");
      pulling.resolve();
      await panel.getByRole("status").filter({ hasText: m("pullSuccess") }).waitFor();
      await panel.getByRole("status").filter({ hasText: m("counts", { files: 3, packages: 2 }) }).waitFor();
      if (!hasSession) await panel.getByRole("status").filter({ hasText: m("reloadNeeded") }).waitFor();
      assert.deepEqual(commands, [], "successful Pull must not auto-reload");
      if (hasSession) {
        await button("reloadSession").click();
        await panel.getByRole("alert").filter({ hasText: "fixture session busy" }).waitFor();
        await button("reloadSession").click();
        await panel.getByRole("status").filter({ hasText: m("reloaded") }).waitFor();
        assert.deepEqual(commands, [{ type: "reload" }, { type: "reload" }]);
        assert.equal(await page.evaluate(() => window.configReloads), 1, "reload callback only on success");
      } else assert.equal(await button("reloadSession").count(), 0, "no reload action without a session");
      await page.screenshot({ path: join(evidence, `${locale.id}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const bounds = await repo.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "inputs fit mobile/desktop");

      const beforeRemount = requests.length;
      await mount();
      await repo.waitFor();
      assert.equal(await repo.inputValue(), repository);
      assert.equal(await trust.count(), 0, "saved binding does not repeat consent on remount");
      assert.equal(await button("pull").isDisabled(), false, "an already trusted saved binding can sync");
      assert.deepEqual(requests.slice(beforeRemount).map(item => item.method), ["GET"], "remount only reads local status");
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, [], "all API requests are intercepted; no remotes, project config or model calls");
      console.log(`PASS Config sync ${locale.id} ${width}px: global navigation, load/retry, trust, dirty/busy guards, save/sync failures, results, explicit reload`);
    } finally { firstLoad.resolve(); hold?.gate.resolve(); await page.close(); }
  }
  console.log(`Evidence screenshots: ${evidence}`);
} finally { await browser.close(); }
