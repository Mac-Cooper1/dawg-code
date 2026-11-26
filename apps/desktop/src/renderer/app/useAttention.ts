/**
 * Mounts the attention watcher (state/attention.ts) for the window's life: macOS notifications
 * when a session needs the person, finishes or fails while they are not looking, the Dock badge,
 * and showing the session whose notification was clicked.
 */
import { useEffect } from "react";
import type { DawgBridge } from "../../shared/bridge.ts";
import { getBridge } from "../bridge/index.ts";
import { createAttentionWatcher } from "../state/attention.ts";
import { useAppStoreApi } from "../state/store.ts";

export function useAttention(): void {
  const store = useAppStoreApi();
  useEffect(() => {
    const notifications = getBridge().notifications as DawgBridge["notifications"] | undefined;
    // A preload left over from an older build has none: the window still works without them.
    if (!notifications) return;
    const watcher = createAttentionWatcher({
      store,
      notifications,
      isWindowFocused: () => document.hasFocus(),
    });
    return () => watcher.dispose();
  }, [store]);
}
