import { readFile } from "node:fs/promises";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { listSessionMetadata } from "./session-list-scanner";
import { getRpcSession, getTaskSessionActivity } from "./rpc-manager";
import { taskSessionPathInScope } from "./task-sessions";
import type { StoredTaskRecord } from "./task-store";
import type { TaskReportItem, TaskReportSnapshot, TaskReportSource } from "./task-report-types";

/** Full active branch, NOT the compacted sending window. Last branch-local edit wins. */
function extract(manager: SessionManager): TaskReportItem[] {
  const branch = manager.getBranch();
  const edits = new Map(branch.filter(entry => entry.type === "context_edit").map(entry => [entry.targetId, entry.replacement]));
  return branch.flatMap((entry): TaskReportItem[] => {
    const edit = edits.get(entry.id);
    if (edits.has(entry.id) && edit === null) return [];
    let text = "", kind: string = entry.type;
    if (entry.type === "compaction" || entry.type === "branch_summary") text = entry.summary;
    else if (entry.type === "message" && entry.message.role === "bashExecution") {
      const m = entry.message;
      text = `$ ${m.command}\n${m.output}\nExit: ${m.exitCode ?? "unknown"}; cancelled: ${m.cancelled}; truncated: ${m.truncated}`;
      kind = m.role;
    } else if (entry.type === "custom_message" || entry.type === "message" && "content" in entry.message && entry.message.role !== "system") {
      const content = edit?.content ?? (entry.type === "custom_message" ? entry.content : "content" in entry.message ? entry.message.content : []);
      kind = entry.type === "custom_message" ? entry.customType : entry.message.role;
      text = typeof content === "string" ? content : content.flatMap(block => {
        if (block.type === "text") return [block.text];
        if (block.type === "toolCall") return [`Tool call ${block.name} (${block.id}): ${JSON.stringify(block.arguments)}`];
        if (block.type === "image") return ["[Image attachment present; binary omitted]"];
        return []; // Hidden thinking is never archived as report input.
      }).join("\n");
      if (entry.type === "message" && entry.message.role === "toolResult") text = `Tool result ${entry.message.toolName} (${entry.message.toolCallId}):\n${text}`;
    }
    return text.trim() ? [{ entryId: entry.id, timestamp: entry.timestamp, kind, text }] : [];
  });
}

/** Read-only capture: no SessionManager.open migration, source AgentSession, or external files. */
export async function captureTaskReportSnapshot(task: StoredTaskRecord, agentDir: string): Promise<TaskReportSnapshot> {
  const catalog = task.sessionIds.length ? await listSessionMetadata(agentDir) : [];
  const sources: TaskReportSource[] = [];
  for (const sessionId of task.sessionIds) {
    const activity = getTaskSessionActivity(agentDir, [sessionId]).find(s => s.id === sessionId) ?? { running: false };
    const source: TaskReportSource = { sessionId, capturedAt: new Date().toISOString(), status: "missing", leafId: null, cutoffEntryId: null, activity, items: [] };
    try {
      const disk = catalog.find(s => s.id === sessionId), live = getRpcSession(sessionId);
      let manager: SessionManager | null = null;
      const native = live?.inner.sessionManager;
      if (native && taskSessionPathInScope(agentDir, native.getSessionFile() ?? "") && !live?.hasDeletedSessionFile()) {
        const header = native.getHeader();
        if (header) {
          manager = SessionManager.inMemory(header.cwd, undefined, [header, ...native.getEntries()]);
          const leaf = native.getLeafId();
          if (leaf === null) manager.resetLeaf(); else manager.branch(leaf);
        }
      } else if (disk) {
        const entries = parseSessionEntries(await readFile(disk.path, "utf8"));
        const header = entries[0];
        if (header?.type !== "session" || header.id !== sessionId) throw new Error("Source identity changed during capture.");
        manager = SessionManager.inMemory(header.cwd, undefined, entries);
      }
      if (manager) {
        source.status = "available";
        source.leafId = manager.getLeafId();
        source.cutoffEntryId = source.leafId;
        source.items = extract(manager);
      }
    } catch (error) {
      source.status = "unavailable";
      source.error = error instanceof Error ? error.message : "Source could not be read.";
    }
    sources.push(source);
  }
  const { id, title, description, completionCriteria, priority, labels, project, columnId, revision, archiveRevision, createdAt, updatedAt } = task;
  return { task: structuredClone({ id, title, description, completionCriteria, priority, labels, project, columnId, revision, archiveRevision: archiveRevision + 1, createdAt, updatedAt }), sources };
}
