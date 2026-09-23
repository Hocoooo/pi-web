export type SessionPanel = "sidebar" | "chat";

/** Exact modifiers avoid stealing AltGr, word selection, or IME keystrokes. */
export function getSessionPanelShortcut(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}): SessionPanel | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return null;
  if (event.key === "ArrowLeft") return "sidebar";
  if (event.key === "ArrowRight") return "chat";
  return null;
}
