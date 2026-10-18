import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readTaskStore } from "@/lib/task-store";
import { TaskOperationError } from "@/lib/task-types";
import type { TaskCatalog } from "@/lib/task-catalog-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    // Decoder-only snapshot: missing is empty; no initialization, lock or migration writes.
    const document = readTaskStore(getAgentDir());
    const catalog: TaskCatalog = { tasks: (document?.tasks ?? []).map(task => ({
      id: task.id,
      title: task.title,
      description: task.description,
      completionCriteria: task.completionCriteria,
      project: task.project === null ? null : {
        cwd: task.project.cwd, projectRoot: task.project.projectRoot, projectKey: task.project.projectKey,
      },
      archived: task.archived,
      updatedAt: task.updatedAt,
      sessionIds: task.sessionIds,
    })) };
    return NextResponse.json(catalog, { headers });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof TaskOperationError ? error.message : "Task storage is unavailable.",
      code: error instanceof TaskOperationError ? error.code : "storage-unavailable",
    }, { status: 503, headers });
  }
}
