import { parseNextCuePreference, type NextCueModelSelection } from "./next-cue-preference";

export type DraftCompletionModel = NextCueModelSelection;
export interface DraftCompletionPreference {
  enabled: boolean;
  /** null follows the composer model, not the Next Cue preference. */
  model: DraftCompletionModel | null;
}

export const DRAFT_COMPLETION_STORAGE_KEY = "pi-web:draft-completion";
export const DEFAULT_DRAFT_COMPLETION_PREFERENCE: DraftCompletionPreference = { enabled: false, model: null };

export function parseDraftCompletionPreference(raw: string | null): DraftCompletionPreference {
  // Reuse the validated shape, never Next Cue's default-on policy.
  return raw === null ? DEFAULT_DRAFT_COMPLETION_PREFERENCE : parseNextCuePreference(raw);
}

let preference: DraftCompletionPreference | undefined;
const listeners = new Set<() => void>();

export function getDraftCompletionPreference(): DraftCompletionPreference {
  if (typeof window === "undefined") return DEFAULT_DRAFT_COMPLETION_PREFERENCE;
  if (!preference) {
    try {
      preference = parseDraftCompletionPreference(window.localStorage.getItem(DRAFT_COMPLETION_STORAGE_KEY));
    } catch {
      preference = DEFAULT_DRAFT_COMPLETION_PREFERENCE;
    }
  }
  return preference;
}

function persist(next: DraftCompletionPreference): void {
  preference = next;
  try {
    window.localStorage.setItem(DRAFT_COMPLETION_STORAGE_KEY, JSON.stringify(next));
  } catch { /* Keep explicit consent effective in this tab if storage is unavailable. */ }
  listeners.forEach((listener) => listener());
}

export function setDraftCompletionEnabled(enabled: boolean): void {
  persist({ ...getDraftCompletionPreference(), enabled });
}

export function setDraftCompletionModel(model: DraftCompletionModel | null): void {
  persist({ ...getDraftCompletionPreference(), model });
}

function onStorage(event: StorageEvent): void {
  if (event.key !== DRAFT_COMPLETION_STORAGE_KEY && event.key !== null) return;
  preference = undefined;
  listeners.forEach((listener) => listener());
}

export function subscribeDraftCompletionPreference(listener: () => void): () => void {
  if (listeners.size === 0) {
    preference = undefined;
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}
