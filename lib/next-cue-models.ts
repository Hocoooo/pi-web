import type { ModelsData } from "./models-cache";

/** Model list for the settings picker; /api/models may report errors with HTTP 200. */
export async function loadNextCueModels(cwd: string, signal: AbortSignal): Promise<ModelsData["modelList"]> {
  const response = await fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`, { signal });
  if (!response.ok) throw new Error("Model list is unavailable");
  const data = await response.json() as ModelsData;
  if (data.modelError || !Array.isArray(data.modelList)) throw new Error("Model list is unavailable");
  return data.modelList;
}
