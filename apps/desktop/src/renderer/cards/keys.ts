/**
 * Keyboard shortcuts of a decision card. They act only while focus is inside the card, so typing
 * elsewhere is never taken over: ⏎ runs the primary action, ⌘⏎ the secondary one, esc denies,
 * dismisses or goes back, and 1–9 pick a question's options. Plain ⏎ is left to text fields
 * (new lines) and to buttons and links (they activate themselves).
 */

export interface CardShortcuts {
  primary?: (() => void) | null;
  secondary?: (() => void) | null;
  escape?: (() => void) | null;
  /** 1-based option number, with the element that had focus. */
  number?: ((n: number, target: HTMLElement) => void) | null;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number"]);

export function isTextField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type);
}

function activatesItself(element: Element | null): boolean {
  return (
    element instanceof Element &&
    element.closest("button, a[href], summary, [role='button'], [role='link']") !== null
  );
}

/** Runs the shortcut for a key press, if any. Returns true when the press was handled. */
export function handleCardKey(event: KeyboardEvent, shortcuts: CardShortcuts): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const command = event.metaKey || event.ctrlKey;
  let action: (() => void) | null = null;

  if (event.key === "Enter" && command && !event.altKey && !event.shiftKey) {
    action = shortcuts.secondary ?? null;
  } else if (event.key === "Enter" && !command && !event.altKey && !event.shiftKey) {
    if (!isTextField(target) && !activatesItself(target)) action = shortcuts.primary ?? null;
  } else if (event.key === "Escape" && !command && !event.altKey && !event.shiftKey) {
    action = shortcuts.escape ?? null;
  } else if (
    /^[1-9]$/.test(event.key) &&
    !command &&
    !event.altKey &&
    target &&
    !isTextField(target)
  ) {
    const pick = shortcuts.number;
    if (pick) action = () => pick(Number(event.key), target);
  }

  if (action === null) return false;
  event.preventDefault();
  event.stopPropagation();
  action();
  return true;
}
