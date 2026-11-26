import { describe, expect, it } from "vitest";
import {
  ariaKeyShortcut,
  formatShortcut,
  isComposing,
  isInTerminal,
  isTypingTarget,
  type KeyPress,
  matchesShortcut,
  type Shortcut,
  shortcutKeys,
  shortcutSignature,
  spokenShortcut,
} from "./keys.ts";

function press(key: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return {
    key,
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

const PALETTE: Shortcut = { key: "k", mod: true };
const NEXT: Shortcut = { key: "]", mod: true, shift: true };
const PANES: Shortcut = { key: "b", mod: true, alt: true };

describe("matching a key press", () => {
  it("takes ⌘ as the command key on macOS and Ctrl elsewhere", () => {
    expect(matchesShortcut(press("k", { metaKey: true }), PALETTE, "darwin")).toBe(true);
    expect(matchesShortcut(press("k", { ctrlKey: true }), PALETTE, "darwin")).toBe(false);
    expect(matchesShortcut(press("k", { ctrlKey: true }), PALETTE, "linux")).toBe(true);
    expect(matchesShortcut(press("k", { metaKey: true }), PALETTE, "linux")).toBe(false);
    expect(matchesShortcut(press("k", { ctrlKey: true }), PALETTE, "win32")).toBe(true);
  });

  it("needs exactly the shortcut's modifiers", () => {
    expect(matchesShortcut(press("k"), PALETTE, "darwin")).toBe(false);
    expect(matchesShortcut(press("k", { metaKey: true, shiftKey: true }), PALETTE, "darwin")).toBe(
      false,
    );
    expect(matchesShortcut(press("k", { metaKey: true, altKey: true }), PALETTE, "darwin")).toBe(
      false,
    );
    expect(matchesShortcut(press("k", { metaKey: true, ctrlKey: true }), PALETTE, "darwin")).toBe(
      false,
    );
    expect(matchesShortcut(press("Escape"), { key: "Escape" }, "darwin")).toBe(true);
    expect(matchesShortcut(press("Escape", { shiftKey: true }), { key: "Escape" }, "darwin")).toBe(
      false,
    );
  });

  it("ignores the case a held Shift gives a letter", () => {
    const shortcut: Shortcut = { key: "n", mod: true, shift: true };
    expect(matchesShortcut(press("N", { metaKey: true, shiftKey: true }), shortcut, "darwin")).toBe(
      true,
    );
  });

  it("finds the physical key when Shift or Option changes the character", () => {
    // ⇧⌘] arrives as "}", ⌥⌘B as "∫", ⌥⌘1 as "¡".
    const shifted = press("}", { metaKey: true, shiftKey: true, code: "BracketRight" });
    expect(matchesShortcut(shifted, NEXT, "darwin")).toBe(true);
    const option = press("∫", { metaKey: true, altKey: true, code: "KeyB" });
    expect(matchesShortcut(option, PANES, "darwin")).toBe(true);
    const digit = press("¡", { metaKey: true, altKey: true, code: "Digit1" });
    expect(matchesShortcut(digit, { key: "1", mod: true, alt: true }, "darwin")).toBe(true);
  });

  it("goes by the character typed when no modifier changes it, as other layouts print it", () => {
    // On AZERTY the key in the Q position types "a": ⌘ and that key is ⌘A, not ⌘Q.
    const azerty = press("a", { metaKey: true, code: "KeyQ" });
    expect(matchesShortcut(azerty, { key: "q", mod: true }, "darwin")).toBe(false);
    expect(matchesShortcut(azerty, { key: "a", mod: true }, "darwin")).toBe(true);
  });

  it("follows the browser's platform outside Electron", () => {
    const original = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
    });
    try {
      expect(matchesShortcut(press("k", { metaKey: true }), PALETTE, "browser")).toBe(true);
      expect(formatShortcut(PALETTE, "browser")).toBe("⌘K");
    } finally {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: original });
    }
  });
});

describe("showing a shortcut", () => {
  it("writes macOS keys in Apple's order and spells them out elsewhere", () => {
    expect(formatShortcut(NEXT, "darwin")).toBe("⇧⌘]");
    expect(formatShortcut(PANES, "darwin")).toBe("⌥⌘B");
    expect(formatShortcut({ key: "n", mod: true, ctrl: true }, "darwin")).toBe("⌃⌘N");
    expect(formatShortcut(NEXT, "linux")).toBe("Ctrl+Shift+]");
    expect(formatShortcut(PANES, "win32")).toBe("Ctrl+Alt+B");
    expect(formatShortcut({ key: "Escape" }, "darwin")).toBe("esc");
    expect(formatShortcut({ key: "Escape" }, "linux")).toBe("Esc");
    expect(formatShortcut({ key: "Enter", mod: true }, "darwin")).toBe("⌘⏎");
    expect(formatShortcut({ key: "Tab", shift: true }, "darwin")).toBe("⇧Tab");
  });

  it("gives each key its own cap", () => {
    expect(shortcutKeys(NEXT, "darwin")).toEqual(["⇧", "⌘", "]"]);
    expect(shortcutKeys(NEXT, "linux")).toEqual(["Ctrl", "Shift", "]"]);
    expect(shortcutKeys({ key: "1–9" }, "darwin")).toEqual(["1–9"]);
  });

  it("says the keys in words for VoiceOver", () => {
    expect(spokenShortcut(NEXT, "darwin")).toBe("Shift Command Right Bracket");
    expect(spokenShortcut(PANES, "darwin")).toBe("Option Command B");
    expect(spokenShortcut({ key: ",", mod: true }, "linux")).toBe("Control Comma");
    expect(spokenShortcut({ key: "1–9" }, "darwin")).toBe("1 to 9");
  });

  it("writes aria-keyshortcuts values", () => {
    expect(ariaKeyShortcut(PALETTE, "darwin")).toBe("Meta+K");
    expect(ariaKeyShortcut(PALETTE, "linux")).toBe("Control+K");
    expect(ariaKeyShortcut(PANES, "darwin")).toBe("Alt+Meta+B");
    expect(ariaKeyShortcut({ key: "Escape" }, "darwin")).toBe("Escape");
  });

  it("has one text form per combination, for comparing", () => {
    expect(shortcutSignature(NEXT)).toBe("shift+mod+]");
    expect(shortcutSignature({ key: "]", shift: true, mod: true })).toBe(shortcutSignature(NEXT));
    expect(shortcutSignature(PALETTE)).not.toBe(shortcutSignature({ key: "k", ctrl: true }));
  });
});

describe("where a key press lands", () => {
  it("knows the fields that take typing", () => {
    const text = document.createElement("input");
    const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
    const search = Object.assign(document.createElement("input"), { type: "search" });
    const area = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inside = document.createElement("span");
    editable.append(inside);
    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    const editorPart = document.createElement("div");
    editor.append(editorPart);
    const button = document.createElement("button");

    for (const element of [text, search, area, editable, inside, editorPart]) {
      expect(isTypingTarget(element)).toBe(true);
    }
    for (const element of [checkbox, button, document.body, null]) {
      expect(isTypingTarget(element)).toBe(false);
    }
  });

  it("knows the terminal's screen", () => {
    const screen = document.createElement("div");
    screen.className = "xterm";
    const helper = document.createElement("textarea");
    screen.append(helper);
    expect(isInTerminal(helper)).toBe(true);
    expect(isTypingTarget(helper)).toBe(true);
    expect(isInTerminal(document.createElement("textarea"))).toBe(false);
  });

  it("leaves keys an IME is composing with alone", () => {
    expect(isComposing(new KeyboardEvent("keydown", { key: "k", isComposing: true }))).toBe(true);
    expect(isComposing(new KeyboardEvent("keydown", { key: "Process", keyCode: 229 }))).toBe(true);
    expect(isComposing(new KeyboardEvent("keydown", { key: "k" }))).toBe(false);
  });
});
