"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_SIDEBAR_VIEW, getSidebarViewPreference, subscribeSidebarView } from "@/lib/sidebar-view-preference";

export function useSidebarView() {
  return useSyncExternalStore(subscribeSidebarView, getSidebarViewPreference, () => DEFAULT_SIDEBAR_VIEW);
}
