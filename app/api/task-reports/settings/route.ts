import { getTaskReportSettings, saveTaskReportSettings, TaskReportSettingsError } from "@/lib/task-report-settings";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const code = error instanceof TaskReportSettingsError ? error.code : "storage-unavailable";
  const status = ["invalid-input", "invalid-level", "model-unavailable"].includes(code) ? 400 : 500;
  return Response.json({ code, error: error instanceof TaskReportSettingsError ? error.message : "Report settings unavailable." }, { status });
}

export async function GET() {
  try { return Response.json(await getTaskReportSettings()); }
  catch (error) { return errorResponse(error); }
}

export async function PUT(req: Request) {
  try {
    let body;
    try { body = await req.json(); }
    catch { throw new TaskReportSettingsError("invalid-input", "Invalid report settings request."); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("selection" in body)) {
      throw new TaskReportSettingsError("invalid-input", "Expected a report selection.");
    }
    return Response.json(await saveTaskReportSettings(body.selection));
  } catch (error) { return errorResponse(error); }
}
