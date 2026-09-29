"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useDraftCompletionPreference } from "./useDraftCompletionPreference";
import type { DraftCompletionModel } from "@/lib/draft-completion-preference";

export interface DraftCompletionContext {
  sessionId: string | null;
  leafId: string | null;
}

interface Options {
  textarea: RefObject<HTMLTextAreaElement | null>;
  value: string;
  cwd?: string | null;
  context?: DraftCompletionContext;
  model?: DraftCompletionModel | null;
  disabled: boolean;
}

/** Owns optional requests only. The accepted suffix must still go through the composer's draft setter. */
export function useDraftCompletion({ textarea, value, cwd, context, model, disabled }: Options) {
  const preference = useDraftCompletionPreference();
  const selection = preference.model ?? model;
  const [interaction, setInteraction] = useState({ focused: false, composing: false, atEnd: false });
  const [result, setResult] = useState<{ key: string; text: string } | null>(null);
  const [suppressedKey, setSuppressedKey] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const completedKeyRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const keyFor = useCallback((draft: string) => JSON.stringify([
    cwd, context?.sessionId, context?.leafId, selection?.provider, selection?.modelId, draft,
  ]), [cwd, context?.sessionId, context?.leafId, selection?.provider, selection?.modelId]);
  const key = keyFor(value);
  const eligible = preference.enabled && !disabled && !!cwd && !!context && !!selection
    && interaction.focused && interaction.atEnd && !interaction.composing
    && Array.from(value.trim()).length >= 4 && value.length <= 8000
    && !/^[!/]/u.test(value.trimStart()) && key !== suppressedKey;

  // Native listeners cover imperative restores, selection changes, window blur,
  // and IME before a passive request effect has a chance to run.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const sample = () => {
      const next = {
        focused: document.activeElement === el && document.visibilityState !== "hidden" && document.hasFocus(),
        composing: composingRef.current,
        atEnd: el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length,
      };
      if (!next.focused || !next.atEnd || next.composing) {
        controllerRef.current?.abort();
        setResult(null);
      }
      setInteraction((old) => old.focused === next.focused && old.composing === next.composing && old.atEnd === next.atEnd ? old : next);
    };
    const start = () => { composingRef.current = true; sample(); };
    const end = () => { composingRef.current = false; sample(); };
    const blur = () => {
      controllerRef.current?.abort();
      setResult(null);
      setInteraction((old) => ({ ...old, focused: false }));
    };
    for (const event of ["focus", "select", "keyup", "click"]) el.addEventListener(event, sample);
    el.addEventListener("blur", blur);
    el.addEventListener("compositionstart", start);
    el.addEventListener("compositionend", end);
    document.addEventListener("selectionchange", sample);
    document.addEventListener("visibilitychange", sample);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", sample);
    sample();
    return () => {
      for (const event of ["focus", "select", "keyup", "click"]) el.removeEventListener(event, sample);
      el.removeEventListener("blur", blur);
      el.removeEventListener("compositionstart", start);
      el.removeEventListener("compositionend", end);
      document.removeEventListener("selectionchange", sample);
      document.removeEventListener("visibilitychange", sample);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", sample);
    };
  }, [textarea, value]);

  useEffect(() => {
    setResult(null);
    if (!eligible || !context || !selection || completedKeyRef.current === key) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const { sessionId, leafId } = context;
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      void fetch("/api/draft-completion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, sessionId, leafId, draft: value, model: selection }),
        signal: controller.signal,
      }).then(async (response) => {
        if (controller.signal.aborted) return;
        // No auto-retries for an unchanged draft (including failures/204).
        completedKeyRef.current = key;
        if (!response.ok || response.status === 204) return;
        const data: unknown = await response.json();
        if (!data || typeof data !== "object") return;
        const reply = data as { text?: unknown; leafId?: unknown };
        const el = textarea.current;
        if (controller.signal.aborted || !el || el.value !== value || document.activeElement !== el
          || composingRef.current || el.selectionStart !== value.length || el.selectionEnd !== value.length
          || reply.leafId !== leafId || typeof reply.text !== "string" || !reply.text.trim()
          || Array.from(reply.text).length > 100 || /[\r\n\x00-\x1f\x7f]/u.test(reply.text)) return;
        setResult({ key, text: reply.text });
      }).catch(() => {
        if (!controller.signal.aborted) completedKeyRef.current = key;
      });
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // The serialized key contains every scalar request field, so parent object
    // identities cannot restart the debounce or accidentally cause extra billing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, key, textarea]);

  const dismiss = useCallback((nextValue?: string) => {
    controllerRef.current?.abort();
    setResult(null);
    setSuppressedKey(keyFor(nextValue ?? value));
  }, [keyFor, value]);

  return { suffix: eligible && result?.key === key ? result.text : "", dismiss };
}
