/**
 * Key combinations: one definition serves both matching a key press and showing the keys.
 *
 * `mod` is the platform's command key, ⌘ on macOS and Ctrl elsewhere, so a shortcut is written
 * once ("⌘K" / "Ctrl+K"). Keys are `KeyboardEvent.key` values with letters in lower case, and
 * punctuation as the unshifted character ("]" for ⇧⌘]).
 */
import { type PlatformOs, usesCommandKey } from "../platform.tsx";

export interface Shortcut {
  /** "k", ",", "]", "1", "Escape", "Enter", "Tab", "ArrowDown", "PageUp", " ". */
  key: string;
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  /** ⌥ on macOS. */
  alt?: boolean;
  /** The Control key itself, on every platform. */
  ctrl?: boolean;
}

/** The parts of a key press that matching reads. A `KeyboardEvent` is one. */
export interface KeyPress {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Physical keys whose character ⇧ or ⌥ changes ("}" for ⇧], "∫" for ⌥B), by `KeyboardEvent.code`. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: " ",
};

function keyFromCode(code: string | undefined): string | null {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_KEYS[code] ?? null;
}

function normalKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * True when the press is exactly this shortcut: the same key with the same modifiers, no more.
 * ⇧ and ⌥ change the character a key types, so with either held the physical key also counts
 * (⌥⌘B arrives as "∫"). Without them only the character counts, so other keyboard layouts get
 * the key that is printed on their keycap.
 */
export function matchesShortcut(press: KeyPress, shortcut: Shortcut, os: PlatformOs): boolean {
  const mac = usesCommandKey(os);
  const wantMeta = shortcut.mod === true && mac;
  const wantCtrl = (shortcut.mod === true && !mac) || shortcut.ctrl === true;
  if (press.metaKey !== wantMeta || press.ctrlKey !== wantCtrl) return false;
  if (press.altKey !== (shortcut.alt === true)) return false;
  if (press.shiftKey !== (shortcut.shift === true)) return false;
  if (normalKey(press.key) === shortcut.key) return true;
  return (press.shiftKey || press.altKey) && keyFromCode(press.code) === shortcut.key;
}

/** A stable text form for comparing shortcuts: "mod+shift+]". */
export function shortcutSignature(shortcut: Shortcut): string {
  return [
    shortcut.ctrl ? "ctrl" : null,
    shortcut.alt ? "alt" : null,
    shortcut.shift ? "shift" : null,
    shortcut.mod ? "mod" : null,
    shortcut.key,
  ]
    .filter(Boolean)
    .join("+");
}

// ---------------------------------------------------------------------------------------------
// Showing keys
// ---------------------------------------------------------------------------------------------

interface KeyName {
  /** On a Mac keycap. */
  mac: string;
  /** Elsewhere. */
  other: string;
  /** What VoiceOver should say. */
  spoken: string;
}

const KEY_NAMES: Readonly<Record<string, KeyName>> = {
  Escape: { mac: "esc", other: "Esc", spoken: "Escape" },
  Enter: { mac: "⏎", other: "Enter", spoken: "Return" },
  Tab: { mac: "Tab", other: "Tab", spoken: "Tab" },
  ArrowUp: { mac: "↑", other: "↑", spoken: "Up Arrow" },
  ArrowDown: { mac: "↓", other: "↓", spoken: "Down Arrow" },
  ArrowLeft: { mac: "←", other: "←", spoken: "Left Arrow" },
  ArrowRight: { mac: "→", other: "→", spoken: "Right Arrow" },
  PageUp: { mac: "Page Up", other: "Page Up", spoken: "Page Up" },
  PageDown: { mac: "Page Down", other: "Page Down", spoken: "Page Down" },
  Home: { mac: "Home", other: "Home", spoken: "Home" },
  End: { mac: "End", other: "End", spoken: "End" },
  Backspace: { mac: "⌫", other: "Backspace", spoken: "Delete" },
  " ": { mac: "Space", other: "Space", spoken: "Space" },
  ",": { mac: ",", other: ",", spoken: "Comma" },
  ".": { mac: ".", other: ".", spoken: "Period" },
  "/": { mac: "/", other: "/", spoken: "Slash" },
  "[": { mac: "[", other: "[", spoken: "Left Bracket" },
  "]": { mac: "]", other: "]", spoken: "Right Bracket" },
  "@": { mac: "@", other: "@", spoken: "At sign" },
  /** A question card's options. */
  "1–9": { mac: "1–9", other: "1–9", spoken: "1 to 9" },
};

/** Key values for `aria-keyshortcuts` where they differ from ours. */
const ARIA_KEYS: Readonly<Record<string, string>> = { " ": "Space" };

function keyName(key: string): KeyName {
  const known = KEY_NAMES[key];
  if (known) return known;
  const upper = key.length === 1 ? key.toUpperCase() : key;
  return { mac: upper, other: upper, spoken: upper };
}

/**
 * The keycaps, in the platform's order: Apple's ⌃ ⌥ ⇧ ⌘ then the key on macOS ("⇧", "⌘", "]"),
 * Ctrl, Alt, Shift then the key elsewhere ("Ctrl", "Shift", "]").
 */
export function shortcutKeys(shortcut: Shortcut, os: PlatformOs): string[] {
  const mac = usesCommandKey(os);
  const name = keyName(shortcut.key);
  if (mac) {
    return [
      ...(shortcut.ctrl ? ["⌃"] : []),
      ...(shortcut.alt ? ["⌥"] : []),
      ...(shortcut.shift ? ["⇧"] : []),
      ...(shortcut.mod ? ["⌘"] : []),
      name.mac,
    ];
  }
  return [
    ...(shortcut.ctrl || shortcut.mod ? ["Ctrl"] : []),
    ...(shortcut.alt ? ["Alt"] : []),
    ...(shortcut.shift ? ["Shift"] : []),
    name.other,
  ];
}

/** As one hint: "⇧⌘]" on macOS, "Ctrl+Shift+]" elsewhere. */
export function formatShortcut(shortcut: Shortcut, os: PlatformOs): string {
  const keys = shortcutKeys(shortcut, os);
  return usesCommandKey(os) ? keys.join("") : keys.join("+");
}

/** What VoiceOver reads: "Shift Command Right Bracket". */
export function spokenShortcut(shortcut: Shortcut, os: PlatformOs): string {
  const mac = usesCommandKey(os);
  const parts = mac
    ? [
        shortcut.ctrl ? "Control" : null,
        shortcut.alt ? "Option" : null,
        shortcut.shift ? "Shift" : null,
        shortcut.mod ? "Command" : null,
      ]
    : [
        shortcut.ctrl || shortcut.mod ? "Control" : null,
        shortcut.alt ? "Alt" : null,
        shortcut.shift ? "Shift" : null,
      ];
  return [...parts.filter(Boolean), keyName(shortcut.key).spoken].join(" ");
}

/** The `aria-keyshortcuts` value: "Meta+Shift+]" on macOS, "Control+Shift+]" elsewhere. */
export function ariaKeyShortcut(shortcut: Shortcut, os: PlatformOs): string {
  const mac = usesCommandKey(os);
  const key =
    ARIA_KEYS[shortcut.key] ??
    (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return [
    shortcut.ctrl || (shortcut.mod && !mac) ? "Control" : null,
    shortcut.alt ? "Alt" : null,
    shortcut.shift ? "Shift" : null,
    shortcut.mod && mac ? "Meta" : null,
    key,
  ]
    .filter(Boolean)
    .join("+");
}

// ---------------------------------------------------------------------------------------------
// Where a key press lands
// ---------------------------------------------------------------------------------------------

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number"]);

/**
 * True when the element takes typing: a text field, a text area, something editable, the code
 * editor or the terminal. Plain keys there are the person's text, not shortcuts.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest(
      "[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox'], .monaco-editor, .xterm",
    ) !== null
  );
}

/** Inside the Terminal pane's screen, where Ctrl-keys belong to the shell. */
export function isInTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".xterm") !== null;
}

/** An IME is composing text: the key belongs to it (229 is the composition key code). */
export function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
