import { useCallback } from "react";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { SettingsContainer } from "../settings/SettingsContainer.tsx";
import { useActions, useAppStore } from "../state/store.ts";
import { MainWindow } from "./MainWindow.tsx";
import { useGlobalShortcuts } from "./useShortcuts.ts";
import { useApplyTheme } from "./useTheme.ts";

/**
 * The window's root: applies the theme, listens for the window-wide shortcuts, and shows either
 * the sessions view or Settings.
 */
export function App() {
  const appearance = useAppStore((state) => state.settings.appearance);
  const view = useAppStore((state) => state.layout.view);
  const actions = useActions();
  const reportTheme = useCallback(
    (theme: ResolvedTheme) => actions.setResolvedTheme(theme),
    [actions],
  );
  useApplyTheme(appearance, reportTheme);
  useGlobalShortcuts();

  return view === "settings" ? <SettingsContainer /> : <MainWindow />;
}
