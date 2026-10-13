import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import { generateSessionTitle, type GeneratedSessionTitle, type TitleGenerationOptions } from "./session-title";

export const AUTO_TITLE_TYPE = "pi-web:auto-title";
const AUTOMATIC_TITLE_TIMEOUT_MS = 15_000;

type TitleEntry = {
  type: string;
  id?: string;
  name?: string;
  customType?: string;
  data?: unknown;
  message?: { role: string; stopReason?: string; content?: unknown };
};

export interface SessionTitleState {
  enabled: boolean;
  title: string;
  source: "manual" | "generated" | "legacy";
}

/** Session-wide, not branch-local: a manual rename on any branch locks the name. */
export function readSessionTitleState(entries: readonly TitleEntry[], name?: string): SessionTitleState {
  const title = name ?? "";
  let nameIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].type === "session_info") {
      nameIndex = index;
      break;
    }
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== AUTO_TITLE_TYPE) continue;
    const data = entry.data as Partial<SessionTitleState> & { version?: unknown } | null;
    if (!data || data.version !== 1 || typeof data.enabled !== "boolean" || typeof data.title !== "string"
      || !["manual", "generated", "legacy"].includes(data.source ?? "")) {
      return { enabled: false, title, source: "legacy" };
    }
    // Another extension/CLI may have renamed it since our metadata was written,
    // even to the same text. Never mistake that manual write for our own title.
    if (nameIndex > index || data.title !== title) return { enabled: false, title, source: "manual" };
    return { enabled: data.enabled, title, source: data.source! };
  }
  return { enabled: !title && nameIndex < 0, title, source: "legacy" };
}

/** Metadata may move the SDK leaf, but must not invalidate an otherwise unchanged cue. */
export function isTitleOnlyLeafChange(branch: readonly TitleEntry[], leafId: string): boolean {
  const index = branch.findIndex((entry) => entry.id === leafId);
  return index >= 0 && branch.slice(index + 1).every((entry) => entry.type === "session_info"
    || (entry.type === "custom" && entry.customType === AUTO_TITLE_TYPE));
}

export function persistSessionTitleState(manager: SessionManager, state: SessionTitleState): void {
  manager.appendCustomEntry(AUTO_TITLE_TYPE, { version: 1, ...state });
}

export function setSessionAutoTitleEnabled(manager: SessionManager, enabled: boolean): SessionTitleState {
  const state = { ...readSessionTitleState(manager.getEntries(), manager.getSessionName()), enabled };
  persistSessionTitleState(manager, state);
  return state;
}

export function renameSessionTitle(manager: SessionManager, title: string): SessionTitleState {
  manager.appendSessionInfo(title);
  const state: SessionTitleState = { enabled: false, title, source: "manual" };
  persistSessionTitleState(manager, state);
  return state;
}

/** Only a new, normally completed text reply qualifies, never an old reply after a failed run. */
export function latestSuccessfulTitleReply(entries: readonly TitleEntry[]): string | undefined {
  let sawReply: string | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") return sawReply;
    if (message.role !== "assistant" || sawReply) continue;
    if (message.stopReason !== "stop" || !Array.isArray(message.content)
      || !message.content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim())) return undefined;
    sawReply = entry.id;
  }
  return undefined;
}

type TitleHost = {
  session: AgentSessionLike;
  isAlive: () => boolean;
  isRunning: () => boolean;
  onChanged: (state: SessionTitleState) => void;
  generate?: (session: AgentSessionLike, options: TitleGenerationOptions) => Promise<GeneratedSessionTitle>;
};

export class StaleSessionTitleError extends Error {
  readonly code = "STALE_SESSION_TITLE";
  constructor() { super("The session changed while its title was being generated. Please try again."); }
}

// Wrappers survive dev HMR; their Error constructor can belong to an older module.
export function isStaleSessionTitleError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "STALE_SESSION_TITLE";
}

/** Owns cancellation and compare-before-write for both automatic and explicit generation. */
export class AutoSessionTitleController {
  private request: AbortController | null = null;
  private lastAttemptedReply: string | undefined;
  private runStartReply: string | undefined;
  private stopped = false;

  constructor(private readonly host: TitleHost) {}

  private get manager() { return this.host.session.sessionManager; }

  getState(): SessionTitleState {
    return readSessionTitleState(this.manager.getEntries(), this.manager.getSessionName());
  }

  cancel(): void {
    this.request?.abort();
    this.request = null;
  }

  beginRun(): void {
    this.cancel();
    this.stopped = false;
    this.runStartReply = latestSuccessfulTitleReply(this.manager.getBranch());
  }

  stopRun(): void {
    this.stopped = true;
    this.cancel();
  }

  rename(title: string): void {
    this.cancel();
    this.host.onChanged(renameSessionTitle(this.manager, title));
  }

  setEnabled(enabled: boolean): SessionTitleState {
    this.cancel();
    const state = setSessionAutoTitleEnabled(this.manager, enabled);
    this.host.onChanged(state);
    return state;
  }

  completeRun(): void {
    if (this.stopped || !this.host.isAlive() || this.host.isRunning() || !this.getState().enabled) return;
    const reply = latestSuccessfulTitleReply(this.manager.getBranch());
    if (!reply || reply === this.runStartReply || reply === this.lastAttemptedReply) return;
    this.lastAttemptedReply = reply;
    // Optional work must never delay prompt_done, extend the busy state, or
    // leak provider errors/credentials into a user's main conversation.
    void this.generate(true).catch(() => {});
  }

  async generate(automatic = false, externalSignal?: AbortSignal): Promise<GeneratedSessionTitle> {
    this.cancel();
    const controller = new AbortController();
    this.request = controller;
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const state = this.getState();
    const leaf = this.manager.getLeafId();
    const sessionId = this.host.session.sessionId;
    const generate = this.host.generate ?? ((session, options) => generateSessionTitle(session as unknown as AgentSession, options));
    try {
      const result = await generate(this.host.session, {
        signal,
        ...(automatic ? { previousTitle: state.title, timeoutMs: AUTOMATIC_TITLE_TIMEOUT_MS } : {}),
      });
      const current = this.getState();
      if (signal.aborted || !this.host.isAlive() || this.host.session.sessionId !== sessionId
        || this.manager.getLeafId() !== leaf || current.title !== state.title || current.enabled !== state.enabled
        || (automatic && this.host.isRunning())) throw new StaleSessionTitleError();
      if (result.title !== current.title) {
        this.manager.appendSessionInfo(result.title);
        const next: SessionTitleState = { ...current, title: result.title, source: "generated" };
        persistSessionTitleState(this.manager, next);
        this.host.onChanged(next);
      }
      return result;
    } catch (error) {
      if (signal.aborted || !this.host.isAlive()) throw new StaleSessionTitleError();
      throw error;
    } finally {
      if (this.request === controller) this.request = null;
    }
  }
}
