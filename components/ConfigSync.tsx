"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ConfigSyncResult, ConfigSyncStatus } from "@/lib/config-sync-types";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailStack,
  ConfigField,
} from "./SettingsUi";
import styles from "./ConfigSync.module.css";

class ConfigSyncRequestError extends Error {
  constructor(message: string, readonly applied = false) { super(message); }
}

async function requestConfigSync<T>(method: "GET" | "PUT" | "POST", body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/config-sync", {
    method,
    signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new ConfigSyncRequestError(data.error ?? `HTTP ${response.status}`, data.applied === true);
  return data as T;
}

type BusyAction = "load" | "save" | "push" | "pull" | "reload";

/** Global binding only. Opening this pane reads status; every write/sync/reload is explicit. */
export function ConfigSync({ sessionId, onReloaded }: { sessionId: string | null; onReloaded: () => void }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<ConfigSyncStatus | null>(null);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState<BusyAction | null>("load");
  const inFlight = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<{ message: string; applied: boolean } | null>(null);
  const [result, setResult] = useState<{ action: "push" | "pull"; data: ConfigSyncResult } | null>(null);
  const [saved, setSaved] = useState(false);
  const [reloadPending, setReloadPending] = useState(false);
  const [reloaded, setReloaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setBusy("load");
    setError(null);
    void requestConfigSync<ConfigSyncStatus>("GET", undefined, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setStatus(data);
      setRepository(data.repository);
      setBranch(data.branch || "main");
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError({ message: cause instanceof Error ? cause.message : String(cause), applied: false });
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(null);
    });
    return () => controller.abort();
  }, [loadAttempt]);

  const dirty = status !== null && (repository !== status.repository || branch !== status.branch);
  const canSave = !!status && !!repository.trim() && trusted && dirty && !busy;
  const canSync = !!status?.repository && !dirty && !busy;
  const busyText = busy ? {
    load: t("configSync.loading"), save: t("configSync.saving"),
    push: t("configSync.pushing"), pull: t("configSync.pulling"), reload: t("configSync.reloading"),
  }[busy] : null;

  function draftChanged() {
    setTrusted(false);
    setSaved(false);
  }

  async function run(action: Exclude<BusyAction, "load">) {
    if (inFlight.current || busy) return;
    if ((action === "save" && !canSave) || ((action === "push" || action === "pull") && !canSync)) return;
    if (action === "reload" && (!sessionId || !reloadPending)) return;
    inFlight.current = true;
    setBusy(action);
    setError(null);
    setSaved(false);
    setResult(null);
    try {
      if (action === "save") {
        const data = await requestConfigSync<ConfigSyncStatus>("PUT", { repository: repository.trim(), branch: branch.trim() || "main", trusted: true });
        setStatus(data);
        setRepository(data.repository);
        setBranch(data.branch);
        setSaved(true);
      } else if (action === "reload") {
        await sendAgentCommand(sessionId!, { type: "reload" });
        setReloadPending(false);
        setReloaded(true);
        onReloaded();
      } else {
        const data = await requestConfigSync<ConfigSyncResult>("POST", { action });
        setStatus(data);
        setResult({ action, data });
        if (action === "pull") {
          setReloadPending(true);
          setReloaded(false);
        }
      }
    } catch (cause) {
      // In particular, never replace a failed Save's repository, branch or consent draft.
      setError({ message: cause instanceof Error ? cause.message : String(cause), applied: cause instanceof ConfigSyncRequestError && cause.applied });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function save(event: FormEvent) { event.preventDefault(); void run("save"); }

  return <section className={styles.panel} aria-label={t("settings.configSync")} aria-busy={!!busy}>
    <ConfigDetail>
      <ConfigDetailStack className={styles.stack}>
        {busyText && <p role="status" className={styles.hint}>{busyText}</p>}
        {error && <div role="alert" className={styles.error}>
          <p>{error.message}</p>
          {error.applied && <p>{t("configSync.appliedWarning")}</p>}
          {!status && <ConfigButton disabled={!!busy} onClick={() => setLoadAttempt((value) => value + 1)}>{t("configSync.retry")}</ConfigButton>}
        </div>}
        {status && <>
          <form onSubmit={save} className={styles.form}>
            <ConfigField label={t("configSync.repository")}>
              <input aria-label={t("configSync.repository")} className={styles.input}
                value={repository} placeholder="https://github.com/user/pi-config.git" required disabled={!!busy}
                spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
                onChange={(event) => { setRepository(event.target.value); draftChanged(); }} />
            </ConfigField>
            <ConfigField label={t("configSync.branch")}>
              <input aria-label={t("configSync.branch")} className={styles.input} value={branch} placeholder="main" disabled={!!busy}
                spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
                onChange={(event) => { setBranch(event.target.value); draftChanged(); }} />
            </ConfigField>
            {(!status.repository || dirty) && <label className={styles.consent}>
              <input type="checkbox" checked={trusted} disabled={!!busy} onChange={(event) => setTrusted(event.target.checked)} />
              <span>{t("configSync.trust")}</span>
            </label>}
            <ConfigDetailActions>
              <ConfigButton type="submit" variant="primary" disabled={!canSave}>{t("configSync.save")}</ConfigButton>
              <ConfigButton type="button" disabled={!canSync} onClick={() => void run("push")}>{t("configSync.push")}</ConfigButton>
              <ConfigButton type="button" disabled={!canSync} onClick={() => void run("pull")}>{t("configSync.pull")}</ConfigButton>
            </ConfigDetailActions>
          </form>
          {saved && !dirty && <p role="status">{t("configSync.saved")}</p>}
          {result && <p role="status">
            {t(result.action === "push" ? "configSync.pushSuccess" : "configSync.pullSuccess")} · {result.data.changed
              ? t("configSync.counts", { files: result.data.files, packages: result.data.packages }) : t("configSync.noChanges")}
          </p>}
          {status.lastSync && <p className={styles.hint}>
            <time dateTime={status.lastSync.at}>{new Date(status.lastSync.at).toLocaleString(locale)}</time>
            {" · "}<code title={status.lastSync.commit}>{status.lastSync.commit.slice(0, 8)}</code>
          </p>}
        </>}
        {reloadPending && <div className={styles.result}>
          {sessionId ? <ConfigButton disabled={!!busy} onClick={() => void run("reload")}>{t("configSync.reloadSession")}</ConfigButton>
            : <p role="status">{t("configSync.reloadNeeded")}</p>}
        </div>}
        {reloaded && <p role="status" className={styles.hint}>{t("configSync.reloaded")}</p>}
      </ConfigDetailStack>
    </ConfigDetail>
  </section>;
}
