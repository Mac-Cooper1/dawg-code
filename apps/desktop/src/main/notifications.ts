/**
 * macOS notifications and the Dock badge (spec: "Notifications and dock").
 *
 * Plain logic with Electron injected, so it runs in unit tests without Electron. `index.ts` plugs
 * in Electron's `Notification`, `app.dock` and the windows.
 *
 * - `show` shows nothing while Settings → General turns notifications off, or while any dawg
 *   window is focused: the person is in the app, and the sidebar already says it. A newer
 *   notification for a session replaces its older one, so Notification Centre holds at most one
 *   per session. The window decides when to ask (renderer/state/attention.ts) and what the text
 *   says; main only shows it.
 * - Clicking one restores and focuses the window that asked and tells its page to show the
 *   session. When that window has closed, the main window does (made again if none is open).
 *   Either way the session's notification goes, and every one goes when the app quits: a click
 *   after quitting would reach nothing.
 * - The Dock badge counts the sessions that need the person, as each window reports it. Turning
 *   the badge off clears it at once; turning it back on shows the latest count again. A window
 *   that closes takes its count with it, since nothing keeps it current any more.
 *
 * Notifications are never silent. Whether they make a sound is the person's choice in System
 * Settings → Notifications → dawg-code ("Play sound for notification"), which also follows Focus;
 * a silent notification would take that choice away, and a session that needs the person stays
 * blocked until they answer.
 */
import type { DesktopSettings, NotifyInput } from "../shared/bridge.ts";
import type { NotificationServiceFor } from "./ipc-handlers.ts";

/** What the service needs of a native notification (Electron's `Notification`). */
export interface NativeNotification {
  show(): void;
  close(): void;
  onClick(listener: () => void): void;
  /** It left the screen and Notification Centre: the person dismissed it, or `close()` ran. */
  onClose(listener: () => void): void;
}

export interface NativeNotificationOptions {
  title: string;
  body: string;
  silent: boolean;
}

export type NotificationSettings = Pick<DesktopSettings, "notifications" | "dockBadge">;

export interface NotificationServiceOptions<Sender> {
  /** Settings → General, read once; `settingsChanged` keeps the service current after that. */
  getSettings(): Promise<NotificationSettings>;
  /** True while any dawg window has focus. */
  isAnyWindowFocused(): boolean;
  /** False where the system cannot show notifications. Default: they can. */
  isSupported?(): boolean;
  createNotification(options: NativeNotificationOptions): NativeNotification;
  /** `app.dock.setBadge`: "" clears it. */
  setDockBadge(text: string): void;
  /** A stable name for the sender's window: its badge count is kept under it. */
  windowKeyOf(sender: Sender): string;
  /**
   * Restores and focuses the sender's window and tells its page to show the session. False when
   * that window is gone.
   */
  openInWindow(sender: Sender, sessionId: string): boolean;
  /** Shows the session in the main window, making one when none is open. */
  openInMainWindow(sessionId: string): void;
  log?(message: string): void;
}

export interface NotificationService<Sender> extends NotificationServiceFor<Sender> {
  /** After every settings change: the badge follows `dockBadge` at once. */
  settingsChanged(settings: NotificationSettings): void;
  /** A window closed (by `windowKeyOf`): its count leaves the badge. */
  windowClosed(windowKey: string): void;
  /** Closes every notification still showing (the app quits). */
  closeAll(): void;
  /** Sessions with a notification showing, oldest first. For tests and logs. */
  showing(): string[];
}

interface Shown<Sender> {
  native: NativeNotification;
  sender: Sender;
}

export function createNotificationService<Sender>(
  options: NotificationServiceOptions<Sender>,
): NotificationService<Sender> {
  const log = options.log ?? (() => {});
  /** The notification showing for each session; held so it is not garbage-collected. */
  const shown = new Map<string, Shown<Sender>>();
  /** The latest count each window reported. */
  const counts = new Map<string, number>();
  /** Null until read; from then on `settingsChanged` keeps it current. */
  let settings: NotificationSettings | null = null;
  let loading: Promise<NotificationSettings> | null = null;
  /** What the Dock shows now. It starts without a badge. */
  let badgeText = "";

  async function currentSettings(): Promise<NotificationSettings> {
    if (settings) return settings;
    loading ??= options.getSettings().then((value) => {
      // A change that arrived while reading wins over what was read.
      settings ??= { notifications: value.notifications, dockBadge: value.dockBadge };
      return settings;
    });
    return loading;
  }

  function renderBadge(): void {
    // Every window sees every session, so they report the same count; the highest wins while a
    // window that just opened catches up.
    let count = 0;
    for (const value of counts.values()) count = Math.max(count, value);
    const text = settings?.dockBadge && count > 0 ? String(count) : "";
    if (text === badgeText) return;
    badgeText = text;
    try {
      options.setDockBadge(text);
    } catch (error) {
      log(`Could not set the Dock badge: ${messageOf(error)}`);
    }
  }

  /** Closes the session's notification and forgets it. */
  function dismiss(sessionId: string): void {
    const entry = shown.get(sessionId);
    if (!entry) return;
    shown.delete(sessionId);
    closeQuietly(entry.native);
  }

  function closeQuietly(native: NativeNotification): void {
    try {
      native.close();
    } catch (error) {
      log(`Could not close a notification: ${messageOf(error)}`);
    }
  }

  return {
    async show(sender, input: NotifyInput) {
      if (options.isSupported && !options.isSupported()) return false;
      const { notifications } = await currentSettings();
      if (!notifications) return false;
      // Checked after reading the settings, so a window focused meanwhile still counts.
      if (options.isAnyWindowFocused()) return false;
      let native: NativeNotification;
      try {
        native = options.createNotification({
          title: input.title,
          body: input.body,
          silent: false,
        });
      } catch (error) {
        // Never the title or body: they can name the person's work.
        log(`Could not make a notification: ${messageOf(error)}`);
        return false;
      }
      const entry: Shown<Sender> = { native, sender };
      const { sessionId } = input;
      const previous = shown.get(sessionId);
      shown.delete(sessionId);
      shown.set(sessionId, entry);
      if (previous) closeQuietly(previous.native);
      native.onClick(() => {
        dismiss(sessionId);
        if (!options.openInWindow(entry.sender, sessionId)) options.openInMainWindow(sessionId);
      });
      native.onClose(() => {
        if (shown.get(sessionId) === entry) shown.delete(sessionId);
      });
      try {
        native.show();
      } catch (error) {
        if (shown.get(sessionId) === entry) shown.delete(sessionId);
        log(`Could not show a notification: ${messageOf(error)}`);
        return false;
      }
      return true;
    },

    async setBadge(sender, count) {
      counts.set(options.windowKeyOf(sender), count);
      await currentSettings();
      renderBadge();
    },

    settingsChanged(next) {
      settings = { notifications: next.notifications, dockBadge: next.dockBadge };
      renderBadge();
    },

    windowClosed(windowKey) {
      if (counts.delete(windowKey)) renderBadge();
    },

    closeAll() {
      for (const sessionId of [...shown.keys()]) dismiss(sessionId);
    },

    showing() {
      return [...shown.keys()];
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
