/**
 * F6 and ⇧F6 move focus between the parts of the window: title bar, sidebar, main column (the
 * message field), pane dock; in Settings, its page list and page. It is the way out of the parts
 * that keep Tab for themselves (the terminal sends Tab to the shell, the code editor indents),
 * and a quick way across the window without tabbing through every row.
 *
 * The listener runs before anything else sees the key (capture phase), because the terminal and
 * the editor would otherwise take F6 as their own. Inside a dialog or menu it does nothing: those
 * keep focus until they close.
 */
import { useEffect } from "react";
import { MESSAGE_FIELD_SELECTOR } from "./focus.ts";

const REGION_SELECTOR = "header, nav, main, aside";

const TABBABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/** Where focus lands in each part: its current item rather than its first control. */
const PREFERRED = [
  MESSAGE_FIELD_SELECTOR,
  "button[data-session-row][tabindex='0']",
  "[role='tab'][aria-selected='true']",
  "[aria-current='page']",
];

/** Drawn on the page (not hidden, not in a closed part). Without layout (tests), assumed so. */
function visible(element: HTMLElement): boolean {
  return typeof element.checkVisibility === "function" ? element.checkVisibility() : true;
}

/** The window's parts in page order: landmarks not inside another one. */
export function windowRegions(root: ParentNode = document): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(REGION_SELECTOR)];
  return all.filter(
    (element) =>
      !all.some((other) => other !== element && other.contains(element)) &&
      element.closest("[role='dialog'], [role='alertdialog']") === null,
  );
}

/** The control focus should land on in `region`, if any. */
export function regionTarget(region: HTMLElement): HTMLElement | null {
  for (const selector of PREFERRED) {
    const found = region.querySelector<HTMLElement>(selector);
    if (found && visible(found) && !(found as HTMLButtonElement).disabled) return found;
  }
  for (const candidate of region.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (visible(candidate)) return candidate;
  }
  return null;
}

function inOverlay(element: Element | null): boolean {
  return (
    element?.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']") !=
      null && element.closest(REGION_SELECTOR) === null
  );
}

/** Moves focus to the next (1) or previous (-1) part that has something to focus. */
export function moveToRegion(step: 1 | -1, root: ParentNode = document): boolean {
  const regions = windowRegions(root);
  if (regions.length === 0) return false;
  const active = document.activeElement;
  const current = regions.findIndex((region) => active !== null && region.contains(active));
  for (let i = 1; i <= regions.length; i++) {
    const start = current === -1 ? (step === 1 ? -1 : 0) : current;
    const index = (start + step * i + regions.length * 2) % regions.length;
    const region = regions[index];
    const target = region ? regionTarget(region) : null;
    if (target) {
      target.focus();
      return true;
    }
  }
  return false;
}

/** Installs F6 and ⇧F6 on the window. */
export function useRegionKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F6" || event.altKey || event.ctrlKey || event.metaKey) return;
      if (inOverlay(document.activeElement)) return;
      if (moveToRegion(event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
