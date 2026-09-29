"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_DRAFT_COMPLETION_PREFERENCE,
  getDraftCompletionPreference,
  setDraftCompletionEnabled,
  setDraftCompletionModel,
  subscribeDraftCompletionPreference,
} from "@/lib/draft-completion-preference";

export function useDraftCompletionPreference() {
  const preference = useSyncExternalStore(
    subscribeDraftCompletionPreference,
    getDraftCompletionPreference,
    () => DEFAULT_DRAFT_COMPLETION_PREFERENCE,
  );
  return { ...preference, setDraftCompletionEnabled, setDraftCompletionModel };
}
