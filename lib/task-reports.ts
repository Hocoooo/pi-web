import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { replaceTaskFile } from "./task-file-replacement";
import { join, resolve } from "node:path";
import { serializeByKey } from "./key-serializer";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getTaskReportSettings } from "./task-report-settings";
import { captureTaskReportSnapshot } from "./task-report-snapshot";
import { readTaskStore, withTaskStore, type StoredTaskRecord } from "./task-store";
import { TASK_ID_PATTERN, TaskOperationError } from "./task-types";
import type { TaskReport, TaskReportSnapshot, TaskReportSummary } from "./task-report-types";

function reportPath(agentDir: string, id: string): string {
  if (!TASK_ID_PATTERN.test(id)) throw new TaskOperationError("invalid-input", "Invalid report ID.");
  return join(agentDir, "task-reports", `${id}.json`);
}
const REPORT_FILE_IO = Symbol.for("pi-web.task-report-file-io");
function reportFileKey(file: string): string {
  const absolute = resolve(file);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
export async function writeTaskReport(report: TaskReport, agentDir = getAgentDir()): Promise<void> {
  const file = reportPath(agentDir, report.id);
  await serializeByKey(REPORT_FILE_IO, reportFileKey(file), async () => {
    await mkdir(join(agentDir, "task-reports"), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(`${JSON.stringify(report)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await replaceTaskFile(temporary, file);
    } finally { await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; }); }
  });
}
function metadataBody(snapshot: TaskReportSnapshot, createdAt: string): string {
  const task = snapshot.task;
  return `# ${task.title}\n\nTask: ${task.id}\nArchived: ${createdAt}\nProject: ${task.project?.projectRoot ?? "None"}\nStatus column: ${task.columnId}\nPriority: ${task.priority}\nLabels: ${task.labels.join(", ") || "None"}\n\n## Goal / task description\n${task.description || "Not recorded."}\n\n## Completion requirements\n${task.completionCriteria || "Not recorded."}\n\n## Source coverage\nNo summarizable conversation content was captured. This is a metadata archive; no model was called and no work outcome is inferred.\n${snapshot.sources.map(s => `- ${s.sessionId}: ${s.status}; cutoff ${s.cutoffEntryId ?? "none"}; activity ${JSON.stringify(s.activity)}${s.error ? `; ${s.error}` : ""}`).join("\n") || "No linked conversations."}\n`;
}
/** Preparation under the board lock. The returned ID becomes executable ONLY after board commit. */
export async function prepareTaskReport(task: StoredTaskRecord, agentDir: string): Promise<string> {
  const snapshot = await captureTaskReportSnapshot(task, agentDir);
  const report = await newTaskReport(snapshot, agentDir);
  await writeTaskReport(report, agentDir);
  return report.id;
}
async function newTaskReport(snapshot: TaskReportSnapshot, agentDir: string): Promise<TaskReport> {
  const createdAt = new Date().toISOString();
  const hasContent = snapshot.sources.some(source => source.items.length > 0);
  let selection: TaskReport["selection"] = null, configurationIssue: string | null = null;
  if (hasContent) {
    try {
      const settings = await getTaskReportSettings(agentDir);
      selection = settings.selection;
      if (settings.availability !== "ready") configurationIssue = settings.availability;
    } catch (error) { configurationIssue = error instanceof Error ? error.message : "Report configuration unavailable."; }
  }
  const body = hasContent ? null : metadataBody(snapshot, createdAt);
  const report: TaskReport = { id: randomUUID(), taskId: snapshot.task.id, createdAt,
    status: !hasContent ? "generated" : configurationIssue ? "awaiting-configuration" : "queued",
    selection, configurationIssue, snapshot, body, hasBody: body !== null,
    sources: snapshot.sources.map(({ items, ...source }) => { void items; return source; }) };
  return report;
}
async function committedReportIds(agentDir: string, taskId?: string): Promise<string[]> {
  return readTaskStore(agentDir)?.tasks.filter(task => !taskId || task.id === taskId).flatMap(task => task.reportIds ?? []) ?? [];
}
/** Reads never recover today's sessions. Uncommitted preparation is not publicly discoverable. */
export async function getTaskReport(id: string, agentDir = getAgentDir()): Promise<TaskReport> {
  reportPath(agentDir, id);
  if (!(await committedReportIds(agentDir)).includes(id)) throw new TaskOperationError("not-found", "Report not found in committed task references.");
  return readReportFile(id, agentDir);
}
async function readReportFile(id: string, agentDir: string): Promise<TaskReport> {
  try {
    const file = reportPath(agentDir, id);
    // Do not let our own polling hold a Windows read handle during replacement.
    return await serializeByKey(REPORT_FILE_IO, reportFileKey(file), async () => {
      const report = JSON.parse(await readFile(file, "utf8")) as TaskReport;
      if (report.id !== id || !report.snapshot || !Array.isArray(report.sources)) throw new Error("Invalid report file.");
      return report;
    });
  } catch (error) { throw new TaskOperationError("storage-unavailable", `Report could not be read: ${error instanceof Error ? error.message : "storage error"}`); }
}
export function taskReportSummary({ snapshot, body, materials, ...summary }: TaskReport): TaskReportSummary {
  void snapshot; void body;
  return { ...summary, ...(materials ? { materials: materials.map(({ body, ...material }) => ({ ...material, hasBody: body !== null })) } : {}) };
}
/** Same committed-report read boundary for the body and each durable material. Reads never execute. */
export async function readTaskReportText(id: string, materialId?: string, agentDir = getAgentDir()): Promise<string> {
  const report = await getTaskReport(id, agentDir);
  const body = materialId === undefined ? report.body : report.materials?.find(material => material.id === materialId)?.body;
  if (body == null) throw new TaskOperationError("not-found", materialId === undefined
    ? "Report body has not been generated." : "Material not found or not yet completed.");
  return body;
}
export async function listTaskReports(taskId?: string, agentDir = getAgentDir()): Promise<TaskReportSummary[]> {
  const ids = await committedReportIds(agentDir, taskId);
  return Promise.all(ids.map(async id => taskReportSummary(await getTaskReport(id, agentDir))));
}
export interface TaskReportSearch {
  taskId?: string;
  /** Frozen project root; null selects archives without a project. Omitted selects all. */
  project?: string | null;
  keyword?: string;
  offset?: number;
  limit?: number;
}
function pageNumber(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TaskOperationError("invalid-input", "Invalid page position or size.");
  return value;
}
/** Derived text search over committed successful archives; no index, source-session read or model. */
export async function searchTaskReports(query: TaskReportSearch = {}, agentDir = getAgentDir()) {
  if (query.taskId !== undefined && !TASK_ID_PATTERN.test(query.taskId)) throw new TaskOperationError("invalid-input", "Invalid task ID.");
  const offset = pageNumber(query.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = pageNumber(query.limit, 20, 100);
  if (limit === 0) throw new TaskOperationError("invalid-input", "Page size must be positive.");
  const keyword = query.keyword?.trim().toLowerCase();
  const matches = [];
  for (const summary of await listTaskReports(query.taskId, agentDir)) {
    if (summary.status !== "generated" || !summary.hasBody) continue;
    const report = await getTaskReport(summary.id, agentDir), task = report.snapshot.task;
    if (query.project !== undefined && (task.project?.projectRoot ?? null) !== query.project) continue;
    const texts = [JSON.stringify(task), report.body ?? "", ...(report.materials ?? []).flatMap(material => material.body === null ? [] : [material.body])];
    if (keyword && !texts.some(text => text.toLowerCase().includes(keyword))) continue;
    matches.push({ id: report.id, taskId: report.taskId, title: task.title, project: task.project,
      description: task.description.slice(0, 320), completionCriteria: task.completionCriteria.slice(0, 320),
      createdAt: report.createdAt, completedAt: report.completedAt ?? null,
      overview: (report.body ?? "").slice(0, 480), sources: report.sources,
      materials: (report.materials ?? []).filter(material => material.body !== null).map(material => ({
        id: material.id, level: material.level ?? 0, inputMaterialIds: material.inputMaterialIds ?? [], completedAt: material.completedAt ?? null,
      })) });
  }
  const reports = matches.slice(offset, offset + limit), end = offset + reports.length >= matches.length;
  return { reports, total: matches.length, offset, next: end ? null : offset + reports.length, end };
}
/** UTF-16 character positions; never divide a surrogate pair at a page boundary. */
export async function readTaskReportPage(id: string, materialId?: string, offset = 0, limit = 8000, agentDir = getAgentDir()) {
  pageNumber(offset, 0, Number.MAX_SAFE_INTEGER); pageNumber(limit, 8000, 16000);
  if (limit === 0) throw new TaskOperationError("invalid-input", "Page size must be positive.");
  const body = await readTaskReportText(id, materialId, agentDir);
  const dividesCharacter = (position: number) => position > 0 && position < body.length
    && body.charCodeAt(position - 1) >= 0xD800 && body.charCodeAt(position - 1) <= 0xDBFF
    && body.charCodeAt(position) >= 0xDC00 && body.charCodeAt(position) <= 0xDFFF;
  if (offset > body.length || dividesCharacter(offset)) {
    throw new TaskOperationError("invalid-input", "Page position is outside the text or divides a character.");
  }
  let until = Math.min(body.length, offset + limit);
  if (dividesCharacter(until)) until++;
  const end = until === body.length;
  return { reportId: id, materialId: materialId ?? null, text: body.slice(offset, until), offset,
    next: end ? null : until, end, totalLength: body.length };
}

/** Creation order is the committed task reference order, never completion time. */
export async function getTaskReportHistory(taskId: string, agentDir = getAgentDir()) {
  if (!TASK_ID_PATTERN.test(taskId)) throw new TaskOperationError("invalid-input", "Invalid task ID.");
  const reports = await listTaskReports(taskId, agentDir);
  return { reports, currentReportId: reports.at(-1)?.id ?? null,
    latestSuccessfulReportId: reports.findLast(report => report.status === "generated" && report.hasBody)?.id ?? null };
}
/** A new version copies the selected snapshot, not today's task/session data. */
export async function regenerateTaskReport(id: string, operationId: string, agentDir = getAgentDir()): Promise<TaskReport> {
  reportPath(agentDir, id);
  if (!TASK_ID_PATTERN.test(operationId)) throw new TaskOperationError("invalid-input", "Invalid operation ID.");
  const result = await withTaskStore(agentDir, async document => {
    const task = document.tasks.find(task => task.reportIds?.includes(id));
    if (!task) throw new TaskOperationError("not-found", "Report not found in committed task references.");
    const reports = await Promise.all(task.reportIds!.map(reportId => readReportFile(reportId, agentDir)));
    const previous = reports.find(report => report.regenerationOperationId === operationId);
    if (previous) {
      if (previous.regeneratedFromId !== id) throw new TaskOperationError("conflict", "Operation ID belongs to a different source report.");
      return { value: { report: previous, created: false }, changed: false };
    }
    const source = reports.find(report => report.id === id)!;
    const report = { ...await newTaskReport(source.snapshot, agentDir), regeneratedFromId: id, regenerationOperationId: operationId };
    await writeTaskReport(report, agentDir);
    task.reportIds!.push(report.id);
    return { value: { report, created: true }, changed: true };
  });
  if (result.created) {
    const { wakeTaskReportExecutor } = await import("./task-report-executor");
    wakeTaskReportExecutor(agentDir);
  }
  return result.report;
}
/** Executor queue: only committed, configured queued records, never orphan files. */
export async function listQueuedTaskReports(agentDir = getAgentDir()): Promise<TaskReport[]> {
  const summaries = await listTaskReports(undefined, agentDir);
  return Promise.all(summaries.filter(report => report.status === "queued").map(report => getTaskReport(report.id, agentDir)));
}
