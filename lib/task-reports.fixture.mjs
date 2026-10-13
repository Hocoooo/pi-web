import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { reportSettingsFixture } from "./task-report-settings.fixture.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { taskOperation } = await jiti.import("./task-operations.ts");
const { waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");

export async function taskReportsFixture(options) {
  const settings = await reportSettingsFixture(options), agentDir = settings.agentDir;
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
  const op = input => taskOperation(input, { agentDir });
  const current = async id => (await op({ action: "list" })).tasks.find(task => task.id === id);
  return { ...settings, cwd, op, current,
    boardFile: join(agentDir, "tasks", "board.json"),
    create: async title => (await op({ action: "create", id: randomUUID(), title, description: "Original goal", completionCriteria: "Original requirements", cwd: null })).task,
    session: (text = "Recorded source") => { const manager = SessionManager.create(cwd); manager.appendMessage({ role: "user", content: text, timestamp: 1 }); return manager; },
    link: async (id, sessionIds) => op({ action: "link", id, expectedRevision: (await current(id)).revision, sessionIds }),
    archive: async (id, cascade = false) => {
      const task = await current(id), request = { action: "set-archive", id, archived: true, expectedArchiveRevision: task.archiveRevision, operationId: randomUUID() };
      if (cascade) request.cascade = { previewToken: (await op({ action: "preview-archive", id })).token, confirmCrossTask: true };
      return { request, result: await op(request) };
    },
    reportBytes: id => readFile(join(agentDir, "task-reports", `${id}.json`)),
    close: async () => { await waitForTaskReportExecutor(); if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; await settings.close(); },
  };
}
