"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_NEXT_CUE_PREFERENCE,
  getNextCuePreference,
  setNextCueEnabled,
  setNextCueModel,
  subscribeNextCuePreference,
} from "@/lib/next-cue-preference";

export function useNextCuePreference() {
  const preference = useSyncExternalStore(
    subscribeNextCuePreference,
    getNextCuePreference,
    () => DEFAULT_NEXT_CUE_PREFERENCE,
  );
  return { ...preference, setNextCueEnabled, setNextCueModel };
}
