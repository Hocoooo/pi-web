"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskContextUpdateState } from "@/lib/task-types";
import { TaskContextPreview } from "./TaskContextPreview";

async function operation(input: unknown) {
  const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Context update failed.");
  return result;
}
// Like task creation, this also works on ordinary LAN HTTP (no randomUUID API).
function selectionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Read-only refresh only reminds; accepting is always a separate user action. */
export function TaskContextUpdates({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const { t } = useI18n();
  const [data, setData] = useState<TaskContextUpdateState | null>(null);
  const [selected, setSelected] = useState("");
  const [open, setOpen] = useState(false);
  const [baseRevision, setBaseRevision] = useState(0);
  const [baseRelation, setBaseRelation] = useState<{ taskId: string; generation: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const request = useRef<{ action: string; id: string; sessionId: string; operationId: string; expectedRevision: number; versionId: string; expectedRelationGeneration: number } | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    try {
      const result = await operation({ action: "context-update-state", sessionId });
      if (generation.current === token) setData(result);
    } catch (e) { if (generation.current === token) setError((e as Error).message); }
  }, [sessionId]);
  useEffect(() => {
    const requestGeneration = generation;
    setData(null); setOpen(false); setSelected(""); setError(null); request.current = null;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const wake = () => void refresh();
    window.addEventListener("focus", wake); window.addEventListener("online", wake);
    return () => { requestGeneration.current++; clearInterval(timer); window.removeEventListener("focus", wake); window.removeEventListener("online", wake); };
  }, [refresh]);
  useEffect(() => { void refresh(); }, [busy, refresh]);
  const task = data?.task;
  if (!task || !data) return error ? <p role="alert">{error}</p> : null;
  const state = data.state;
  const pending = state.choices.find(c => c.operationId === state.pendingOperationId);
  const version = task.sharedContext.versions.find(v => v.id === selected);
  const currentVersion = task.sharedContext.versions.find(v => v.id === data.current?.versionId);
  const pendingVersion = task.sharedContext.versions.find(v => v.id === pending?.versionId);
  const latest = task.sharedContext.currentVersionId;
  const newer = latest && latest !== (pending?.versionId ?? data.current?.versionId);
  async function accept() {
    if (!task || !version || !baseRelation) return;
    request.current ??= { action: "accept-context-update", id: baseRelation.taskId, sessionId, operationId: selectionId(), expectedRevision: baseRevision, expectedRelationGeneration: baseRelation.generation, versionId: version.id };
    setSaving(true); setError(null);
    try {
      await operation(request.current);
      request.current = null; setOpen(false); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  return <section aria-label={t("tasks.updateHeading")} style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", overflowWrap: "anywhere", maxHeight: "35%", overflow: "auto", flexShrink: 0 }}>
    <details>
      <summary>{t("tasks.updateHeading")} · {task.title}</summary>
      <p>{t("tasks.updateCurrent")}: {data.current?.versionId ?? t("tasks.updateNone")}</p>
      {data.current && <p>{data.current.successfulSend ? t("tasks.updateSent") : t("tasks.updateHistorical")} · {t("tasks.updateOrigin")}: {data.current.originSessionId}
        {!data.current.projected && <> · {t("tasks.updateExcluded")}</>}</p>}
      {currentVersion && <p>{t("tasks.updateSource")}: {JSON.stringify(currentVersion.source)}</p>}
      <p>{t("tasks.updateNext")}: {pending?.versionId ?? t("tasks.updateNone")}</p>
      {pendingVersion && <p>{t("tasks.updateSource")}: {JSON.stringify(pendingVersion.source)}</p>}
      <p>{t("tasks.updateBoundary")}</p>
      {state.deliveries.length > 0 && <details><summary>{t("tasks.updateAudit")}</summary>{state.deliveries.map(d => <p key={d.operationId}>{state.choices.find(c => c.operationId === d.operationId)?.versionId} · {d.sentAt} · {d.provider}/{d.model} · {d.entryId} · {d.evidence} · {d.inputHash}</p>)}</details>}
    </details>
    {newer && <p role="status">{t("tasks.updateAvailable")} · {latest}</p>}
    {pending && <p role="status">{t("tasks.updatePending")}: {pending.versionId}</p>}
    {!!task.sharedContext.versions.length && !open && <button type="button" onClick={() => { setSelected(latest ?? ""); setBaseRevision(state.revision); setBaseRelation({ taskId: task.id, generation: data.relationGeneration ?? 0 }); setOpen(true); request.current = null; setError(null); }}>{t("tasks.updateChoose")}</button>}
    {open && <div>
      <label>{t("tasks.updateVersion")} <select value={selected} disabled={saving} style={{ maxWidth: "100%", fontSize: 16 }} onChange={e => { setSelected(e.target.value); request.current = null; }}>
        {task.sharedContext.versions.map(v => <option key={v.id} value={v.id}>{v.id} · {v.confirmedAt}</option>)}
      </select></label>
      {version && <><p>{t("tasks.updateSource")}: {JSON.stringify(version.source)}</p><TaskContextPreview content={version.content} /></>}
      <p>{busy ? t("tasks.updateBusy") : t("tasks.updatePending")}</p>
      <button type="button" disabled={saving || !version} onClick={() => void accept()}>{t("tasks.updateAccept")}</button>
      <button type="button" disabled={saving} onClick={() => { setOpen(false); request.current = null; setError(null); }}>{t("sidebar.cancel")}</button>
      {error && <p role="alert">{error}</p>}
    </div>}
    {!open && error && <p role="alert">{error}</p>}
  </section>;
}
