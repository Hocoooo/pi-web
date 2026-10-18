import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { searchTaskReports, readTaskReportPage } from "./task-reports";

/** Inactive registration lets configured sessions follow defaultTools; pins name these explicitly. */
export function createTaskReportToolsExtension(agentDir: string): ExtensionFactory {
  return pi => {
    pi.registerTool(defineTool({
      name: "search_task_reports",
      label: "Search task reports",
      description: "Search committed successful task archives across the current agent's global space. Filter by taskId, frozen project root (null for no project), and case-insensitive literal keyword in task details, report body or any saved material. Returns IDs, times, coverage, material directory and bounded overview, not full text. Read with read_task_report; follow next until end. Does not generate or modify anything.",
      exposure: "direct",
      defaultActive: false,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      parameters: Type.Object({
        taskId: Type.Optional(Type.String()),
        project: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        keyword: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      outputSchema: Type.Object({ reports: Type.Array(Type.Any()), total: Type.Integer(), offset: Type.Integer(), next: Type.Union([Type.Integer(), Type.Null()]), end: Type.Boolean() }),
      async execute(_id, params) {
        const result = await searchTaskReports(params, agentDir), text = JSON.stringify(result);
        return { content: [{ type: "text", text }], details: result, structuredContent: JSON.parse(text) };
      },
    }));
    pi.registerTool(defineTool({
      name: "read_task_report",
      label: "Read task report",
      description: "Read a saved task archive by reportId, optionally materialId (material-N or synthesis-L-N from its directory). Omit materialId for the comprehensive body. Pages use UTF-16 character offsets, default limit 8000, maximum 16000; a whole Unicode character may extend a page by one. Append text in order and pass next as offset until end=true/next=null to read the complete tail. IDs only, no file paths. Missing or unfinished objects produce an ordinary error. Read-only, no model calls or source-session startup.",
      exposure: "direct",
      defaultActive: false,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      parameters: Type.Object({
        reportId: Type.String(),
        materialId: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
      }),
      outputSchema: Type.Object({ reportId: Type.String(), materialId: Type.Union([Type.String(), Type.Null()]), text: Type.String(), offset: Type.Integer(), next: Type.Union([Type.Integer(), Type.Null()]), end: Type.Boolean(), totalLength: Type.Integer() }),
      async execute(_id, params) {
        const result = await readTaskReportPage(params.reportId, params.materialId, params.offset, params.limit, agentDir), text = JSON.stringify(result);
        return { content: [{ type: "text", text }], details: result, structuredContent: JSON.parse(text) };
      },
    }));
  };
}
