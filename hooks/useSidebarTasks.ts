"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskCatalog } from "@/lib/task-catalog-types";

/** One metadata snapshot for the entire sidebar. Failures never erase ownership. */
export function useSidebarTasks(refreshKey = 0) {
  const [catalog, setCatalog] = useState<TaskCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setLoading(true);
    try {
      const response = await fetch("/api/tasks/catalog", { signal: current.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as TaskCatalog;
      if (!Array.isArray(data.tasks)) throw new Error("Invalid task catalog");
      if (!current.signal.aborted) { setCatalog(data); setFailed(false); }
    } catch {
      if (!current.signal.aborted) setFailed(true);
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const wake = () => { if (document.visibilityState === "visible") void reload(); };
    void reload();
    window.addEventListener("pi-web:tasks-changed", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      request.current?.abort();
      window.removeEventListener("pi-web:tasks-changed", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [reload, refreshKey]);
  const membershipVersion = useMemo(() => catalog ? JSON.stringify(catalog.tasks.map(task => [task.id, task.sessionIds])) : "", [catalog]);
  return { catalog, loading, failed, reload, membershipVersion };
}
