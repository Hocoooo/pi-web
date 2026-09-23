export interface NextCueModelSelection {
  provider: string;
  modelId: string;
}

export interface NextCuePreference {
  enabled: boolean;
  /** null follows the conversation model. */
  model: NextCueModelSelection | null;
}

export const NEXT_CUE_STORAGE_KEY = "pi-web:next-cue";
export const DEFAULT_NEXT_CUE_PREFERENCE: NextCuePreference = { enabled: true, model: null };
const INVALID_PREFERENCE: NextCuePreference = { enabled: false, model: null };

export function parseNextCuePreference(raw: string | null): NextCuePreference {
  if (raw === null) return DEFAULT_NEXT_CUE_PREFERENCE;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return INVALID_PREFERENCE;
    const stored = value as Record<string, unknown>;
    if (typeof stored.enabled !== "boolean") return INVALID_PREFERENCE;
    const model = stored.model;
    if (model === null || model === undefined) return { enabled: stored.enabled, model: null };
    if (typeof model !== "object") return INVALID_PREFERENCE;
    const selection = model as Record<string, unknown>;
    if (typeof selection.provider !== "string" || !selection.provider.trim() || selection.provider.length > 200
      || typeof selection.modelId !== "string" || !selection.modelId.trim() || selection.modelId.length > 200) return INVALID_PREFERENCE;
    return { enabled: stored.enabled, model: { provider: selection.provider, modelId: selection.modelId } };
  } catch {
    return INVALID_PREFERENCE;
  }
}

let preference: NextCuePreference | undefined;
const listeners = new Set<() => void>();

export function getNextCuePreference(): NextCuePreference {
  if (typeof window === "undefined") return DEFAULT_NEXT_CUE_PREFERENCE;
  if (!preference) {
    try {
      preference = parseNextCuePreference(window.localStorage.getItem(NEXT_CUE_STORAGE_KEY));
    } catch {
      preference = INVALID_PREFERENCE;
    }
  }
  return preference;
}

function persist(next: NextCuePreference): void {
  preference = next;
  try {
    window.localStorage.setItem(NEXT_CUE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the preference effective for this tab when storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function setNextCueEnabled(enabled: boolean): void {
  persist({ ...getNextCuePreference(), enabled });
}

export function setNextCueModel(model: NextCueModelSelection | null): void {
  persist({ ...getNextCuePreference(), model });
}

function onStorage(event: StorageEvent): void {
  if (event.key !== NEXT_CUE_STORAGE_KEY && event.key !== null) return;
  preference = undefined;
  listeners.forEach((listener) => listener());
}

export function subscribeNextCuePreference(listener: () => void): () => void {
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
