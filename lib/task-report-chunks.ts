import type { TaskReport, TaskReportMaterial, TaskReportPart } from "./task-report-types";

export function taskReportMaterialPrompt(report: TaskReport, material: TaskReportMaterial): string {
  return JSON.stringify({ operation: "detailed-material", reportId: report.id, materialId: material.id,
    archivedAt: report.createdAt, task: report.snapshot.task,
    instruction: "Write a detailed durable source dossier, not just a short summary. Preserve decisions/reasons, alternatives, failed paths, commands/results, files, actual observations versus claims and unknowns. Cite session/entry and slice offsets. This is one ordered segment; do not infer missing preceding/following evidence. No tools.",
    parts: material.parts.map(part => {
      const source = report.snapshot.sources[part.sourceIndex], item = source.items[part.itemIndex];
      const { items, ...metadata } = source;
      return { source: metadata, entryId: item.entryId, timestamp: item.timestamp, kind: item.kind,
        previousEntryId: items[part.itemIndex - 1]?.entryId ?? null, nextEntryId: items[part.itemIndex + 1]?.entryId ?? null,
        start: part.start, end: part.end, totalLength: item.text.length, text: item.text.slice(part.start, part.end) };
    }) });
}

/** Greedy ordered packing of every frozen character. Binary search includes JSON escaping/metadata in capacity. */
export function planTaskReportMaterials(report: TaskReport, fits: (prompt: string) => boolean): TaskReportMaterial[] {
  const materials: TaskReportMaterial[] = [];
  let current: TaskReportMaterial = { id: "material-1", parts: [], body: null };
  const flush = () => {
    materials.push(current); current = { id: `material-${materials.length + 1}`, parts: [], body: null };
  };
  for (const [sourceIndex, source] of report.snapshot.sources.entries()) {
    for (const [itemIndex, item] of source.items.entries()) {
      let start = 0;
      do {
        const part: TaskReportPart = { sourceIndex, itemIndex, start, end: item.text.length };
        const candidate = (end: number) => taskReportMaterialPrompt(report, { ...current, parts: [...current.parts, { ...part, end }] });
        if (fits(candidate(part.end))) {
          current.parts.push(part); start = part.end; break;
        }
        // Prefer keeping an ordinary entry whole when it fits an empty segment.
        if (current.parts.length) { flush(); continue; }
        let low = start, high = item.text.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits(candidate(mid))) low = mid; else high = mid - 1;
        }
        // Do not break a Unicode character across slices.
        if (low > start && /[\uD800-\uDBFF]/.test(item.text[low - 1])) low--;
        if (low === start) throw new Error("Model capacity cannot hold task/source context and a source slice. Nothing was truncated.");
        current.parts.push({ ...part, end: low }); start = low; flush();
      } while (start < item.text.length);
    }
  }
  if (current.parts.length) flush();
  return materials;
}

export function taskReportMaterialCoverage(report: TaskReport, material: TaskReportMaterial): string {
  return `## Fixed material source directory\nReport: ${report.id}\nMaterial: ${material.id}\n${material.parts.map(part => {
    const source = report.snapshot.sources[part.sourceIndex], item = source.items[part.itemIndex];
    return `- Session ${source.sessionId}; entry ${item.entryId} (${item.kind}); slice ${part.start}–${part.end}/${item.text.length}; previous ${source.items[part.itemIndex - 1]?.entryId ?? "none"}; next ${source.items[part.itemIndex + 1]?.entryId ?? "none"}; cutoff ${source.cutoffEntryId ?? "none"}`;
  }).join("\n")}\n`;
}

export function taskReportSynthesisPrompt(report: TaskReport, materials = report.materials!, target?: TaskReportMaterial): string {
  return JSON.stringify({ operation: target ? "synthesis-material" : "synthesis", reportId: report.id, archivedAt: report.createdAt,
    task: report.snapshot.task, sources: report.sources,
    ...(target ? { materialId: target.id, level: target.level } : {}),
    instruction: target
      ? "Synthesize this complete group into a detailed intermediate dossier. Preserve background, decisions/reasons, failed paths, verification evidence and unfinished work, distinguishing observations, claims and unknowns. Cite input material/session/entry IDs. Do not expand the plan. All inputs remain separately readable. No tools."
      : "Synthesize all supplied materials into the complete work archive. Preserve evidence distinctions and cite material/session/entry IDs; all materials remain separately readable. No tools.",
    materials: materials.map(material => ({ id: material.id, body: material.body })) });
}

/** Whole durable materials only; every layer must strictly reduce the finite frontier. */
export function planTaskReportSynthesis(report: TaskReport, inputs: TaskReportMaterial[], level: number, fits: (prompt: string) => boolean): TaskReportMaterial[] {
  const groups: TaskReportMaterial[] = [];
  let group: TaskReportMaterial = { id: `synthesis-${level}-1`, level, inputMaterialIds: [], parts: [], body: null };
  const flush = () => {
    groups.push(group);
    group = { id: `synthesis-${level}-${groups.length + 1}`, level, inputMaterialIds: [], parts: [], body: null };
  };
  for (const material of inputs) {
    const candidate = () => ({ ...group, inputMaterialIds: [...group.inputMaterialIds!, material.id] });
    const prompt = () => taskReportSynthesisPrompt(report, candidate().inputMaterialIds.map(id => inputs.find(input => input.id === id)!), candidate());
    if (!fits(prompt()) && group.inputMaterialIds!.length) flush();
    if (!fits(prompt())) throw new Error("Model capacity cannot hold task/source context and one complete saved material. Nothing was truncated.");
    group.inputMaterialIds!.push(material.id);
  }
  if (group.inputMaterialIds!.length) flush();
  if (groups.length >= inputs.length) throw new Error("Model capacity cannot reduce the synthesis layer. All saved materials remain readable; nothing was truncated.");
  return groups;
}

export function taskReportSynthesisCoverage(report: TaskReport, material: TaskReportMaterial): string {
  return `## Fixed synthesis input directory\nReport: ${report.id}\nMaterial: ${material.id}; level: ${material.level}\n${material.inputMaterialIds!.map(id => `- [${id}](/api/task-reports?id=${encodeURIComponent(report.id)}&material=${encodeURIComponent(id)})`).join("\n")}\n`;
}
