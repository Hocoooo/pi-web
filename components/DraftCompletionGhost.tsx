"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

/** A visual-only suffix. The textarea remains the sole editable/submitted value. */
export function DraftCompletionGhost({ textarea, value, suffix, onOverflow }: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  value: string;
  suffix: string;
  onOverflow: () => void;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const suffixRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = textarea.current;
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;
    const syncScroll = () => {
      mirror.style.transform = `translateY(${-el.scrollTop}px)`;
      const viewport = el.getBoundingClientRect();
      const lines = Array.from(suffixRef.current?.getClientRects() ?? []);
      const fits = lines.length > 0 && lines.every((line) => line.top >= viewport.top - 0.5
        && line.bottom <= viewport.bottom + 0.5 && line.left >= viewport.left - 0.5 && line.right <= viewport.right + 0.5);
      mirror.style.visibility = fits ? "visible" : "hidden";
      // A capped textarea cannot scroll through mirror-only lines. Never allow
      // Tab to append text that the user cannot fully see (also on manual scroll).
      if (!fits) onOverflow();
    };
    const measure = () => {
      const computed = getComputedStyle(el);
      for (const name of ["font", "letter-spacing", "word-spacing", "padding-top", "padding-right", "padding-bottom", "padding-left", "text-indent", "text-align", "tab-size", "direction"]) {
        mirror.style.setProperty(name, computed.getPropertyValue(name));
      }
      mirror.style.width = `${el.clientWidth}px`;
      const desired = `${Math.min(200, Math.max(24, mirror.scrollHeight))}px`;
      if (el.style.height !== desired) el.style.height = desired;
      syncScroll();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener("scroll", syncScroll);
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", syncScroll);
      el.style.height = "auto";
      if (el.value) el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    };
  }, [textarea, value, suffix, onOverflow]);

  return (
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div ref={mirrorRef} style={{ visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", color: "transparent", boxSizing: "border-box" }}>
        <span>{value}</span><wbr /><span ref={suffixRef} data-draft-completion-ghost style={{ color: "var(--text-dim)" }}>{suffix}</span>
      </div>
    </div>
  );
}
