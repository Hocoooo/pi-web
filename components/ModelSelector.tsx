"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ModelPicker } from "./ModelPicker";
import type { PickerModel, ThinkingPickerConfig } from "@/lib/model-picker";
export { filterModelOptions } from "@/lib/model-picker";
export type ModelSelectorOption = PickerModel;

interface ModelSelectorProps {
  options: ModelSelectorOption[];
  value?: { provider: string; modelId: string } | null;
  onChange: (provider: string, modelId: string) => void;
  onClear?: () => void;
  emptyLabel?: string;
  selectedLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  isAutoSelection?: boolean;
  ariaLabel?: string;
  variant?: "toolbar" | "field";
  placement?: "up" | "auto";
  defaultValue?: { provider: string; modelId: string } | null;
  onSetDefault?: (provider: string, modelId: string) => void;
  openRequest?: { query: string };
  onRequestClose?: () => void;
  thinking?: ThinkingPickerConfig;
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Trigger and popup placement; ModelPicker owns the keyboard/draft state machine. */
export function ModelSelector({ options, value, onChange, onClear, emptyLabel, selectedLabel, disabled = false, busy = false,
  isAutoSelection = false, ariaLabel, variant = "toolbar", placement = "up", defaultValue, onSetDefault, openRequest, onRequestClose, thinking }: ModelSelectorProps) {
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const consumedRequest = useRef<ModelSelectorProps["openRequest"]>(undefined);
  const openedFromCommand = useRef(false);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [pickerKey, setPickerKey] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  const locked = disabled || busy;
  const sorted = useMemo(() => [...options].sort((a, b) => collator.compare(a.name || a.modelId, b.name || b.modelId)
    || collator.compare(a.provider, b.provider) || collator.compare(a.modelId, b.modelId)), [options]);
  const currentName = selectedLabel ?? (value ? sorted.find(option => option.provider === value.provider && option.modelId === value.modelId)?.name ?? value.modelId
    : emptyLabel ?? (sorted.length ? "Select model" : "No models"));

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!submitting && !rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [submitting]);
  useEffect(() => { if (locked && !submitting) setOpen(false); }, [locked, submitting]);
  useEffect(() => {
    if (!openRequest || consumedRequest.current === openRequest || locked || !buttonRef.current) return;
    consumedRequest.current = openRequest;
    openedFromCommand.current = true;
    const rect = buttonRef.current.getBoundingClientRect();
    setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width });
    setQuery(openRequest.query);
    setPickerKey(key => key + 1);
    setOpen(true);
  }, [openRequest, locked]);
  const closePicker = () => {
    setOpen(false);
    const restoreComposer = openedFromCommand.current && onRequestClose;
    requestAnimationFrame(() => {
      if (restoreComposer) restoreComposer();
      else buttonRef.current?.focus({ preventScroll: true });
    });
  };
  const buttonStyle: CSSProperties = variant === "field" ? {
    display: "flex", alignItems: "center", gap: 7, width: "100%", minWidth: 0, height: 34, padding: "0 9px", overflow: "hidden",
    border: "1px solid var(--border)", borderRadius: 5, background: locked ? "var(--bg-panel)" : "var(--bg)", color: locked ? "var(--text-dim)" : "var(--text)", cursor: locked ? "default" : "pointer", fontSize: 12, textAlign: "left",
  } : {
    display: "flex", alignItems: "center", justifyContent: isMobile ? "flex-start" : undefined, gap: 6,
    width: isMobile ? "100%" : undefined, maxWidth: isMobile ? "100%" : 220, height: 32, padding: isMobile ? "8px 10px" : "8px 12px", overflow: "hidden",
    border: "none", borderRadius: 9, background: open ? "var(--bg-hover)" : "none", color: "var(--text-muted)", cursor: locked ? "not-allowed" : "pointer", fontSize: 12, opacity: locked ? 0.5 : 1,
  };
  return <div ref={rootRef} className={`model-selector is-${variant}${locked ? " is-disabled" : ""}`} style={{ position: "relative", width: variant === "field" || isMobile ? "100%" : undefined, minWidth: 0, flex: variant === "toolbar" && isMobile ? "1 1 auto" : undefined }}>
    <button ref={buttonRef} type="button" aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} aria-busy={busy || undefined} disabled={locked}
      title={busy ? "Switching model" : locked ? currentName : sorted.length || onClear ? "Change model" : "No available models"} style={buttonStyle}
      onClick={() => {
        openedFromCommand.current = false;
        const rect = buttonRef.current!.getBoundingClientRect();
        setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width });
        setQuery(""); setPickerKey(key => key + 1); setOpen(current => !current);
      }}>
      {busy ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /></svg>
        : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ flexShrink: 0 }}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /></svg>}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentName}</span>
      {variant === "field" && <span aria-hidden="true">⌄</span>}
    </button>
    {open && anchor && (() => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      const width = window.visualViewport?.width ?? window.innerWidth;
      const above = anchor.top - 8, below = height - anchor.bottom - 8;
      const openAbove = (placement === "up" && above >= 180) || above > below;
      const maxHeight = Math.max(120, Math.min(openAbove ? above : below, height * 0.65, 520));
      const panelWidth = Math.min(Math.max(anchor.width, 380), width - 16);
      return <div ref={panelRef} role="dialog" aria-label={ariaLabel ?? "Model settings"} style={{
        position: "fixed", ...(openAbove ? { bottom: height - anchor.top + 6 } : { top: anchor.bottom + 6 }),
        ...(isMobile ? { left: 8, right: 8 } : { left: Math.min(anchor.left, width - panelWidth - 8), width: panelWidth }),
        zIndex: 500, display: "flex", flexDirection: "column", maxHeight, overflow: "hidden", border: "1px solid var(--border)", borderRadius: 10,
        background: "var(--bg)", boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
      }}>
        <ModelPicker key={pickerKey} options={sorted} value={value} query={query} thinking={thinking} onClose={closePicker} onSubmittingChange={setSubmitting}
          defaultValue={defaultValue} onSetDefault={onSetDefault ? (provider, modelId) => { closePicker(); onSetDefault(provider, modelId); } : undefined}
          emptyLabel={emptyLabel} onClear={onClear ? () => { closePicker(); onClear(); } : undefined}
          onSelect={option => { closePicker(); if (isAutoSelection || option.provider !== value?.provider || option.modelId !== value?.modelId) onChange(option.provider, option.modelId); }} />
      </div>;
    })()}
  </div>;
}
