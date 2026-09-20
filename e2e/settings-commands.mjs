// Browser component regression: no server, credentials, sessions or model requests.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { ChatInput } from "./components/ChatInput";
    import { I18nProvider } from "./hooks/useI18n";
    const models = [
      { provider: "p", id: "alpha", name: "Alpha" },
      { provider: "q", id: "beta", name: "Beta" },
    ];
    window.calls = [];
    function App() {
      const [model, setModel] = useState({ provider: "p", modelId: "alpha" });
      const [thinking, setThinking] = useState("low");
      const [busy, setBusy] = useState(false);
      window.setBusy = setBusy;
      return <I18nProvider><ChatInput
        onAbort={() => {}} isStreaming={busy}
        onSend={(message) => window.calls.push(["prompt", message])}
        onSteer={(message) => window.calls.push(["steer", message])}
        onFollowUp={(message) => window.calls.push(["followup", message])}
        onPromptWithStreamingBehavior={(message) => window.calls.push(["queue", message])}
        model={model} modelList={models} thinkingLevel={thinking}
        availableThinkingLevels={["off", "low", "high"]}
        modelThinkingLevels={{ "p:alpha": ["off", "low", "high"], "q:beta": ["off", "low", "high"] }}
        onModelChange={(provider, modelId) => { window.calls.push(["model", provider, modelId]); setModel({provider, modelId}); }}
        onModelThinkingChange={async (provider, modelId, level) => {
          window.calls.push(["confirm", provider, modelId, level]);
          setModel({provider, modelId});
          setThinking(level);
          return {};
        }}
        onThinkingLevelChange={(level) => { window.calls.push(["thinking", level]); setThinking(level); }}
        onBuiltinCommand={async (text) => {
          window.calls.push(["command", text]);
          if (busy) return {handled: true, error: "busy"};
          const [name, ...parts] = text.split(/\\s+/);
          const query = parts.join(" ");
          if (name === "/model") {
            return {handled: true, action: "openModelSelector", query};
          }
          if (name === "/thinking") return {handled: true, action: "openThinkingSelector"};
          return {handled: false};
        }}
      /></I18nProvider>;
    }
    createRoot(document.getElementById("root")).render(<App/>);
  ` },
});
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  for (const viewport of [{ width: 1100, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, locale: "en-US" });
    await page.route("http://settings.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<html><body><div id="root" style="padding-top:400px"></div></body></html>' }));
    await page.goto("http://settings.test/");
    await page.addScriptTag({ content: outputFiles[0].text });
    const input = page.locator("textarea");
    const submit = () => viewport.width < 600 ? page.getByRole("button", { name: "Send", exact: true }).click() : input.press("Enter");
    const highlightedText = () => page.evaluate(() => {
      const focused = document.activeElement;
      const active = focused.getAttribute("aria-activedescendant");
      return active ? document.getElementById(active).textContent : focused.textContent;
    });
    {
      await input.fill("/model");
      await submit();
      await page.waitForFunction(() => document.querySelector("textarea").value === "");
      await page.getByRole("listbox", { name: /choose model/i }).waitFor();
      const modelFocus = await page.evaluate(() => document.activeElement?.tagName);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.getByRole("listbox", { name: /thinking|reasoning/i }).waitFor();
      await page.keyboard.press("Enter");
      await page.getByRole("listbox").waitFor({ state: "detached" });
      const confirmed = (await page.evaluate(() => window.calls)).some(([kind, , model]) => kind === "confirm" && model === "beta");
      console.log("/model", "focus:", modelFocus, "ArrowDown + Enter selected:", confirmed);
      assert.equal(confirmed, true);
      await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));

      await input.fill("/model");
      await submit();
      await page.getByRole("listbox", { name: /choose model/i }).waitFor();
      await page.keyboard.press("Control+Home");
      const first = await page.getByRole("option").first().textContent();
      assert.equal(await highlightedText(), first);
      await page.keyboard.press("ArrowUp");
      const lastLabel = await page.getByRole("option").last().textContent();
      assert.equal(await highlightedText(), lastLabel, "ArrowUp wraps to the last option");
      await page.keyboard.press("Control+End");
      assert.equal(await highlightedText(), lastLabel);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));
      assert.equal(await page.getByRole("listbox").count(), 0);

      await input.fill("/thinking");
      await submit();
      await page.getByRole("listbox", { name: /change reasoning level/i }).waitFor();
      const thinkingFocus = await page.evaluate(() => document.activeElement?.tagName);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      const thinkingSelected = (await page.evaluate(() => window.calls)).some(([kind, level]) => kind === "thinking" && level === "high");
      console.log("/thinking", "focus:", thinkingFocus, "ArrowDown + Enter selected:", thinkingSelected);
      assert.equal(thinkingSelected, true);
      await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));
      await input.fill("/thinking");
      await submit();
      await page.getByRole("listbox", { name: /change reasoning level/i }).waitFor();
      await page.keyboard.press("Home");
      const firstThinking = await page.getByRole("option").first().textContent();
      assert.equal(await highlightedText(), firstThinking);
      await page.keyboard.press("ArrowUp");
      const lastThinking = await page.getByRole("option").last().textContent();
      assert.equal(await highlightedText(), lastThinking, "ArrowUp wraps to the last option");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));
      assert.equal(await page.getByRole("listbox").count(), 0);
      if (process.env.KEYBOARD_ONLY) {
        await page.close();
        continue;
      }
      // Reset the fixture so mouse and keyboard coverage cannot mask each other.
      await page.reload();
      await page.addScriptTag({ content: outputFiles[0].text });
    }
    await input.fill("/model");
    await submit();
    await page.getByRole("listbox", { name: /choose model/i }).waitFor();
    assert.equal(await input.inputValue(), "");
    await page.getByRole("option").filter({ hasText: "Beta" }).click();
    await page.getByRole("listbox", { name: /thinking|reasoning/i }).waitFor();
    await page.getByRole("option").filter({ hasText: /^off$/i }).click();
    assert.ok((await page.evaluate(() => window.calls)).some(([kind, provider, model, level]) => kind === "confirm" && provider === "q" && model === "beta" && level === "off"));

    await input.fill("/model p/al");
    await submit();
    await page.getByRole("listbox", { name: /choose model/i }).waitFor();
    assert.equal(await page.getByRole("option").count(), 1);
    assert.match(await page.getByRole("option").innerText(), /Alpha/);
    await page.locator(".model-selector input").dispatchEvent("keydown", { key: "ArrowDown", isComposing: true });
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "INPUT", "IME navigation does not select models");
    await page.keyboard.press("Enter");
    await page.getByRole("listbox", { name: /thinking|reasoning/i }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));

    await input.fill("/model absent");
    await submit();
    await page.getByRole("listbox").waitFor();
    assert.equal(await page.getByRole("option").count(), 0);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("listbox").count(), 1, "empty search must not select or submit a prompt");
    await page.locator(".model-selector input").press("Escape");
    await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));

    await input.fill("/thinking");
    await submit();
    await page.getByRole("option", { name: /^high / }).click();
    assert.ok((await page.evaluate(() => window.calls)).some(([kind, level]) => kind === "thinking" && level === "high"));

    await page.locator('input[type="file"]').setInputFiles({
      name: "reference.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64"),
    });
    await page.locator("img").waitFor();
    await input.fill("/model p/alpha");
    await submit();
    await page.waitForFunction(() => document.querySelector("textarea").value === "");
    assert.equal(await page.locator("img").count(), 1, "settings must preserve attachments");

    await page.evaluate(() => window.setBusy(true));
    await input.fill("/thinking high");
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    await page.waitForFunction(() => window.calls.some(([kind, text]) => kind === "command" && text === "/thinking high"));
    assert.equal(await input.inputValue(), "/thinking high");
    await page.getByRole("button", { name: "Follow-up", exact: true }).click();
    assert.ok(!(await page.evaluate(() => window.calls)).some(([kind]) => ["prompt", "queue", "steer", "followup"].includes(kind)));
    console.log("PASS settings selectors and busy command routing", viewport.width);
    await page.close();
  }
} finally {
  await browser.close();
}
