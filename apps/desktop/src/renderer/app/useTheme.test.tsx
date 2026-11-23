import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Appearance, ResolvedTheme } from "../../shared/bridge.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { resolveTheme, useApplyTheme, useSystemTheme } from "./useTheme.ts";

/** A stand-in for `matchMedia("(prefers-color-scheme: dark)")` that tests can flip. */
function fakeSystem(initiallyDark: boolean) {
  let dark = initiallyDark;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  window.matchMedia = vi.fn(() => query as unknown as MediaQueryList);
  return {
    set(next: boolean) {
      dark = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function Probe(props: { appearance: Appearance; onResolved(theme: ResolvedTheme): void }) {
  const theme = useApplyTheme(props.appearance, props.onResolved);
  const system = useSystemTheme();
  return (
    <p>
      showing {theme}, system {system}
    </p>
  );
}

const original = window.matchMedia;
beforeEach(() => {
  window.matchMedia = original;
});
afterEach(() => {
  window.matchMedia = original;
});

describe("resolveTheme", () => {
  it("follows the system only for Match macOS", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("dark", "light")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
  });
});

describe.each(THEMES)("useApplyTheme (starting %s)", (startTheme) => {
  it("follows macOS live when the appearance is Match macOS", () => {
    const system = fakeSystem(true);
    const onResolved = vi.fn();
    renderInTheme(<Probe appearance="system" onResolved={onResolved} />, startTheme);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(onResolved).toHaveBeenLastCalledWith("dark");

    act(() => system.set(false));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(onResolved).toHaveBeenLastCalledWith("light");
    expect(screen.getByText("showing light, system light")).toBeInTheDocument();

    act(() => system.set(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("lets an explicit Dark or Light override macOS", () => {
    const system = fakeSystem(false);
    const onResolved = vi.fn();
    const { rerender } = renderInTheme(
      <Probe appearance="dark" onResolved={onResolved} />,
      startTheme,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(onResolved).toHaveBeenLastCalledWith("dark");
    act(() => system.set(true));
    act(() => system.set(false));
    expect(document.documentElement.dataset.theme).toBe("dark");

    rerender(<Probe appearance="light" onResolved={onResolved} />);
    act(() => system.set(true));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(onResolved).toHaveBeenLastCalledWith("light");
    expect(screen.getByText("showing light, system dark")).toBeInTheDocument();
  });

  it("stops listening when unmounted", () => {
    const system = fakeSystem(true);
    const { unmount } = renderInTheme(
      <Probe appearance="system" onResolved={vi.fn()} />,
      startTheme,
    );
    expect(system.listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(system.listenerCount()).toBe(0);
  });
});
