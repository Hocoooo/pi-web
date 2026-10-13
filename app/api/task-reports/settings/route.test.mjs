import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { createJiti } from "jiti";
import { reportSettingsFixture } from "../../../../lib/task-report-settings.fixture.mjs";

const { GET, PUT } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");

test("global settings HTTP query/save and visible errors work without a project", async (t) => {
  const f = await reportSettingsFixture();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    assert.equal(f.requests(), 0);
    await f.close();
  });
  const put = (body) => PUT(new Request("http://localhost/api/task-reports/settings", { method: "PUT", body: JSON.stringify(body) }));
  assert.equal((await (await GET()).json()).availability, "unconfigured");
  assert.equal((await put({ selection: f.selection })).status, 200);
  assert.deepEqual((await (await GET()).json()).selection, f.selection);
  assert.equal((await put({ selection: { ...f.selection, thinkingLevel: "auto" } })).status, 400);
  assert.equal((await (await put({ selection: { ...f.selection, provider: "missing" } })).json()).code, "model-unavailable");
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ selection: f.selection, cwd: "/project-override" })).status, 400);
  assert.equal((await PUT(new Request("http://localhost/api/task-reports/settings", { method: "PUT", body: "{" }))).status, 400);
  assert.deepEqual((await (await GET()).json()).selection, f.selection);
  assert.deepEqual(await f.read(), { ...f.initial, taskArchiveReport: f.selection });
  await writeFile(f.settingsPath, "{ broken");
  const failed = await GET();
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).code, "storage-unavailable");
});
