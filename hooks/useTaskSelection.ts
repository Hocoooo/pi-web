"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TaskPickerItem } from "@/components/TaskPicker";
import type { TaskRelationRequest, TaskPickerResult as PickerSnapshot } from "@/lib/task-types";
type SelectionWrite = TaskRelationRequest | {action: "link"; id: string; expectedRevision: number; sessionIds: string[]};

// Pi Web also runs on ordinary LAN HTTP, where randomUUID is unavailable.
function operationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function request<T>(body: object): Promise<T> {
  const response = await fetch("/api/tasks", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

/** A task is management metadata. Only a selected/inherited task participates in
 * creation; ordinary prompts never read the task store. ChatWindow remounts per draft. */
export function useTaskSelection(sessionId: RefObject<string | null>, cwd: string | null, initialTask: TaskPickerItem | null = null) {
  const [isOpen, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PickerSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingTask, setPendingTask] = useState<TaskPickerItem | null>(initialTask);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const pending = useRef<TaskPickerItem | null>(initialTask);
  const pendingWrite = useRef<SelectionWrite | null>(null);
  const choiceWrite = useRef<{sessionId: string; target: string | null; request: SelectionWrite} | null>(null);
  const loadGeneration = useRef(0);
  const syncFlight = useRef<Promise<void> | null>(null);
  const choiceFlight = useRef<Promise<void> | null>(null);
  const choiceGeneration = useRef(0);
  useEffect(() => () => { loadGeneration.current++; }, []);
  const close = useCallback(() => { loadGeneration.current++; setOpen(false); }, []);
  const open = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setOpen(true); setSnapshot(null); setLoadError(null); choiceWrite.current = null;
    try {
      const result = await request<PickerSnapshot>({action: "task-picker", ...(sessionId.current ? {sessionId: sessionId.current} : {cwd})});
      if (generation === loadGeneration.current) setSnapshot(result);
    } catch (cause) {
      if (generation === loadGeneration.current) setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [cwd, sessionId]);
  const syncPending = useCallback(async (id: string) => {
    if (syncFlight.current) return syncFlight.current;
    const task = pending.current;
    if (!task) return;
    const operation = (async () => {
      if (!pendingWrite.current) {
        const current = await request<PickerSnapshot>({action: "task-picker", sessionId: id});
        const target = current.tasks.find(item => item.id === task.id);
        if (!target) throw new Error("Selected task is no longer available for this session. Choose a task again.");
        if (current.relation?.sourceTaskId && current.relation.sourceTaskId !== target.id) throw new Error("Session already belongs to another task. Choose a task again.");
        pendingWrite.current = {action: "link", id: target.id, expectedRevision: target.revision, sessionIds: [id]};
      }
      await request(pendingWrite.current);
      pending.current = null; pendingWrite.current = null; setPendingTask(task);
      window.dispatchEvent(new Event("pi-web:tasks-changed"));
    })();
    syncFlight.current = operation;
    try { await operation; setBindingError(null); }
    catch (cause) { setBindingError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { syncFlight.current = null; }
  }, []);
  const applyChoice = useCallback(async (task: TaskPickerItem | null) => {
    const inFlight = syncFlight.current;
    // A choice during creation must observe the completed binding's owner.
    if (inFlight) await inFlight.catch(() => {});
    const id = sessionId.current;
    if (!id) {
      pending.current = task; pendingWrite.current = null; setPendingTask(task);
      return;
    }
    const targetId = task?.id ?? null;
    if (choiceWrite.current?.sessionId !== id || choiceWrite.current.target !== targetId) {
      const replacingFailedChoice = choiceWrite.current !== null;
      // A different choice is not a retry. The old request may have committed
      // despite a lost response, so read its real outcome before a no-op/unlink.
      const current = !inFlight && !replacingFailedChoice && snapshot?.relation?.sessionId === id ? snapshot : await request<PickerSnapshot>({action: "task-picker", sessionId: id});
      choiceWrite.current = null;
      const relation = current.relation;
      if (!relation) throw new Error("Session relationship unavailable. Reopen the picker.");
      const target = targetId ? current.tasks.find(item => item.id === targetId) : null;
      if (targetId && !target) throw new Error("Task is outside this session's project. Choose a task again.");
      if (relation.sourceTaskId !== targetId) {
        const mutation: SelectionWrite = relation.sourceTaskId
          ? {action: "change-session-relation", sessionId: id, sourceTaskId: relation.sourceTaskId, targetTaskId: targetId,
            expectedGeneration: relation.generation, expectedUpdateRevision: relation.updateRevision, operationId: operationId()}
          : {action: "link", id: target!.id, expectedRevision: target!.revision, sessionIds: [id]};
        choiceWrite.current = {sessionId: id, target: targetId, request: mutation};
      }
    }
    if (choiceWrite.current) await request(choiceWrite.current.request);
    pending.current = null; pendingWrite.current = null; choiceWrite.current = null; setPendingTask(task); setBindingError(null);
    window.dispatchEvent(new Event("pi-web:tasks-changed"));
  }, [sessionId, snapshot]);
  const choose = useCallback(async (task: TaskPickerItem | null) => {
    choiceGeneration.current++;
    const flight = applyChoice(task);
    choiceFlight.current = flight;
    try { await flight; }
    finally {
      choiceGeneration.current++;
      if (choiceFlight.current === flight) choiceFlight.current = null;
    }
  }, [applyChoice]);
  // /new takes one snapshot, never a live link to the source session. Read the
  // real owner rather than the last picker snapshot (which may be stale).
  const taskForNewSession = useCallback(async (): Promise<TaskPickerItem | null> => {
    for (;;) {
      const generation = choiceGeneration.current;
      await choiceFlight.current?.catch(() => {});
      await syncFlight.current?.catch(() => {});
      if (generation !== choiceGeneration.current) continue;
      const id = sessionId.current;
      if (!id) return pending.current;
      const current = await request<PickerSnapshot>({action: "task-picker", sessionId: id});
      if (generation !== choiceGeneration.current) continue;
      if (!current.relation) throw new Error("Session relationship unavailable. Try /new again.");
      const owner = current.relation.sourceTaskId;
      // A real owner wins over a retained, failed initial selection. An unbound
      // warm composer can still carry its explicit pending choice into /new.
      if (!owner) return pending.current;
      const task = current.tasks.find(item => item.id === owner);
      if (!task) throw new Error("Current task is no longer available for this session.");
      return task;
    }
  }, [sessionId]);
  return {isOpen, snapshot, loadError, pendingTask, bindingError, selectedId: snapshot?.relation ? snapshot.relation.sourceTaskId : pendingTask?.id ?? null, open, close, choose, syncPending, taskForNewSession};
}
