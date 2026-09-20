"use client";

import { useEffect, useRef, useState, type AnchorHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { parsePdfPageFragment, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { useI18n } from "@/hooks/useI18n";

interface Props extends AnchorHTMLAttributes<HTMLAnchorElement> {
  filePath: string;
  sessionId?: string;
  onOpenFile: (filePath: string, page?: number) => void;
}

export function LocalFileLink({ filePath, sessionId, onOpenFile, children, ...props }: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!menu) return;
    if (busy) menuRef.current?.focus();
    else menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target)
        || (event.type === "contextmenu" && linkRef.current?.contains(event.target)))) return;
      setMenu(null);
    };
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      setMenu(null);
      if (event.key === "Escape") {
        event.preventDefault();
        linkRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("contextmenu", dismiss);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("contextmenu", dismiss);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menu, busy]);

  const run = async (action: "open" | "reveal") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/files/desktop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, sessionId, action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setMenu(null);
      linkRef.current?.focus();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("files.desktopFailed"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <>
    <a {...props} ref={linkRef}
      onClick={(event) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        onOpenFile(filePath, parsePdfPageFragment(props.href) ?? undefined);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX || rect.left;
        const y = event.clientY || rect.bottom;
        setError(null);
        setMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 296)), y: Math.max(8, Math.min(y, window.innerHeight - 210)) });
      }}
    >{children}</a>
    {menu && createPortal(
      <div ref={menuRef} className="local-file-menu" role="menu" tabIndex={-1} aria-label={t("files.desktopMenu")} aria-busy={busy}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }
        }}
        style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 10000, width: 280, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)", overflow: "auto", padding: 6, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 8px 24px #0004", fontSize: 13 }}>
        {(["open", "reveal"] as const).map((action) => <button key={action} type="button" role="menuitem" disabled={busy}
          onClick={() => void run(action)}
          style={{ display: "block", width: "100%", padding: "9px 10px", border: 0, borderRadius: 4, textAlign: "left", color: "inherit", cursor: busy ? "wait" : "pointer" }}
        >{t(action === "open" ? "files.openDefaultApp" : "files.revealInFolder")}</button>)}
        {busy && <div role="status" style={{ padding: "4px 10px" }}>{t("files.desktopOpening")}</div>}
        {error && <div role="alert" style={{ padding: "6px 10px", color: "var(--text-muted)", overflowWrap: "anywhere" }}>{t("files.desktopFailed")}: {error}</div>}
      </div>, document.body,
    )}
  </>;
}
