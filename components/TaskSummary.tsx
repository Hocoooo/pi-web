"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskRecord } from "@/lib/task-types";
import type { SummaryOptions, SummarySnapshot, SummaryModel, SummaryResult, TaskSummaryRequest } from "@/lib/task-summary-types";
import type { TaskContextDraft } from "./TaskSharedContext";
import styles from "./TaskDashboard.module.css";
import summaryStyles from "./TaskSummary.module.css";

async function request<T>(input: TaskSummaryRequest, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
interface SourceDraft { snapshot: SummarySnapshot; selected: Record<string, boolean>; text: Record<string, string> }

/** A dedicated explicit auxiliary workflow, outside draggable/remounting cards. */
export function TaskSummary({ task, originSessionId, newId, onDraft, onClose }: {
  task: TaskRecord; originSessionId: string | null; newId: () => string;
  onDraft: (draft: TaskContextDraft) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<SummaryOptions | null>(null);
  const [model, setModel] = useState<SummaryModel | null>(null);
  const [sources, setSources] = useState<Record<string, SourceDraft>>({});
  const [loadingSource, setLoadingSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null), [review, setReview] = useState(false);
  const base = useRef(task.sharedContext.currentVersionId);
  const run = useRef<{ controller: AbortController; operationId?: string } | null>(null);
  const alive = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (error && panelRef.current?.getClientRects().length) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  function cancelRun() {
    const current = run.current; run.current = null;
    current?.controller.abort();
    if (current?.operationId) void request({ action: "summary-cancel", id: task.id, operationId: current.operationId }).catch(() => {});
  }
  useEffect(() => {
    alive.current = true;
    panelRef.current?.focus();
    const controller = new AbortController(); run.current = { controller };
    async function load() {
      try {
        const result = await request<SummaryOptions>({ action: "summary-options", id: task.id, originSessionId }, controller.signal);
        if (!alive.current || controller.signal.aborted) return;
        setOptions(result); setModel(result.defaultModel);
        if (originSessionId) {
          const snapshot = await request<SummarySnapshot>({ action: "summary-source", id: task.id, sessionId: originSessionId, leafId: null }, controller.signal);
          if (!alive.current || controller.signal.aborted) return;
          setSources({ [originSessionId]: makeDraft(snapshot) });
        }
      } catch (e) { if (alive.current && !controller.signal.aborted) setError((e as Error).message); }
      finally { if (alive.current && !controller.signal.aborted) { setBusy(false); run.current = null; } }
    }
    void load();
    return () => { alive.current = false; cancelRun(); };
    // This panel is keyed by task+origin. Its base never rebases on a board refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function makeDraft(snapshot: SummarySnapshot): SourceDraft {
    return { snapshot, selected: Object.fromEntries(snapshot.items.map((i) => [i.entryId, i.role !== "toolResult"])),
      text: Object.fromEntries(snapshot.items.map((i) => [i.entryId, i.text])) };
  }
  async function selectSource(id: string, leafId: string | null = null) {
    if (busy) return;
    setBusy(true); setError(null); setReview(false); setLoadingSource(id);
    const controller = new AbortController(); run.current = { controller };
    try {
      const snapshot = await request<SummarySnapshot>({ action: "summary-source", id: task.id, sessionId: id, leafId }, controller.signal);
      if (alive.current && !controller.signal.aborted) setSources((current) => ({ ...current, [id]: makeDraft(snapshot) }));
    } catch (e) { if (alive.current && !controller.signal.aborted) setError((e as Error).message); }
    finally { if (alive.current && !controller.signal.aborted) { setBusy(false); setLoadingSource(null); run.current = null; } }
  }
  const material = Object.values(sources).map((s) => ({ snapshotId: s.snapshot.snapshotId,
    items: s.snapshot.items.filter((i) => s.selected[i.entryId] && s.text[i.entryId].trim()).map((i) => ({ entryId: i.entryId, text: s.text[i.entryId] })) })).filter((s) => s.items.length);
  async function generate() {
    if (!model || !review || busy || !material.length) return;
    setBusy(true); setError(null);
    const controller = new AbortController(), operationId = newId(); run.current = { controller, operationId };
    try {
      const result = await request<SummaryResult>({ action: "summary-generate", id: task.id, operationId,
        expectedCurrentVersionId: base.current, sources: material, model }, controller.signal);
      if (!alive.current || controller.signal.aborted || run.current?.operationId !== operationId) return;
      run.current = null;
      onDraft({ content: result.content, preview: false, error: null, request: { action: "publish-context", id: task.id,
        expectedCurrentVersionId: base.current, operationId: newId(), generationId: result.generationId, content: result.content },
        generatedSource: result.source });
      onClose();
    } catch (e) { if (alive.current && !controller.signal.aborted) setError((e as Error).message); }
    finally { if (alive.current && !controller.signal.aborted) { setBusy(false); run.current = null; } }
  }
  return <section ref={panelRef} tabIndex={-1} className={`${styles.form} ${summaryStyles.panel}`} aria-label={t("tasks.summary.title")} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); cancelRun(); onClose(); }
  }}>
    <h2>{t("tasks.summary.title")} — {task.title}</h2>
    <p className={styles.hint}>{t("tasks.summary.policy")}</p>
    {busy && <p role="status">{t("tasks.summary.busy")}</p>}
    {options && <>
      {options.models.length === 0 && <p role="status" className={styles.hint}>{t("tasks.summary.noModels")}</p>}
      {options.sessions.every(session => session.missing) && <p className={styles.hint}>{t("tasks.summary.noSessions")}</p>}
      <label>{t("tasks.summary.model")}<select aria-label={t("tasks.summary.model")} disabled={busy} value={model ? JSON.stringify(model) : ""}
        onChange={(event) => { setModel(event.target.value ? JSON.parse(event.target.value) : null); setReview(false); }}>
        <option value="">{t("tasks.summary.chooseModel")}</option>
        {model && !options.models.some((m) => m.provider === model.provider && m.modelId === model.modelId)
          && <option value={JSON.stringify(model)}>{model.provider}/{model.modelId} — {t("tasks.summary.unavailable")}</option>}
        {options.models.map((m) => <option key={JSON.stringify(m)} value={JSON.stringify(m)}>{m.provider}/{m.modelId}</option>)}
      </select></label>
      {options.sessions.map((session) => <div key={session.id}>
        <label className={`${styles.sessionChoice} ${summaryStyles.choice}`}><input type="checkbox" disabled={busy || session.missing || review} checked={!!sources[session.id] || loadingSource === session.id}
          onChange={(event) => { if (event.target.checked) void selectSource(session.id); else setSources((current) => { const next = { ...current }; delete next[session.id]; return next; }); }} />{session.name ?? session.id}{session.missing ? ` (${t("tasks.summary.unavailable")})` : ""}</label>
        {sources[session.id] && <fieldset disabled={busy}>
          <label>{t("tasks.summary.branch")}<select aria-label={`${t("tasks.summary.branch")}: ${session.id}`} disabled={review}
            value={sources[session.id].snapshot.leafId} onChange={(event) => void selectSource(session.id, event.target.value)}>
            {sources[session.id].snapshot.branches.map((id) => <option key={id} value={id}>{id}</option>)}
          </select></label>
          {sources[session.id].snapshot.items.filter((i) => !review || (sources[session.id].selected[i.entryId] && sources[session.id].text[i.entryId].trim())).map((item) => <div key={item.entryId}>
            <label className={`${styles.sessionChoice} ${summaryStyles.choice}`}><input type="checkbox" disabled={review} checked={sources[session.id].selected[item.entryId]}
              onChange={(event) => setSources((current) => ({ ...current, [session.id]: { ...current[session.id], selected: { ...current[session.id].selected, [item.entryId]: event.target.checked } } }))} />
              {item.role} · {item.entryId}{item.role === "toolResult" ? ` — ${t("tasks.summary.toolWarning")}` : ""}</label>
            {review ? <pre className={styles.text}>{sources[session.id].text[item.entryId]}</pre> : <textarea rows={3} aria-label={`${item.role}: ${item.entryId}`} value={sources[session.id].text[item.entryId]}
              onChange={(event) => setSources((current) => ({ ...current, [session.id]: { ...current[session.id], text: { ...current[session.id].text, [item.entryId]: event.target.value } } }))} />}
          </div>)}
        </fieldset>}
      </div>)}
      {review && <p>{t("tasks.summary.sendTo")}: {model?.provider}/{model?.modelId} — {t("tasks.summary.cost")}</p>}
      <div className={styles.actions}>
        {review ? <><button type="button" disabled={busy || !model || !material.length} onClick={() => void generate()}>{t("tasks.summary.generate")}</button>
          <button type="button" disabled={busy} onClick={() => setReview(false)}>{t("tasks.context.back")}</button></>
          : <button type="button" disabled={busy || !model || !material.length} onClick={() => setReview(true)}>{t("tasks.summary.preview")}</button>}
      </div>
    </>}
    {error && <div ref={errorRef} role="alert" className={styles.error}>{error}</div>}
    <button type="button" onClick={() => { cancelRun(); onClose(); }}>{t("sidebar.cancel")}</button>
  </section>;
}
