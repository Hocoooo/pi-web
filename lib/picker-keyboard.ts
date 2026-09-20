/** Navigate the rendered option order (including grouped lists), not data order. */
export function getPickerOptions(root: HTMLElement | null): HTMLButtonElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)')) : [];
}

export function getSelectedPickerOption(root: HTMLElement | null): HTMLButtonElement | undefined {
  const options = getPickerOptions(root);
  return options.find(option => option.getAttribute("aria-selected") === "true") ?? options[0];
}

export function focusPickerOption(option: HTMLButtonElement | undefined): void {
  option?.focus({ preventScroll: true });
  option?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function movePickerFocus(root: HTMLElement | null, key: string): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
  const options = getPickerOptions(root);
  if (!options.length) return true;
  const focused = options.findIndex(option => option === root?.ownerDocument.activeElement);
  const selected = options.findIndex(option => option.getAttribute("aria-selected") === "true");
  const current = focused >= 0 ? focused : selected;
  const index = key === "Home" ? 0 : key === "End" ? options.length - 1
    : current < 0 ? (key === "ArrowDown" ? 0 : options.length - 1)
    : (current + (key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
  focusPickerOption(options[index]);
  return true;
}
