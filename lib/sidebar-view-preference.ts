export type SidebarViewMode = "current" | "all";

export interface SidebarViewPreference {
  mode: SidebarViewMode;
  collapsedProjects: string[];
}

export const SIDEBAR_VIEW_STORAGE_KEY = "pi-web:sidebar-view";
export const DEFAULT_SIDEBAR_VIEW: SidebarViewPreference = { mode: "current", collapsedProjects: [] };

export function parseSidebarViewPreference(raw: string | null): SidebarViewPreference {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_SIDEBAR_VIEW;
    return {
      mode: value.mode === "all" ? "all" : "current",
      collapsedProjects: Array.isArray(value.collapsedProjects)
        ? [...new Set(value.collapsedProjects.filter((key: unknown): key is string => typeof key === "string"))] as string[]
        : [],
    };
  } catch {
    return DEFAULT_SIDEBAR_VIEW;
  }
}

let preference: SidebarViewPreference | undefined;
const listeners = new Set<() => void>();

export function getSidebarViewPreference(): SidebarViewPreference {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_VIEW;
  if (!preference) {
    try {
      preference = parseSidebarViewPreference(window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY));
    } catch {
      preference = DEFAULT_SIDEBAR_VIEW;
    }
  }
  return preference;
}

function persist(next: SidebarViewPreference): void {
  preference = next;
  try {
    window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Browser preferences still work in memory when storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function setSidebarViewMode(mode: SidebarViewMode): void {
  persist({ ...getSidebarViewPreference(), mode });
}

export function setSidebarProjectCollapsed(key: string, collapsed: boolean): void {
  const current = getSidebarViewPreference();
  if (current.collapsedProjects.includes(key) === collapsed) return;
  persist({
    ...current,
    collapsedProjects: collapsed
      ? [...current.collapsedProjects, key]
      : current.collapsedProjects.filter((entry) => entry !== key),
  });
}

function onStorage(event: StorageEvent): void {
  if (event.key !== SIDEBAR_VIEW_STORAGE_KEY && event.key !== null) return;
  preference = undefined;
  listeners.forEach((listener) => listener());
}

export function subscribeSidebarView(listener: () => void): () => void {
  if (listeners.size === 0) {
    // Re-read in case another tab changed storage while no sidebar was mounted.
    preference = undefined;
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}
