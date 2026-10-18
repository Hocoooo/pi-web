import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { reportSettingsFixture } from "./task-report-settings.fixture.mjs";

const { getTaskReportSettings, saveTaskReportSettings } = await createJiti(import.meta.url).import("./task-report-settings.ts");
const code = (expected) => (error) => error.code === expected;

async function fixture(t) {
  const f = await reportSettingsFixture();
  t.after(async () => { assert.equal(f.requests(), 0, "settings must never call the report model"); await f.close(); });
  return f;
}

test("global report selection persists independently of chat defaults, project and browser", async (t) => {
  const f = await fixture(t);
  const empty = await getTaskReportSettings(f.agentDir);
  assert.equal(empty.selection, null);
  assert.equal(empty.availability, "unconfigured");
  assert.deepEqual(empty.models.map((m) => m.provider).sort(), ["report-plain", "report-reasoning"]);
  assert.deepEqual(empty.thinkingLevels["report-plain:same-id"], ["off"]);
  assert.ok(empty.thinkingLevels["report-reasoning:same-id"].includes("high"));
  assert.ok(!Object.values(empty.thinkingLevels).flat().includes("auto"));

  const saved = await saveTaskReportSettings(f.selection, f.agentDir);
  assert.equal(saved.availability, "ready");
  assert.deepEqual((await getTaskReportSettings(f.agentDir)).selection, f.selection);
  assert.deepEqual(await f.read(), { ...f.initial, taskArchiveReport: f.selection });
  // A project setting is never an override for this global-only report choice.
  await mkdir(join(f.agentDir, ".pi"));
  await writeFile(join(f.agentDir, ".pi", "settings.json"), JSON.stringify({ taskArchiveReport: { ...f.selection, thinkingLevel: "low" } }));
  assert.deepEqual((await getTaskReportSettings(f.agentDir)).selection, f.selection);

  const plain = { provider: "report-plain", modelId: "same-id", thinkingLevel: "off" };
  await saveTaskReportSettings(plain, f.agentDir);
  assert.deepEqual((await getTaskReportSettings(f.agentDir)).selection, plain, "provider disambiguates identical ids");
  await saveTaskReportSettings(null, f.agentDir);
  assert.deepEqual(await f.read(), f.initial);
});

test("invalid or unavailable selections are refused without replacing the saved choice", async (t) => {
  const f = await fixture(t);
  await saveTaskReportSettings(f.selection, f.agentDir);
  for (const level of ["auto", "invented"]) {
    await assert.rejects(saveTaskReportSettings({ ...f.selection, thinkingLevel: level }, f.agentDir), code("invalid-level"));
  }
  await assert.rejects(saveTaskReportSettings({ provider: "report-plain", modelId: "same-id", thinkingLevel: "high" }, f.agentDir), code("invalid-level"));
  await assert.rejects(saveTaskReportSettings({ ...f.selection, provider: "missing" }, f.agentDir), code("model-unavailable"));
  for (const input of [{}, { ...f.selection, budget: 10 }, { ...f.selection, provider: "" }, undefined]) {
    await assert.rejects(saveTaskReportSettings(input, f.agentDir), code("invalid-input"));
  }
  assert.deepEqual((await getTaskReportSettings(f.agentDir)).selection, f.selection);
});

test("query retains unavailable model and invalid level with truthful availability, no fallback", async (t) => {
  const f = await fixture(t);
  const unavailable = { ...f.selection, provider: "missing" };
  await writeFile(f.settingsPath, JSON.stringify({ ...f.initial, taskArchiveReport: unavailable }));
  const state = await getTaskReportSettings(f.agentDir);
  assert.equal(state.availability, "model-unavailable");
  assert.deepEqual(state.selection, unavailable);
  const invalid = { ...f.selection, thinkingLevel: "auto" };
  await writeFile(f.settingsPath, JSON.stringify({ ...f.initial, taskArchiveReport: invalid }));
  assert.equal((await getTaskReportSettings(f.agentDir)).availability, "invalid-level");
  assert.deepEqual((await getTaskReportSettings(f.agentDir)).selection, invalid);
});

test("report writes share the SDK lock and preserve concurrent unrelated settings", async (t) => {
  const f = await fixture(t);
  const sdk = SettingsManager.create(f.agentDir, f.agentDir);
  sdk.setDefaultThinkingLevel("low");
  await Promise.all([sdk.flush(), saveTaskReportSettings(f.selection, f.agentDir)]);
  const saved = await f.read();
  assert.equal(saved.defaultThinkingLevel, "low");
  assert.deepEqual(saved.taskArchiveReport, f.selection);
  assert.deepEqual(saved.unrelated, f.initial.unrelated);
});

test("normal settings and model file errors are visible and never overwrite broken files", async (t) => {
  const f = await fixture(t);
  await writeFile(f.settingsPath, "{ invalid");
  await assert.rejects(getTaskReportSettings(f.agentDir), code("storage-unavailable"));
  await assert.rejects(saveTaskReportSettings(f.selection, f.agentDir), code("storage-unavailable"));
  assert.equal(await readFile(f.settingsPath, "utf8"), "{ invalid");
  await writeFile(f.settingsPath, JSON.stringify(f.initial));
  await writeFile(join(f.agentDir, "models.json"), "{ invalid");
  await assert.rejects(getTaskReportSettings(f.agentDir), code("models-unavailable"));
  await assert.rejects(saveTaskReportSettings(f.selection, f.agentDir), code("models-unavailable"));
  assert.deepEqual(await f.read(), f.initial);
});
