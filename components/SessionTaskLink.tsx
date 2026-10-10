"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskSessionTaskResult } from "@/lib/task-types";

/** Metadata only: no session hydration, context polling or Agent command. */
export function SessionTaskLink({ sessionId, onOpen }: { sessionId: string; onOpen: (taskId?: string) => void }) {
  const { t } = useI18n();
  const [task, setTask] = useState<TaskSessionTaskResult["task"]>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let disposed = false;
    let request: AbortController | undefined;
    async function refresh() {
      request?.abort();
      const current = new AbortController();
      request = current;
      try {
        const response = await fetch("/api/tasks", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "session-task", sessionId }), signal: current.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as TaskSessionTaskResult;
        if (!disposed && !current.signal.aborted) { setTask(data.task); setState("ready"); }
      } catch {
        if (!disposed && !current.signal.aborted) { setTask(null); setState("error"); }
      }
    }
    const wake = () => { if (document.visibilityState === "visible") void refresh(); };
    void refresh();
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pi-web:tasks-changed", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true; request?.abort();
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pi-web:tasks-changed", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [sessionId]);
  return <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-sm" data-session-task>
    <button type="button" className="min-w-0 break-words text-left text-text-muted hover:text-text" onClick={() => onOpen(state === "ready" ? task?.id : undefined)}>
      {state === "loading" ? t("tasks.loading") : state === "error" ? t("tasks.membershipUnavailable")
        : task ? `${t("tasks.sessionTask")}: ${task.title}${task.archived ? ` · ${t("tasks.archive.archived")}` : ""}` : t("tasks.linkToTask")}
    </button>
  </div>;
}
