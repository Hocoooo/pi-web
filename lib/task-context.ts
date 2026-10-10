import { createHash, randomUUID } from "node:crypto";
import { TASK_CONTEXT_FIELDS, TASK_CONTEXT_TEXT_LIMIT, TASK_ID_PATTERN, isTaskSessionId, TaskOperationError, type TaskContextContent, type TaskContextRequest, type TaskContextVersion, type TaskSharedContext, type TaskContextSource } from "./task-types";

interface StoredContextVersion extends TaskContextVersion {
  receipt: { operationId: string; fingerprint: string };
}
export interface StoredSharedContext extends TaskSharedContext { versions: StoredContextVersion[] }
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && TASK_ID_PATTERN.test(value);
export function validContextContent(value: unknown): value is TaskContextContent {
  return object(value) && Object.keys(value).length === TASK_CONTEXT_FIELDS.length
    && TASK_CONTEXT_FIELDS.every((key) => typeof value[key] === "string" && value[key].length <= TASK_CONTEXT_TEXT_LIMIT)
    && TASK_CONTEXT_FIELDS.some((key) => (value[key] as string).trim());
}
/** Strict legacy hydration lives at the existing document migration boundary, not here. */
export function validSharedContext(value: unknown): value is StoredSharedContext {
  if (!object(value) || !Array.isArray(value.versions)) return false;
  const ids = new Set<string>(), operations = new Set<string>();
  let previousTime = -Infinity;
  for (const version of value.versions) {
    if (!object(version) || !uuid(version.id) || ids.has(version.id) || !validContextContent(version.content)
      || typeof version.confirmedAt !== "string" || !Number.isFinite(Date.parse(version.confirmedAt))
      || Date.parse(version.confirmedAt) <= previousTime || !object(version.source)
      || !object(version.receipt) || !uuid(version.receipt.operationId) || operations.has(version.receipt.operationId)
      || typeof version.receipt.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(version.receipt.fingerprint)) return false;
    if (version.source.kind === "ai") {
      const s = version.source;
      if (Object.keys(s).length !== 7 || !uuid(s.generationId) || typeof s.generatedAt !== "string" || !Number.isFinite(Date.parse(s.generatedAt))
        || !object(s.model) || Object.keys(s.model).length !== 2 || [s.model.provider, s.model.modelId, s.responseModel].some((v) => typeof v !== "string" || !v || v.length > 200)
        || typeof s.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(s.inputHash) || !Array.isArray(s.sources) || !s.sources.length || s.sources.length > 20
        || Array.from(s.sources).some((source) => !object(source) || Object.keys(source).length !== 4 || !isTaskSessionId(source.sessionId) || !isTaskSessionId(source.leafId)
          || !Array.isArray(source.entryIds) || !source.entryIds.length || Array.from(source.entryIds).some((id) => !isTaskSessionId(id)) || new Set(source.entryIds).size !== source.entryIds.length
          || !Array.isArray(source.toolEntryIds) || Array.from(source.toolEntryIds).some((id) => !isTaskSessionId(id) || !(source.entryIds as unknown[]).includes(id)) || new Set(source.toolEntryIds).size !== source.toolEntryIds.length)) return false;
    } else if (version.source.kind === "manual" ? Object.keys(version.source).length !== 1
      : version.source.kind !== "restore" || Object.keys(version.source).length !== 2 || !uuid(version.source.versionId) || !ids.has(version.source.versionId)) return false;
    previousTime = Date.parse(version.confirmedAt);
    ids.add(version.id); operations.add(version.receipt.operationId);
  }
  return value.currentVersionId === (value.versions.at(-1)?.id ?? null);
}
export function publicSharedContext(context: StoredSharedContext): TaskSharedContext {
  return { currentVersionId: context.currentVersionId, versions: context.versions.map(({ receipt, ...version }) => {
    void receipt; return version;
  }) };
}
export function parseContextRequest(value: Record<string, unknown>): TaskContextRequest {
  const keys = value.action === "publish-context"
    ? ["action", "id", "expectedCurrentVersionId", "operationId", "content", "generationId"]
    : ["action", "id", "expectedCurrentVersionId", "operationId", "versionId"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || !uuid(value.id) || !uuid(value.operationId)
    || (value.expectedCurrentVersionId !== null && !uuid(value.expectedCurrentVersionId))
    || (value.action === "publish-context" ? !validContextContent(value.content) || (value.generationId !== undefined && !uuid(value.generationId)) : !uuid(value.versionId))) {
    throw new TaskOperationError("invalid-input", "Use a valid task, operation and current version, with four text sections (at most 20000 characters each) and at least one non-empty section.");
  }
  // Canonical field order makes exact semantic retries independent of JSON property order.
  return value.action === "publish-context"
    ? { action: value.action, id: value.id as string, operationId: value.operationId as string, expectedCurrentVersionId: value.expectedCurrentVersionId as string | null,
      content: Object.fromEntries(TASK_CONTEXT_FIELDS.map((key) => [key, (value.content as TaskContextContent)[key]])) as TaskContextContent,
      ...(value.generationId !== undefined ? { generationId: value.generationId as string } : {}) }
    : value as unknown as TaskContextRequest;
}
/** Sole publish/restore commit semantics, called under the board lock. No session/model/file access. */
export function publishContext(context: StoredSharedContext, request: TaskContextRequest, source?: TaskContextSource): boolean {
  const identity: unknown[] = [request.action, request.id, request.expectedCurrentVersionId,
    request.action === "publish-context" ? request.content : request.versionId];
  if (request.action === "publish-context" && request.generationId) identity.push(request.generationId);
  const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const receipt = context.versions.find((version) => version.receipt.operationId === request.operationId);
  if (receipt) {
    if (receipt.receipt.fingerprint !== fingerprint) throw new TaskOperationError("conflict", "This publication ID was already used for different content. Your draft was not saved.");
    return false; // Confirm even an old exact request, never switch the current pointer back.
  }
  if (context.currentVersionId !== request.expectedCurrentVersionId) throw new TaskOperationError("conflict", "Shared context changed in another page. Refresh, then cancel and reopen to use the latest version; your draft was not saved.");
  const restored = request.action === "restore-context" ? context.versions.find((version) => version.id === request.versionId) : null;
  if (request.action === "restore-context" && !restored) throw new TaskOperationError("not-found", "Shared context version not found.");
  const last = context.versions.at(-1);
  const version: StoredContextVersion = {
    id: randomUUID(), confirmedAt: new Date(Math.max(Date.now(), last ? Date.parse(last.confirmedAt) + 1 : 0)).toISOString(),
    source: request.action === "publish-context" ? (source ?? { kind: "manual" }) : { kind: "restore", versionId: request.versionId },
    content: { ...(request.action === "publish-context" ? request.content : restored!.content) },
    receipt: { operationId: request.operationId, fingerprint },
  };
  context.versions.push(version); context.currentVersionId = version.id;
  return true;
}
