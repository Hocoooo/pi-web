"use client";

import { createContext } from "react";

/** Task actions must select the live shell's chat, not merely rewrite its URL. */
export const TaskPanelNavigation = createContext<((href: string) => Promise<void>) | null>(null);
