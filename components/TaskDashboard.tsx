"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { focusIfLost, focusModalPanel } from "@/lib/stacked-dialog";
import { useSearchParams } from "next/navigation";
import { DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, useSensor, useSensors, type DragEndEvent, type CollisionDetection } from "@dnd-kit/core";
import { TaskDragCard, TaskDropColumn } from "./TaskDragTargets";
import { TaskViewControls } from "./TaskViewControls";
import { emptyTaskFilter, projectTaskView, taskActivity } from "@/lib/task-view";
import { TaskColumnSettings, taskColumnName } from "./TaskColumnSettings";
import { TaskProjectField } from "./TaskProject";
import { TaskDetails, type TaskEditDraft } from "./TaskDetails";
import { TaskInspector } from "./TaskInspector";
import { TaskRelation } from "./TaskRelation";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { TASK_TEXT_LIMITS, type TaskBoard, type TaskColumnId, type TaskRecord, type TaskRequest, type TaskMovePosition, type TaskMutationResult, type TaskSessionsResult, type TaskSessionInfo, type TaskRelationRequest, type TaskSessionActivity, type TaskSort } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";

async function requestTask(input: { action: "list" }): Promise<TaskBoard>;
async function requestTask(input: Extract<TaskRequest, { action: "set-columns" | "remove-column" | "save-view" | "change-session-relation" }>): Promise<TaskBoard>;
async function requestTask(input: { action: "sessions"; id: string }): Promise<TaskSessionsResult>;
async function requestTask(input: Extract<TaskRequest, { action: "create" | "createFromSession" | "edit" | "link" | "move" | "set-archive" | "change-project" }>): Promise<TaskMutationResult>;
async function requestTask(input: TaskRequest): Promise<TaskBoard | TaskMutationResult | TaskSessionsResult> {
  const response = await fetch("/api/tasks", input.action === "list" ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { code: data.code });
  return data;
}

// getRandomValues also works on Pi Web's ordinary LAN HTTP origins, unlike randomUUID.
function newTaskId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Pointer hits on cards take precedence over the containing column. No nearest-column
// fallback: dropping outside the board is cancellation, not an accidental write.
const taskCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.filter((hit) => String(hit.id).startsWith("task:")).length
    ? hits.filter((hit) => String(hit.id).startsWith("task:")) : hits;
};

export function TaskDashboard({ active = true, onClose, currentSessionId = null, requestedTask }: { active?: boolean; onClose?: () => void; currentSessionId?: string | null; requestedTask?: { id: string; request: number } | null }) {
  const { t } = useI18n();
  const params = useSearchParams();
  const [initialSourceSession] = useState(() => params.get("sourceSession"));
  useTheme();
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskState] = useState<string | null>(null);
  const [inspectedTaskIds, setInspectedTaskIds] = useState<string[]>([]);
  const setSelectedTaskId = useCallback((id: string | null) => {
    setSelectedTaskState(id);
    if (id) setInspectedTaskIds(current => current.includes(id) ? current : [...current, id]);
  }, []);
  const activeRef = useRef(active);
  useLayoutEffect(() => { activeRef.current = active; }, [active]);
  const inspector = useRef<HTMLDivElement>(null);
  const dashboard = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const chatActionsRef = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    // A late metadata response must not capture the chat composer as a nested
    // return-focus target while hidden. Parent open owns that focus.
    if (selectedTaskId && activeRef.current) return focusModalPanel(document, inspector.current);
  }, [selectedTaskId]);
  useLayoutEffect(() => {
    if (active) focusIfLost(document, inspector.current ?? dashboard.current);
  });
  const [relation, setRelation] = useState<{ source: TaskRecord; session: TaskSessionInfo } | null>(null);
  const [filter, setFilter] = useState(emptyTaskFilter);
  const [sort, setSort] = useState<TaskSort>("manual");
  const boardScroll = useRef<HTMLDivElement>(null);
  // Deliberately outside saved six-condition views: opening an old view never
  // changes its stable conditions or silently includes archived tasks.
  const [archiveScope, setArchiveScope] = useState<"active" | "archived" | "all">("active");
  useEffect(() => { if (boardScroll.current) boardScroll.current.scrollLeft = 0; }, [filter, sort, archiveScope]);
  const [retryArchive, setRetryArchive] = useState<Extract<TaskRequest, { action: "set-archive" }> | null>(null);
  const dragProjection = useRef<TaskRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const requestVersion = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [dragTask, setDragTask] = useState<TaskRecord | null>(null);
  const dragBoard = useRef<TaskBoard | null>(null);
  const dropPointer = useRef<{ x: number; y: number } | null>(null);
  const [retryMove, setRetryMove] = useState<Extract<TaskRequest, { action: "move" }> | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }));
  const [creating, setCreating] = useState(false);
  const [sourceSessionId, setSourceSessionId] = useState<string | null>(null);
  const [linkTargetId, setLinkTargetId] = useState("");
  const handledTaskRequest = useRef<number | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string> | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [sessionActivity, setSessionActivity] = useState<Record<string, TaskSessionActivity>>({});
  useEffect(() => {
    if (initialSourceSession) { setSourceSessionId(initialSourceSession); setCreating(true); }
  }, [initialSourceSession]);
  useEffect(() => {
    if (!active) return;
    let disposed = false, inFlight = false;
    async function activity() {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const response = await fetch("/api/agent/running", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.runningSessionIds) || data.runningSessionIds.some((id: unknown) => typeof id !== "string")) throw new Error("Activity unavailable");
        if (!disposed) { setRunningIds(new Set(data.runningSessionIds)); setSessionActivity(data.sessionActivity ?? {}); setActivityError(false); }
      } catch { if (!disposed) setActivityError(true); }
      finally { inFlight = false; }
    }
    void activity();
    const timer = setInterval(() => void activity(), 2500);
    const refresh = () => void activity();
    window.addEventListener("online", refresh); window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true; clearInterval(timer);
      window.removeEventListener("online", refresh); window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active]);
  const [configuringColumns, setConfiguringColumns] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<string, TaskEditDraft>>({});
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [completionCriteria, setCompletionCriteria] = useState("");
  const [cwd, setCwd] = useState("");
  // Keep the same creation ID across a failed/lost response. Editing content starts a new attempt.
  const createAttempt = useRef<{ payload: string; id: string } | null>(null);
  const disabled = pending || loading || !!dragTask;
  const projection = board ? projectTaskView(board, filter, sort, runningIds, activityError) : { tasks: [], invalid: false };
  const visibleTasks = dragProjection.current ?? projection.tasks.filter(task => archiveScope === "all" || !!task.archived === (archiveScope === "archived"));

  const reload = useCallback(async () => {
    if (pendingRef.current || dragBoard.current) return;
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const next = await requestTask({ action: "list" });
      if (requestVersion.current === version) {
        setBoard(next);
        // Reading authority does not confirm the outstanding move's exact receipt.
        setError((current) => retryMove || retryArchive ? current : null);
        // Membership may have changed in another tab while this panel was hidden.
        // Consume direct navigation only against the completed authoritative read.
        if (activeRef.current && requestedTask && handledTaskRequest.current !== requestedTask.request) {
          handledTaskRequest.current = requestedTask.request;
          const target = next.tasks.find(task => task.id === requestedTask.id);
          setSelectedTaskId(target?.id ?? null);
          if (!target) setError(t("tasks.taskUnavailable"));
        }
      }
    } catch (cause) {
      if (requestVersion.current === version) setError((cause as Error).message);
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [retryMove, retryArchive, requestedTask, setSelectedTaskId, t]);
  useEffect(() => {
    if (!active) return;
    void reload();
    const refreshVisible = () => { if (document.visibilityState === "visible") void reload(); };
    window.addEventListener("online", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      window.removeEventListener("online", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [reload, active]);
  const pendingNavigation = useRef(false);
  useEffect(() => {
    const finishedMutation = pendingNavigation.current && !pending;
    pendingNavigation.current = pending;
    // A direct open attempted during a mutation was deferred by reload's guard.
    // Do not refresh ordinary mutation failures and erase their explanation.
    if (finishedMutation && active && requestedTask && handledTaskRequest.current !== requestedTask.request) void reload();
  }, [pending, active, requestedTask, reload]);

  function startMutation() {
    pendingRef.current = true;
    requestVersion.current++;
    setPending(true);
    setError(null);
    setNotice(""); setRetryMove(null); setRetryArchive(null);
  }
  function finishMutation() {
    pendingRef.current = false; setPending(false);
    window.dispatchEvent(new Event("pi-web:tasks-changed"));
  }
  function applyResult(result: TaskMutationResult) { setBoard(result.board); }
  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (disabled || !board) return;
    const content = sourceSessionId ? { action: "createFromSession" as const, title, description, completionCriteria, sourceSessionId }
      : { action: "create" as const, title, description, completionCriteria, cwd: cwd.trim() || null };
    const payload = JSON.stringify(content);
    if (createAttempt.current?.payload !== payload) createAttempt.current = { payload, id: newTaskId() };
    startMutation();
    try {
      applyResult(await requestTask({ id: createAttempt.current.id, ...content }));
      setCreating(false); setTitle(""); setDescription(""); setCompletionCriteria(""); setCwd("");
      createAttempt.current = null;
      setSourceSessionId(null);
      setNotice(t("tasks.created"));
    } catch (cause) { setError((cause as Error).message); }
    finally { finishMutation(); }
  }
  async function submitMove(request: Extract<TaskRequest, { action: "move" }>) {
    if (pendingRef.current) return;
    startMutation(); setRetryMove(null);
    try {
      applyResult(await requestTask(request));
      setNotice(t("tasks.moved"));
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      setError(failure.message);
      if (failure.code !== "conflict" && failure.code !== "invalid-input" && failure.code !== "not-found") setRetryMove(request);
      // No optimistic reorder; reconcile even an unknown/lost successful response.
      // Keep the failure visible and retry the exact request, never a rebased intent.
      try { setBoard(await requestTask({ action: "list" })); }
      catch (syncFailure) { setError(`${failure.message} — ${(syncFailure as Error).message}`); }
    } finally { finishMutation(); }
  }
  async function submitArchive(request: Extract<TaskRequest, { action: "set-archive" }>) {
    if (pendingRef.current) return;
    startMutation();
    try {
      applyResult(await requestTask(request));
      setNotice(t(request.archived ? "tasks.archive.archivedNotice" : "tasks.archive.restoredNotice"));
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      setError(failure.message);
      if (!["conflict", "invalid-input", "not-found"].includes(failure.code ?? "")) setRetryArchive(request);
      try { setBoard(await requestTask({ action: "list" })); }
      catch (syncFailure) { setError(`${failure.message} — ${(syncFailure as Error).message}`); }
    } finally { finishMutation(); }
  }
  function moveTask(task: TaskRecord, columnId: TaskColumnId, position: TaskMovePosition = { edge: "end" }, snapshot = board) {
    if (pendingRef.current || !snapshot) return;
    if (sort !== "manual") {
      if (task.columnId === columnId) { setNotice(t("tasks.view.autoHelp")); return; }
      // Automatic placement is presentation only; do not pretend the pointer fixes a rank.
      position = { edge: "end" };
    }
    void submitMove({ action: "move", id: task.id, columnId, position, expectedRevision: task.revision,
      expectedOrderRevision: snapshot.orderRevision, operationId: newTaskId() });
  }
  function endDrag(event: DragEndEvent) {
    const snapshot = dragBoard.current;
    dragBoard.current = null; dragProjection.current = null; setDragTask(null);
    const task = snapshot?.tasks.find((item) => item.id === event.active.id);
    const target = event.over;
    if (!snapshot || !task || !target || target.data.current?.taskId === task.id) { setNotice(t("tasks.dragCancelled")); return; }
    const columnId = target.data.current?.columnId as TaskColumnId;
    const neighborId = target.data.current?.taskId as string | undefined;
    const position: TaskMovePosition = neighborId
      ? dropPointer.current && dropPointer.current.y > target.rect.top + target.rect.height / 2 ? { after: neighborId } : { before: neighborId }
      : { edge: "end" };
    moveTask(task, columnId, position, snapshot);
  }

  async function editTask(request: Extract<TaskRequest, { action: "edit" | "link" | "change-project" }>) {
    if (pendingRef.current) throw new Error(t("tasks.saving"));
    startMutation();
    try {
      applyResult(await requestTask(request));
      setNotice(t("tasks.saved"));
    } finally { finishMutation(); }
  }

  async function changeRelation(request: TaskRelationRequest) {
    if (pendingRef.current) throw new Error(t("tasks.saving"));
    startMutation();
    try {
      setBoard(await requestTask(request));
      setRelation(null);
      setNotice(t("tasks.relation.saved"));
    } finally { finishMutation(); }
  }

  async function saveColumns(request: Extract<TaskRequest, { action: "set-columns" | "remove-column" }>) {
    if (pendingRef.current) throw new Error(t("tasks.saving"));
    startMutation();
    try {
      setBoard(await requestTask(request));
      setConfiguringColumns(false);
      setNotice(t(request.action === "remove-column" ? "tasks.columnRemoved" : "tasks.columnsSaved"));
    } catch (cause) {
      if (request.action === "remove-column") {
        // A lost response may have committed. Reconcile cards but retain the fixed
        // removal draft/UUID and its visible error until an exact confirmation.
        try { setBoard(await requestTask({ action: "list" })); }
        catch (syncFailure) { throw new Error(`${(cause as Error).message} — ${(syncFailure as Error).message}`); }
      }
      throw cause;
    } finally { finishMutation(); }
  }

  async function saveView(request: Extract<TaskRequest, { action: "save-view" }>) {
    if (pendingRef.current) throw new Error(t("tasks.saving"));
    startMutation();
    try { setBoard(await requestTask(request)); setNotice(t("tasks.view.savedNotice")); }
    finally { finishMutation(); }
  }

  const selectedTask = board?.tasks.find(task => task.id === selectedTaskId);
  const currentTask = board?.tasks.find(task => currentSessionId && task.sessionIds.includes(currentSessionId));
  async function linkCurrentSession() {
    const target = board?.tasks.find(task => task.id === linkTargetId);
    if (!target || !currentSessionId) return;
    try {
      await editTask({ action: "link", id: target.id, expectedRevision: target.revision, sessionIds: [currentSessionId] });
      setLinkTargetId(""); setSelectedTaskId(target.id);
      if (chatActionsRef.current) chatActionsRef.current.open = false;
    } catch (cause) { setError((cause as Error).message); }
  }
  const feedback = <>
    {error && <div ref={feedbackRef} role="alert" className={styles.error}>{error} <button type="button" disabled={disabled} onClick={() => void reload()}>{t("tasks.refresh")}</button>
      {retryMove && <button type="button" disabled={disabled} onClick={() => void submitMove(retryMove)}>{t("tasks.retryMove")}</button>}
      {retryArchive && <button type="button" disabled={disabled} onClick={() => void submitArchive(retryArchive)}>{t("tasks.archive.retry")}</button>}</div>}
    <p role="status" className={styles.notice}>{loading ? t("tasks.loading") : pending ? t("tasks.saving") : notice}</p>
  </>;
  useEffect(() => { if (active && error) feedbackRef.current?.scrollIntoView({ block: "nearest" }); }, [active, error]);

  return (
    <div ref={dashboard} tabIndex={-1} className={styles.dashboard}>
      <header className={styles.header}>
        <div className={styles.heading}><h1>{t("tasks.dashboard")}</h1><span>{board ? visibleTasks.length : ""}</span></div>
        <nav aria-label={t("tasks.navigation")}>
          <button className={styles.primary} type="button" aria-label={t("tasks.new")} disabled={disabled || !board} onClick={() => { setSourceSessionId(null); setCreating(!creating); }} aria-expanded={creating}>＋ {t("tasks.new")}</button>
          <button className={styles.iconButton} type="button" onClick={onClose} aria-label={t("tasks.panel.close")}>✕</button>
        </nav>
      </header>
      <div className={styles.toolbar}>
        <button type="button" aria-label={t("tasks.view.controls")} disabled={!board} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>{t("tasks.view.controls")}{filter.text || filter.project || filter.columnIds.length || filter.priorities.length || filter.labels.length || filter.activity !== "all" || sort !== "manual" ? " •" : ""}</button>
        <button type="button" disabled={disabled || !board} onClick={() => setConfiguringColumns(!configuringColumns)} aria-expanded={configuringColumns}>{t("tasks.columnsSettings")}</button>
        <button type="button" disabled={disabled} onClick={() => void reload()}>{t("tasks.refresh")}</button>
        <div className={styles.toolbarSpacer} />
        {board && <select aria-label={t("tasks.archive.list")} value={archiveScope} disabled={disabled} onChange={event => setArchiveScope(event.target.value as typeof archiveScope)}>
          <option value="active">{t("tasks.archive.active")}</option>
          <option value="archived">{t("tasks.archive.archived")} ({board.tasks.filter(task => task.archived).length})</option>
          <option value="all">{t("tasks.archive.all")}</option>
        </select>}
        {currentSessionId && <details ref={chatActionsRef} className={styles.chatActions} onKeyDown={event => {
          if (event.key === "Escape" && event.currentTarget.open && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
          }
        }}><summary>{t("tasks.panel.currentChat")}</summary><div>
          {currentTask ? <button type="button" disabled={disabled} onClick={() => {
            if (chatActionsRef.current) chatActionsRef.current.open = false;
            setSelectedTaskId(currentTask.id);
          }}>{t("tasks.sessionTask")}: {currentTask.title}</button> : <>
            <button type="button" disabled={disabled} onClick={() => { if (chatActionsRef.current) chatActionsRef.current.open = false; setSourceSessionId(currentSessionId); setCreating(true); }}>{t("tasks.createFromChat")}</button>
            <label>{t("tasks.linkToTask")}<select aria-label={t("tasks.linkToTask")} value={linkTargetId} disabled={disabled} onChange={event => setLinkTargetId(event.target.value)}>
              <option value="">{t("tasks.chooseTask")}</option>
              {board?.tasks.map(task => <option key={task.id} value={task.id}>{task.title}{task.archived ? ` · ${t("tasks.archive.archived")}` : ""}</option>)}
            </select></label>
            <p className={styles.hint}>{t("tasks.linkPolicy")}</p>
            <button type="button" disabled={disabled || !linkTargetId} onClick={() => void linkCurrentSession()}>{t("tasks.linkToTask")}</button>
          </>}
        </div></details>}
      </div>
      <div className={styles.content}>
      {activityError && <p role="status">{t("tasks.activityUnavailable")}</p>}
      {!selectedTask && feedback}
      <div hidden={!filtersOpen}>
      {board && <TaskViewControls board={board} filter={filter} sort={sort} disabled={disabled} newId={newTaskId} onSave={saveView}
        onChange={(nextFilter, nextSort) => { setFilter(nextFilter); setSort(nextSort); }} />}
      </div>
      {board && projection.invalid && <p role="alert" className={styles.error}>{t("tasks.view.invalid")}</p>}
      {board && !projection.invalid && visibleTasks.length === 0 && <p role="status">{t("tasks.view.empty")}</p>}
      {board && sort !== "manual" && <p className={styles.hint}>{t("tasks.view.autoHelp")}</p>}
      {configuringColumns && board && <TaskColumnSettings board={board} disabled={disabled} newId={newTaskId} onSave={saveColumns} onCancel={() => setConfiguringColumns(false)} />}
      {relation && board && <TaskRelation source={relation.source} session={relation.session} tasks={board.tasks} disabled={disabled}
        newOperationId={newTaskId} onSave={changeRelation} onCancel={() => setRelation(null)} />}
      {creating && <form onSubmit={createTask} className={styles.form}>
        <label>{t("tasks.title")}<input autoFocus required maxLength={TASK_TEXT_LIMITS.title} value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending} /></label>
        <label>{t("tasks.description")}<textarea rows={3} maxLength={TASK_TEXT_LIMITS.description} value={description} onChange={(event) => setDescription(event.target.value)} disabled={pending} /></label>
        <label>{t("tasks.criteria")}<textarea rows={3} maxLength={TASK_TEXT_LIMITS.completionCriteria} value={completionCriteria} onChange={(event) => setCompletionCriteria(event.target.value)} disabled={pending} /></label>
        {sourceSessionId ? <p>{t("tasks.sourceSession")}: {sourceSessionId}</p> : <TaskProjectField cwd={cwd} onChange={setCwd} disabled={pending} active={active} />}
        <div className={styles.actions}>
          <button type="submit" disabled={disabled}>{t("tasks.create")}</button>
          <button type="button" disabled={pending} onClick={() => setCreating(false)}>{t("sidebar.cancel")}</button>
        </div>
      </form>}
      {board && <DndContext sensors={sensors} collisionDetection={(args) => { dropPointer.current = args.pointerCoordinates; return taskCollision(args); }}
        accessibility={{ screenReaderInstructions: { draggable: t("tasks.dragHelp") }, announcements: {
          onDragStart: () => t("tasks.dragStarted"), onDragOver: () => undefined,
          onDragEnd: () => t("tasks.dragReleased"), onDragCancel: () => t("tasks.dragCancelled"),
        } }}
        onDragStart={(event) => {
          if (!board || pendingRef.current || loading) return;
          requestVersion.current++; dragBoard.current = board; dragProjection.current = visibleTasks;
          setDragTask(board.tasks.find((task) => task.id === event.active.id) ?? null);
          setNotice(t("tasks.dragStarted"));
        }} onDragEnd={endDrag} onDragCancel={() => { dragBoard.current = null; dragProjection.current = null; setDragTask(null); setNotice(t("tasks.dragCancelled")); }}>
        <div ref={boardScroll} className={styles.boardScroll}><div className={styles.board}>
        {board.columns.map((column) => {
          const tasks = visibleTasks.filter((task) => task.columnId === column.id);
          return <TaskDropColumn key={column.id} id={column.id} label={`${taskColumnName(column, t)} (${tasks.length})`}>
            {tasks.length === 0 && <p className={styles.hint}>{t("tasks.empty")}</p>}
            {tasks.map((task) => <TaskDragCard key={task.id} task={task} disabled={pending || loading} handleLabel={`${t("tasks.dragHandle")}: ${task.title}`}>
              <button type="button" className={styles.cardTitle} aria-expanded={selectedTaskId === task.id} onClick={() => setSelectedTaskId(task.id)}>{task.title}</button>
              <p className={styles.cardProject} title={task.project?.projectRoot}>{task.project?.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? t("tasks.noProject")}</p>
              <div className={styles.cardMeta}>
                <span data-priority={task.priority}>{t(`tasks.priority.${task.priority}`)}</span>
                <span data-task-activity data-working={taskActivity(task, runningIds, activityError) === "working" || undefined}>{`${t("tasks.sessions")} ${task.sessionIds.length}`}{taskActivity(task, runningIds, activityError) === "working" ? ` · ${t("tasks.aiWorking")} ${task.sessionIds.filter(id => runningIds?.has(id)).length}` : ""}{taskActivity(task, runningIds, activityError) === "unknown" ? " · ?" : ""}</span>
              </div>
              {task.archived && <span className={styles.archiveBadge}>{t("tasks.archive.archived")}</span>}
              {task.labels.length > 0 && <ul className={styles.cardLabels}>{task.labels.slice(0, 2).map(label => <li key={label}>{label}</li>)}{task.labels.length > 2 && <li>+{task.labels.length - 2}</li>}</ul>}
            </TaskDragCard>)}
          </TaskDropColumn>;
        })}
      </div></div>
        <DragOverlay dropAnimation={null}>{dragTask && <div data-task-overlay className={styles.overlay} aria-hidden="true">{dragTask.title}</div>}</DragOverlay>
      </DndContext>}
      </div>
      {inspectedTaskIds.map(id => {
        const selectedTask = board?.tasks.find(task => task.id === id);
        if (!selectedTask || !board) return null;
        return <TaskInspector hidden={id !== selectedTaskId} key={selectedTask.id} task={selectedTask} board={board} visibleTasks={visibleTasks} sort={sort} disabled={disabled} panelRef={id === selectedTaskId ? inspector : undefined}
        onClose={() => { setSelectedTaskId(null); dashboard.current?.focus({ preventScroll: true }); }} onMove={moveTask} feedback={id === selectedTaskId ? feedback : null}
        onArchive={() => void submitArchive({ action: "set-archive", id: selectedTask.id, archived: !selectedTask.archived, expectedArchiveRevision: selectedTask.archiveRevision, operationId: newTaskId() })}>
        <TaskDetails task={selectedTask} active={active && id === selectedTaskId} currentSessionId={currentSessionId} disabled={disabled || !!relation}
          onChangeRelation={session => { setSelectedTaskId(null); setRelation({ source: selectedTask, session }); }}
          onLink={editTask} runningIds={activityError ? null : runningIds} sessionActivity={sessionActivity}
          editDraft={editDrafts[selectedTask.id] ?? null} onSave={editTask} onProjectSave={editTask} newOperationId={newTaskId}
          onDraftChange={draft => setEditDrafts(current => {
            const next = { ...current }; if (draft) next[selectedTask.id] = draft; else delete next[selectedTask.id]; return next;
          })} />
      </TaskInspector>;
      })}
      <footer className={styles.footer}>{t("tasks.policy")}</footer>
    </div>
  );
}
