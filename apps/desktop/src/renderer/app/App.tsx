import { useCallback } from "react";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { FirstRunContainer } from "../onboarding/FirstRunContainer.tsx";
import { SettingsContainer } from "../settings/SettingsContainer.tsx";
import { useActions, useAppStore } from "../state/store.ts";
import { TrustDialogContainer } from "../trust/TrustDialog.tsx";
import { useRegionKeys } from "../ui/regions.ts";
import { useMenuBar } from "./commands/menu-bar.ts";
import { MainWindow } from "./MainWindow.tsx";
import { CommandPalette } from "./palette/CommandPalette.tsx";
import { useAttention } from "./useAttention.ts";
import { useGlobalShortcuts } from "./useShortcuts.ts";
import { useApplyTheme } from "./useTheme.ts";

/**
 * The window's root: applies the theme, listens for the window-wide shortcuts, watches for
 * sessions that want the person (notifications and the Dock badge), keeps the menu bar in step
 * with the window, and shows the
 * sessions view, Settings, or (in place of the sessions view, until a model runs) first run.
 */
export function App() {
  const appearance = useAppStore((state) => state.settings.appearance);
  const view = useAppStore((state) => state.layout.view);
  const firstRun = useAppStore((state) => state.onboarding !== null && state.modelsState !== null);
  const actions = useActions();
  const reportTheme = useCallback(
    (theme: ResolvedTheme) => actions.setResolvedTheme(theme),
    [actions],
  );
  useApplyTheme(appearance, reportTheme);
  useGlobalShortcuts();
  // F6 / ⇧F6: between the window's parts, and out of the terminal and the editor.
  useRegionKeys();
  useAttention();
  useMenuBar();

  const body =
    view === "settings" ? <SettingsContainer /> : firstRun ? <FirstRunContainer /> : <MainWindow />;
  return (
    <>
      {body}
      {/* ⌘K, from every view. */}
      <CommandPalette />
      {/* Code a project supplies, waiting for consent: from every view (Settings → Hooks too). */}
      <TrustDialogContainer />
    </>
  );
}
