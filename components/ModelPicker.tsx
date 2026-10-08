"use client";

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { filterModelOptions, hasThinkingPickerConfig, initialThinkingLevel, modelKey, nextPickerIndex, type PickerModel, type ThinkingPickerConfig } from "@/lib/model-picker";

interface Props {
  options: PickerModel[];
  value?: Pick<PickerModel, "provider" | "modelId"> | null;
  query?: string;
  defaultValue?: Pick<PickerModel, "provider" | "modelId"> | null;
  onSetDefault?: (provider: string, modelId: string) => void;
  autoFocus?: boolean;
  thinking?: ThinkingPickerConfig;
  onSelect: (model: PickerModel) => void;
  onClose: () => void;
  onClear?: () => void;
  emptyLabel?: string;
  onSubmittingChange: (submitting: boolean) => void;
}

/** Local draft of a model + thinking choice. Navigation never mutates a session. */
export function ModelPicker({ options, value, query = "", thinking, onSelect, onClose, onClear, emptyLabel, onSubmittingChange, defaultValue, onSetDefault, autoFocus = true }: Props) {
  const { t } = useI18n();
  const id = useId();
  const [filter, setFilter] = useState(query);
  const [activeKey, setActiveKey] = useState(value ? modelKey(value) : "");
  const [target, setTarget] = useState<PickerModel | null>(null);
  const [level, setLevel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const filtered = filterModelOptions(options, filter);
  const rows: Array<{ key: string; label: string; detail?: string; model?: PickerModel; clear?: boolean }> = target
    ? (thinking?.levels[modelKey(target)] ?? []).map(value => ({ key: value, label: thinking?.levelMaps?.[modelKey(target)]?.[value] ?? value }))
    : [
      ...(onClear && !filter.trim() ? [{ key: "__default__", label: emptyLabel ?? "Default", clear: true }] : []),
      ...filtered.map(model => ({ key: modelKey(model), label: model.name || model.modelId, detail: `${model.provider}/${model.modelId}`, model })),
    ];
  const requestedKey = target ? level : activeKey;
  const active = rows.find(row => row.key === requestedKey) ?? rows[0];
  const activeIndex = active ? rows.indexOf(active) : -1;
  const step = target ? "thinking" : "model";
  const activeId = active ? `${id}-option-${activeIndex}` : undefined;
  const scrollKey = active?.key;

  // Virtual focus keeps the search field editable after any number of arrows.
  useLayoutEffect(() => {
    if (target || autoFocus) (target ? listRef.current : inputRef.current)?.focus({ preventScroll: true });
  }, [step, target, autoFocus]);
  useLayoutEffect(() => {
    if (scrollKey !== undefined) rowRefs.current.get(scrollKey)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrollKey, step, filter]);

  const back = () => { setTarget(null); setError(null); };
  const select = async (row = active) => {
    if (!row || savingRef.current) return;
    if (!target) {
      if (row.clear) { onClear?.(); return; }
      if (!row.model) return;
      setActiveKey(row.key);
      if (!hasThinkingPickerConfig(thinking)) { onSelect(row.model); return; }
      setLevel(initialThinkingLevel(thinking.levels[row.key] ?? [], thinking.level));
      setTarget(row.model);
      setError(null);
      return;
    }
    if (!hasThinkingPickerConfig(thinking)) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    onSubmittingChange(true);
    try {
      const result = await thinking.onConfirm(target.provider, target.modelId, row.key);
      if (result.error) setError(result.error);
      else onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSubmittingChange(false);
    }
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (savingRef.current) { event.preventDefault(); return; }
    const navigation = event.key === "ArrowDown" || event.key === "ArrowUp"
      || ((event.key === "Home" || event.key === "End") && (target || event.ctrlKey || event.metaKey));
    if (navigation) {
      event.preventDefault(); event.stopPropagation();
      const next = rows[nextPickerIndex(activeIndex, rows.length, event.key)];
      if (next) { if (target) setLevel(next.key); else setActiveKey(next.key); }
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); onClose();
    } else if (event.key === "ArrowLeft" && target) {
      event.preventDefault(); event.stopPropagation(); back();
    } else if (event.key === "Enter" && (event.target as HTMLElement).tagName === "BUTTON") {
      // Let a keyboard-focused back button perform its native click.
      return;
    } else if (event.key === "Enter" || (event.key === "ArrowRight" && hasThinkingPickerConfig(thinking))) {
      event.preventDefault(); event.stopPropagation(); void select();
    }
  };

  return (
    <div onKeyDown={handleKeyDown} aria-busy={saving} style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
      <div style={{ flexShrink: 0, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, marginBottom: target ? 0 : 8 }}>
          {target && <button type="button" disabled={saving} onMouseDown={event => event.preventDefault()} onClick={back} aria-label={t("chat.pickerBack")} style={{ border: 0, background: "none", color: "var(--text)", cursor: "pointer", padding: "2px 6px" }}>←</button>}
          <span style={{ color: "var(--text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{target ? target.name : t("chat.pickerModel")}</span>
          {hasThinkingPickerConfig(thinking) && <span style={{ color: "var(--text-dim)", marginLeft: "auto", whiteSpace: "nowrap" }}>{target ? "2 / 2" : "1 / 2"}</span>}
        </div>
        {target ? <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 5, overflowWrap: "anywhere" }}>{target.provider}/{target.modelId} · {t("chat.pickerThinking")}</div> : (
          <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={activeId} aria-autocomplete="list"
            aria-label={t("chat.filterModels")} placeholder={t("chat.filterModels")} value={filter} autoComplete="off" spellCheck={false}
            onChange={event => { setFilter(event.target.value); setError(null); }}
            style={{ boxSizing: "border-box", width: "100%", minWidth: 0, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 5, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 }} />
        )}
      </div>
      <div id={`${id}-list`} ref={listRef} role="listbox" aria-label={target ? t("chat.pickerThinking") : t("chat.pickerModel")}
        aria-activedescendant={target ? activeId : undefined} tabIndex={target ? 0 : -1}
        style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", outline: "none", padding: "4px 0" }}>
        {rows.length === 0 && <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>{target ? t("chat.pickerNoLevels") : t("chat.noMatchingModels")}</div>}
        {rows.map((row, index) => {
          const highlighted = active?.key === row.key;
          const current = target ? value && modelKey(value) === modelKey(target) && thinking?.level === row.key
            : row.clear ? !value : value && modelKey(value) === row.key;
          const isDefault = row.model && defaultValue && modelKey(row.model) === modelKey(defaultValue);
          return <div key={row.key} style={{ position: "relative" }}><button id={`${id}-option-${index}`} ref={node => { if (node) rowRefs.current.set(row.key, node); else rowRefs.current.delete(row.key); }}
            type="button" role="option" aria-selected={highlighted} data-current={current || undefined} tabIndex={-1} disabled={saving}
            onMouseDown={event => event.preventDefault()} onClick={() => void select(row)}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: !target && onSetDefault && row.model ? "8px 42px 8px 12px" : "8px 12px", border: 0, textAlign: "left", cursor: saving ? "wait" : "pointer", background: highlighted ? "var(--bg-selected)" : "none", color: "var(--text)", outline: highlighted ? "1px solid var(--accent)" : "none", outlineOffset: -1 }}>
            <span style={{ minWidth: 0, flex: 1 }}><span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{row.label}</span>
              {row.detail && <span style={{ display: "block", color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{row.detail}</span>}</span>
            {current && <span title={t("chat.pickerCurrent")} aria-label={t("chat.pickerCurrent")} style={{ color: "var(--accent)" }}>✓</span>}
            {!target && hasThinkingPickerConfig(thinking) && <span style={{ color: "var(--text-dim)" }}>→</span>}
          </button>
            {!target && row.model && onSetDefault && (isDefault
              ? <span role="img" aria-label={t("chat.defaultModel")} title={t("chat.defaultModel")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)" }}>★</span>
              : <button type="button" disabled={saving} aria-label={t("chat.saveDefaultModel")} title={t("chat.saveDefaultModel")}
                  onClick={event => { event.stopPropagation(); if (!savingRef.current) onSetDefault(row.model!.provider, row.model!.modelId); }}
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", width: 28, height: 28 }}>☆</button>)}
          </div>;
        })}
      </div>
      {error && <div role="alert" style={{ padding: "8px 12px", color: "var(--error, #ef4444)", fontSize: 12 }}>{error}</div>}
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)", padding: "8px 12px", color: "var(--text-dim)", fontSize: 11 }}>
        {saving ? t("chat.pickerApplying") : target ? t("chat.pickerThinkingHint") : hasThinkingPickerConfig(thinking) ? t("chat.pickerModelHint") : t("chat.pickerSimpleHint")}
      </div>
    </div>
  );
}
