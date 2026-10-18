import assert from "node:assert/strict";
import test from "node:test";
import { createTaskTestJiti } from "./__fixtures__/task-jiti.mjs";

const jiti = createTaskTestJiti(import.meta.url);

test("task aliases and relative imports share error constructor identity", async () => {
  const aliased = await jiti.import("@/lib/task-types");
  const relative = await jiti.import("./task-types.ts");
  const extensionless = await jiti.import("./task-types");
  assert.equal(aliased.TaskOperationError, relative.TaskOperationError);
  assert.equal(aliased.TaskOperationError, extensionless.TaskOperationError);
  const copy = await jiti.import("@/lib/task-session-copy");
  assert.equal(copy.SessionCopyError, (await jiti.import("./task-session-copy.ts")).SessionCopyError);
  const settings = await jiti.import("@/lib/task-report-settings");
  assert.equal(settings.TaskReportSettingsError, (await jiti.import("./task-report-settings.ts")).TaskReportSettingsError);
});

test("operation validation errors reach the HTTP constructor instead of the storage fallback", async () => {
  const { TaskOperationError } = await jiti.import("@/lib/task-types");
  const { taskOperation } = await jiti.import("@/lib/task-operations");
  await assert.rejects(taskOperation({ action: "task-picker" }, { agentDir: process.cwd() }), error => {
    assert.ok(error instanceof TaskOperationError);
    assert.equal(error.code, "invalid-input");
    return true;
  });
});
