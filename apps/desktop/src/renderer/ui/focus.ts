import { type RefObject, useLayoutEffect } from "react";

/**
 * Where keyboard focus goes when the control that had it goes away: an answered decision card,
 * a dismissed notice, a step of first run that has been replaced. Without this, focus falls to
 * the page itself and the next Tab starts again from the top of the window.
 */

/** The composer's message field. */
export const MESSAGE_FIELD_SELECTOR = 'textarea[aria-label="Message to dawg"]';

/** True when nothing in particular has focus (it fell to the page when its control went). */
export function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
}

/** Focuses the message field, if there is one and it can take focus. */
export function focusMessageField(): boolean {
  const field = document.querySelector<HTMLTextAreaElement>(MESSAGE_FIELD_SELECTOR);
  if (!field || field.disabled) return false;
  field.focus({ preventScroll: true });
  return document.activeElement === field;
}

/**
 * Runs `move` once the current key press or click has finished, if focus is then lost or still
 * inside `within` (the control that is going away). Waiting matters: moving focus during a
 * keydown would let the same key type into the newly focused field.
 */
export function moveFocusSoon(move: () => void, within?: Element | null): void {
  setTimeout(() => {
    const active = document.activeElement;
    const stillInside = within != null && active !== null && within.contains(active);
    if (focusIsLost() || stillInside) move();
  }, 0);
}

/**
 * When the part `ref` points at leaves the page while focus is inside it (the pane dock or the
 * sidebar closed with a shortcut, a card answered), focus moves to `fallback`: by default the
 * message field. A layout effect, so it runs while the part is still on the page.
 */
export function useFocusFallback(
  ref: RefObject<HTMLElement | null>,
  fallback: () => unknown = focusMessageField,
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (element?.contains(document.activeElement)) moveFocusSoon(fallback);
    };
  }, [ref, fallback]);
}
