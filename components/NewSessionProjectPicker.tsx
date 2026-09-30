"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getRecentProjects, type RecentProject } from "@/lib/project-groups";
import { CHAT_WORKSPACE_KEY } from "@/lib/session-kind";
import type { SessionInfo } from "@/lib/types";
import { DirectoryPicker } from "./DirectoryPicker";

/** Sentinel for the "no project, chat only" entry; never a real path. */
const CHAT_ONLY_OPTION = "__pi-web-chat-only__";

export function NewSessionProjectPicker({ cwd, onChange, isChat = false }: {
  cwd: string;
  onChange: (cwd: string, projectKey: string) => void;
  /** Independent chat: the reserved workspace is selected and shown as "no project". */
  isChat?: boolean;
}) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void fetch("/api/sessions", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { sessions?: SessionInfo[] } | null) => {
        if (mounted.current) setProjects(getRecentProjects(data?.sessions ?? []));
      })
      .catch(() => {}); // Directory browsing remains available if recent projects cannot load.
    return () => { mounted.current = false; controller.abort(); };
  }, []);

  async function select(candidate: string) {
    if (pending.current) return;
    if (candidate === cwd) { setBrowse(false); return; }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (candidate === CHAT_ONLY_OPTION) {
        // Independent chat uses the reserved workspace, so the server owns the path.
        const response = await fetch("/api/default-cwd", { method: "POST" });
        const data = await response.json() as { cwd?: string; projectKey?: string; error?: string };
        if (!response.ok || data.error || !data.cwd) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (mounted.current) onChange(data.cwd, data.projectKey ?? CHAT_WORKSPACE_KEY);
        return;
      }
      const response = await fetch("/api/cwd/validate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: candidate }),
      });
      const data = await response.json();
      if (!response.ok || data.error || !data.cwd || !data.projectKey) throw new Error(data.error ?? `HTTP ${response.status}`);
      // Sending the first message removes this picker; never change a started session.
      if (mounted.current) onChange(data.cwd, data.projectKey);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="shrink-0 border-b border-border px-4 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <label className="shrink-0 text-text-muted" htmlFor="new-session-project">{t("chat.sessionProject")}</label>
        <select id="new-session-project" aria-label={t("chat.sessionProject")} title={isChat ? t("chat.noProjectChatOnly") : cwd} value={isChat ? CHAT_ONLY_OPTION : cwd}
          disabled={busy} onChange={(event) => void select(event.target.value)}
          className="min-w-0 flex-1 rounded border border-border bg-bg-panel px-2 py-1 text-text">
          {!isChat && <option value={cwd}>{cwd}</option>}
          <option value={CHAT_ONLY_OPTION}>{t("chat.noProject")}</option>
          {projects.filter((project) => project.root !== cwd && project.key !== CHAT_WORKSPACE_KEY).map((project) => <option key={project.key} value={project.root}>{project.root}</option>)}
        </select>
        <button type="button" disabled={busy} onClick={() => { setError(null); setBrowse(true); }}
          className="shrink-0 rounded border border-border px-2 py-1 text-text-muted hover:bg-bg-hover">{t("chat.chooseProjectDirectory")}</button>
      </div>
      {error && !browse && <div role="alert" className="mt-1 text-sm text-red-400">{error}</div>}
      {browse && <DirectoryPicker initialPath={cwd} busy={busy} error={error} onCancel={() => { if (!busy) setBrowse(false); }} onSelect={(path) => void select(path)} />}
    </div>
  );
}
