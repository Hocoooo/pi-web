"use client";

import { useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { TASK_CONTEXT_FIELDS, TASK_CONTEXT_TEXT_LIMIT, type TaskContextContent, type TaskContextRequest, type TaskContextVersion, type TaskRecord } from "@/lib/task-types";
import { TaskContextPreview } from "./TaskContextPreview";
import styles from "./TaskSharedContext.module.css";
import boardStyles from "./TaskDashboard.module.css";

export interface TaskContextDraft {
  request: TaskContextRequest;
  content: TaskContextContent;
  preview: boolean;
  error: string | null;
  generatedSource?: import("@/lib/task-summary-types").SummaryProvenance;
}
const emptyContent = (): TaskContextContent => ({ goal: "", decisions: "", progress: "", nextSteps: "" });

/** The reviewed draft and base pointer live above columns, never rebased by rereads. */
export function TaskSharedContext({ task, disabled, draft, onDraftChange, onPublish, newOperationId }: {
  task: TaskRecord; disabled: boolean; draft: TaskContextDraft | null;
  onDraftChange: (draft: TaskContextDraft | null) => void;
  onPublish: (request: TaskContextRequest) => Promise<void>;
  newOperationId: () => string;
}) {
  const { t } = useI18n();
  const { versions, currentVersionId } = task.sharedContext;
  const current = versions.find((version) => version.id === currentVersionId);
  const [historyId, setHistoryId] = useState("");
  const [compareId, setCompareId] = useState("");
  const history = versions.find((version) => version.id === historyId) ?? current;
  const comparison = versions.find((version) => version.id === compareId) ?? current;
  function begin(version?: TaskContextVersion) {
    const content = { ...(version?.content ?? current?.content ?? emptyContent()) };
    const base = { id: task.id, expectedCurrentVersionId: currentVersionId, operationId: newOperationId() };
    onDraftChange({ content, preview: !!version, error: null,
      request: version ? { ...base, action: "restore-context", versionId: version.id }
        : { ...base, action: "publish-context", content } });
  }
  function change(key: keyof TaskContextContent, text: string) {
    if (!draft || draft.request.action !== "publish-context") return;
    const content = { ...draft.content, [key]: text };
    onDraftChange({ ...draft, content, error: null, preview: false,
      request: { ...draft.request, content, operationId: newOperationId() } });
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!draft || !draft.preview || disabled) return;
    onDraftChange({ ...draft, error: null });
    try { await onPublish(draft.request); onDraftChange(null); }
    catch (cause) { onDraftChange({ ...draft, error: (cause as Error).message }); }
  }
  function metadata(version: TaskContextVersion) {
    return <p className={boardStyles.metadata}>
      {t("tasks.context.version")}: <span>{version.id}</span>{" · "}
      <time dateTime={version.confirmedAt}>{new Date(version.confirmedAt).toLocaleString()}</time>{" · "}
      {t(version.source.kind === "manual" ? "tasks.context.manual" : version.source.kind === "ai" ? "tasks.summary.generated" : "tasks.context.restored")}
      {version.source.kind === "ai" && <span> · {version.source.model.provider}/{version.source.model.modelId} · {version.source.responseModel}
        {version.source.sources.map((source) => <span key={`${source.sessionId}:${source.leafId}`}> · {source.sessionId}/{source.leafId} ({source.entryIds.length}; tool: {source.toolEntryIds.length})</span>)}
      </span>}
      {version.source.kind === "restore" && <>: {version.source.versionId}</>}
    </p>;
  }
  return <section className={styles.context} aria-label={t("tasks.context.title")}>
    <h3>{t("tasks.context.title")}</h3>
    <p className={boardStyles.hint}>{t("tasks.context.policy")}</p>
    {current ? <div aria-label={t("tasks.context.current")}>
      <h4>{t("tasks.context.current")}</h4>{metadata(current)}<TaskContextPreview content={current.content} />
    </div> : <p>{t("tasks.context.empty")}</p>}
    {!draft && <button type="button" disabled={disabled} onClick={() => begin()}>{t("tasks.context.edit")}</button>}
    {draft && <form className={boardStyles.editForm} aria-label={t("tasks.context.review")} onSubmit={confirm}>
      <p>{t(draft.request.action === "restore-context" ? "tasks.context.restoreReview" : draft.generatedSource ? "tasks.summary.generated" : "tasks.context.manual")}</p>
      {draft.generatedSource && <p className={boardStyles.metadata}>{draft.generatedSource.model.provider}/{draft.generatedSource.model.modelId}
        {draft.generatedSource.sources.map((source) => <span key={`${source.sessionId}:${source.leafId}`}> · {source.sessionId}/{source.leafId}</span>)}</p>}
      {draft.preview ? <div aria-label={t("tasks.context.preview")}><TaskContextPreview content={draft.content} /></div>
        : TASK_CONTEXT_FIELDS.map((key) => <label key={key}>{t(`tasks.context.${key}`)}<textarea autoFocus={key === "goal"}
          aria-label={t(`tasks.context.${key}`)} rows={3} maxLength={TASK_CONTEXT_TEXT_LIMIT} disabled={disabled}
          value={draft.content[key]} onChange={(event) => change(key, event.target.value)} /></label>)}
      {draft.error && <div className={boardStyles.error} role="alert">{draft.error}<p>{t("tasks.draftKept")}</p></div>}
      <div className={boardStyles.actions}>
        {draft.preview ? <>
          <button type="submit" disabled={disabled}>{t("tasks.context.confirm")}</button>
          {draft.request.action === "publish-context" && <button type="button" disabled={disabled} onClick={() => onDraftChange({ ...draft, preview: false })}>{t("tasks.context.back")}</button>}
        </> : <button type="button" disabled={disabled || !TASK_CONTEXT_FIELDS.some((key) => draft.content[key].trim())}
          onClick={() => onDraftChange({ ...draft, preview: true })}>{t("tasks.context.preview")}</button>}
        <button type="button" disabled={disabled} onClick={() => onDraftChange(null)}>{t("sidebar.cancel")}</button>
      </div>
    </form>}
    {versions.length > 0 && <details className={styles.history}>
      <summary>{t("tasks.context.history")} ({versions.length})</summary>
      <label>{t("tasks.context.version")}<select aria-label={t("tasks.context.version")} value={history?.id ?? ""} onChange={(event) => setHistoryId(event.target.value)}>
        {versions.map((version, index) => <option key={version.id} value={version.id}>{index + 1} · {version.id}</option>)}
      </select></label>
      {history && <>
        {metadata(history)}<TaskContextPreview content={history.content} />
        <button type="button" disabled={disabled || !!draft} onClick={() => begin(history)}>{t("tasks.context.restore")}</button>
      </>}
      <label>{t("tasks.context.compare")}<select aria-label={t("tasks.context.compare")} value={comparison?.id ?? ""} onChange={(event) => setCompareId(event.target.value)}>
        {versions.map((version, index) => <option key={version.id} value={version.id}>{index + 1} · {version.id}</option>)}
      </select></label>
      {history && comparison && <div aria-label={t("tasks.context.comparison")}>
        {TASK_CONTEXT_FIELDS.map((key) => <section key={key}>
          <h4>{t(`tasks.context.${key}`)} · {t(history.content[key] === comparison.content[key] ? "tasks.context.unchanged" : "tasks.context.changed")}</h4>
          <div className={styles.comparison}><pre>{history.content[key]}</pre><pre>{comparison.content[key]}</pre></div>
        </section>)}
      </div>}
    </details>}
  </section>;
}
