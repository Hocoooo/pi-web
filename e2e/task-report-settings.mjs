// Actual SettingsPanel, real settings HTTP handlers + SDK catalogue, temporary global files.
// Only browser transport is bridged; no Next server, user config or paid provider is used.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { reportSettingsFixture } from "../lib/task-report-settings.fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { GET, PUT } = await jiti.import("../app/api/task-reports/settings/route.ts");
const locales = [];
for (const locale of ["en", "zh-CN", "zh-TW"]) {
  const localeModule = await jiti.import(`../lib/i18n/messages/${locale}.ts`);
  locales.push(Object.values(localeModule)[0]);
}
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";
    import {createRoot} from "react-dom/client";
    import {SettingsPanel} from "./components/SettingsPanel";
    import {I18nProvider} from "./hooks/useI18n";
    createRoot(document.getElementById("root")).render(<I18nProvider><SettingsPanel cwd={null} sessionId={null}
      initialSection="general" onClose={()=>{}} onSessionReloaded={()=>{}} quoteSelectionEnabled={false} onQuoteSelectionChange={()=>{}} /></I18nProvider>);
  ` },
});
const css = await readFile(join(root, "app/settings.css"), "utf8");
const evidence = await mkdtemp(join(tmpdir(), "pi-web-report-settings-evidence-"));
const previous = process.env.PI_CODING_AGENT_DIR;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  for (const locale of locales) {
    for (const width of [1100, 390]) {
      const f = await reportSettingsFixture();
      process.env.PI_CODING_AGENT_DIR = f.agentDir;
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const errors = [], unexpected = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let saves = 0;
      const m = (key) => locale.messages[`reports.settings.${key}`];
      await page.addInitScript((id) => localStorage.setItem("pi-locale", id), locale.id);
      await page.route("**/*", async (route) => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
        if (path === "/api/task-reports/settings") {
          if (request.method() === "PUT") saves++;
          const response = request.method() === "PUT" ? await PUT(new Request(request.url(), { method: "PUT", body: request.postData() })) : await GET();
          return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
        }
        if (path === "/api/tools/settings") return route.fulfill({ json: { isWindows: false, powerShellEnabled: false } });
        if (path === "/api/web-auth") return route.fulfill({ json: { enabled: false } });
        unexpected.push(`${request.method()} ${path}`);
        return route.abort();
      });
      try {
        const mount = async () => {
          await page.goto("http://report-settings.test/");
          await page.addStyleTag({ content: `*{box-sizing:border-box}body{margin:0;font-family:Arial}:root{--bg:#fff;--bg-panel:#f5f5f5;--border:#ddd;--text:#222;--text-dim:#666;--text-muted:#555;--accent:#245bce}${css}` });
          await page.addScriptTag({ content: outputFiles[0].text });
          await page.getByRole("region", { name: m("title") }).getByRole("button", { name: m("model"), exact: true }).waitFor();
          await page.waitForFunction(() => document.documentElement.lang === localStorage.getItem("pi-locale"));
        };
        await mount();
        const section = page.getByRole("region", { name: m("title") });
        const trigger = section.getByRole("button", { name: m("model"), exact: true });
        await section.getByRole("status").filter({ hasText: m("unconfigured") }).waitFor();
        await trigger.click();
        await section.getByRole("option").filter({ hasText: "Reasoning report" }).click();
        assert.equal(saves, 0, "model browsing must not save");
        await section.getByRole("option", { name: "high", exact: true }).click();
        await section.getByRole("status").filter({ hasText: "report-reasoning/same-id · high" }).waitFor();
        assert.equal(saves, 1);
        assert.deepEqual((await f.read()).taskArchiveReport, f.selection);
        assert.deepEqual(await f.read(), { ...f.initial, taskArchiveReport: f.selection });
        await section.getByRole("button", { name: m("reload"), exact: true }).click();
        await section.getByRole("status").filter({ hasText: "report-reasoning/same-id · high" }).waitFor();
        // A full page reload, not a component's remembered browser preference.
        await mount();
        await section.getByRole("status").filter({ hasText: "report-reasoning/same-id · high" }).waitFor();
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(evidence, `${locale.id}-${width}-saved.png`) });

        await trigger.click();
        await section.getByRole("option").filter({ hasText: "Plain report" }).click();
        assert.equal(await section.getByRole("option").count(), 1, "non-reasoning model offers only off");
        const before = await readFile(f.settingsPath, "utf8");
        await writeFile(f.settingsPath, "{ broken");
        await section.getByRole("option", { name: "off", exact: true }).click();
        await section.getByRole("alert").filter({ hasText: m("error.storage-unavailable") }).first().waitFor();
        assert.equal(await section.getByRole("listbox").count(), 1, "save error keeps target and level open");
        assert.equal(await section.getByRole("option", { name: "off", exact: true }).count(), 1);
        assert.match(await section.getByRole("status").innerText(), /report-reasoning\/same-id · high/);
        await page.screenshot({ path: join(evidence, `${locale.id}-${width}-save-error.png`) });
        await writeFile(f.settingsPath, before);
        await section.getByRole("option", { name: "off", exact: true }).click();
        await section.getByRole("status").filter({ hasText: "report-plain/same-id · off" }).waitFor();
        await section.getByRole("listbox").waitFor({ state: "detached" });
        assert.deepEqual((await f.read()).taskArchiveReport, { provider: "report-plain", modelId: "same-id", thinkingLevel: "off" });

        const modelsPath = join(f.agentDir, "models.json"), models = await readFile(modelsPath, "utf8");
        await writeFile(modelsPath, "{ broken");
        await section.getByRole("button", { name: m("reload"), exact: true }).click();
        await section.getByRole("alert").filter({ hasText: m("error.models-unavailable") }).waitFor();
        assert.match(await trigger.innerText(), /Plain report/, "load error preserves saved display");
        await writeFile(modelsPath, models);
        await section.getByRole("button", { name: m("reload"), exact: true }).click();
        await section.getByRole("alert").waitFor({ state: "detached" });

        const unavailable = { ...f.selection, provider: "missing-provider" };
        await writeFile(f.settingsPath, JSON.stringify({ ...f.initial, taskArchiveReport: unavailable }));
        await section.getByRole("button", { name: m("reload"), exact: true }).click();
        await section.getByRole("status").filter({ hasText: m("model-unavailable") }).waitFor();
        assert.deepEqual((await f.read()).taskArchiveReport, unavailable);
        await writeFile(f.settingsPath, JSON.stringify({ ...f.initial, taskArchiveReport: { ...f.selection, thinkingLevel: "auto" } }));
        await section.getByRole("button", { name: m("reload"), exact: true }).click();
        await section.getByRole("status").filter({ hasText: m("invalid-level") }).waitFor();
        await section.getByRole("button", { name: m("clear"), exact: true }).click();
        await section.getByRole("status").filter({ hasText: m("unconfigured") }).waitFor();
        assert.deepEqual(await f.read(), f.initial);

        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "no horizontal page overflow");
        const bounds = await section.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "report section fits viewport");
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, [], "no chat/model invocation or project endpoint");
        assert.equal(f.requests(), 0, "zero report provider requests");
        console.log(`PASS report settings ${locale.id} ${width}px: real SettingsPanel + HTTP/SDK, persistence, errors/retry, capabilities, no calls`);
      } finally { await page.close(); await f.close(); }
    }
  }
  console.log(`Evidence screenshots: ${evidence}`);
} finally {
  await browser.close();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
}
