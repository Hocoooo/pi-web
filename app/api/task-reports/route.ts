import { getTaskReport, getTaskReportHistory, listTaskReports, readTaskReportText, regenerateTaskReport } from "@/lib/task-reports";
import { retryTaskReport } from "@/lib/task-report-executor";
import { TASK_ID_PATTERN, TaskOperationError } from "@/lib/task-types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const input = await req.json();
    if (!input || !["retry", "regenerate"].includes(input.action) || typeof input.id !== "string" || typeof input.operationId !== "string"
      || Object.keys(input).some(key => !["action", "id", "operationId"].includes(key))) {
      throw new TaskOperationError("invalid-input", "Expected report retry or regeneration with ID and operation ID.");
    }
    const report = input.action === "regenerate" ? await regenerateTaskReport(input.id, input.operationId)
      : await retryTaskReport(input.id, input.operationId);
    return Response.json({ id: report.id, attempt: report.attempt ?? 1, status: report.status, regeneratedFromId: report.regeneratedFromId });
  } catch (error) {
    const code = error instanceof TaskOperationError ? error.code : "storage-unavailable";
    return Response.json({ code, error: error instanceof Error ? error.message : "Report retry unavailable." },
      { status: code === "invalid-input" || error instanceof SyntaxError ? 400 : code === "not-found" ? 404 : code === "conflict" ? 409 : 500 });
  }
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams, id = params.get("id"), taskId = params.get("taskId");
    if (id) {
      const material = params.get("material");
      if (params.get("body") === "1" || material !== null) {
        const text = await readTaskReportText(id, material ?? undefined);
        return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      }
      return Response.json(await getTaskReport(id));
    }
    if (taskId && !TASK_ID_PATTERN.test(taskId)) throw new TaskOperationError("invalid-input", "Invalid task ID.");
    return Response.json(taskId ? await getTaskReportHistory(taskId) : { reports: await listTaskReports() });
  } catch (error) {
    const code = error instanceof TaskOperationError ? error.code : "storage-unavailable";
    return Response.json({ code, error: error instanceof Error ? error.message : "Report unavailable." },
      { status: code === "invalid-input" ? 400 : code === "not-found" ? 404 : 500 });
  }
}
