import { describe, expect, it, vi } from "vitest";
import type { NotifyInput } from "../shared/bridge.ts";
import {
  createNotificationService,
  type NativeNotification,
  type NativeNotificationOptions,
  type NotificationServiceOptions,
  type NotificationSettings,
} from "./notifications.ts";

/** A window's page, as main sees it. */
interface FakeSender {
  key: string;
  /** False once the window has closed. */
  alive: boolean;
}

class FakeNotification implements NativeNotification {
  shown = false;
  closed = false;
  private clickListeners: (() => void)[] = [];
  private closeListeners: (() => void)[] = [];
  readonly options: NativeNotificationOptions;

  constructor(options: NativeNotificationOptions) {
    this.options = options;
  }

  show(): void {
    this.shown = true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
  onClick(listener: () => void): void {
    this.clickListeners.push(listener);
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
  /** The person clicks it. */
  click(): void {
    for (const listener of this.clickListeners) listener();
  }
  /** The person dismisses it from Notification Centre. */
  dismiss(): void {
    this.close();
  }
}

function setup(
  initial: Partial<NotificationSettings> = {},
  overrides: Partial<NotificationServiceOptions<FakeSender>> = {},
) {
  let settings: NotificationSettings = { notifications: true, dockBadge: true, ...initial };
  const made: FakeNotification[] = [];
  const badges: string[] = [];
  const opened: { window: string; sessionId: string }[] = [];
  const mainWindowOpened: string[] = [];
  const focus = { any: false };
  const getSettings = vi.fn(async () => settings);
  const service = createNotificationService<FakeSender>({
    getSettings,
    isAnyWindowFocused: () => focus.any,
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      made.push(notification);
      return notification;
    },
    setDockBadge: (text) => badges.push(text),
    windowKeyOf: (sender) => sender.key,
    openInWindow: (sender, sessionId) => {
      if (!sender.alive) return false;
      opened.push({ window: sender.key, sessionId });
      return true;
    },
    openInMainWindow: (sessionId) => mainWindowOpened.push(sessionId),
    ...overrides,
  });
  return {
    service,
    made,
    badges,
    opened,
    mainWindowOpened,
    focus,
    getSettings,
    /** Changes the settings as Settings → General would: saved, then reported. */
    change(patch: Partial<NotificationSettings>) {
      settings = { ...settings, ...patch };
      service.settingsChanged(settings);
    },
  };
}

const WINDOW: FakeSender = { key: "1", alive: true };

function input(overrides: Partial<NotifyInput> = {}): NotifyInput {
  return {
    sessionId: "s1",
    reason: "needs-you",
    title: "Fix the flaky test",
    body: "Needs you: run a command",
    ...overrides,
  };
}

describe("showing notifications", () => {
  it("shows the session's title and the reason, with sound left to macOS", async () => {
    const { service, made } = setup();
    expect(await service.show(WINDOW, input())).toBe(true);
    expect(made).toHaveLength(1);
    expect(made[0]?.options).toEqual({
      title: "Fix the flaky test",
      body: "Needs you: run a command",
      silent: false,
    });
    expect(made[0]?.shown).toBe(true);
    expect(service.showing()).toEqual(["s1"]);
  });

  it("shows nothing while a dawg window is focused", async () => {
    const { service, made, focus } = setup();
    focus.any = true;
    expect(await service.show(WINDOW, input())).toBe(false);
    expect(made).toEqual([]);
    focus.any = false;
    expect(await service.show(WINDOW, input())).toBe(true);
  });

  it("shows nothing while Settings → General turns notifications off", async () => {
    const { service, made, change } = setup({ notifications: false });
    expect(await service.show(WINDOW, input())).toBe(false);
    expect(made).toEqual([]);
    change({ notifications: true });
    expect(await service.show(WINDOW, input())).toBe(true);
    change({ notifications: false });
    expect(await service.show(WINDOW, input({ reason: "finished", body: "Finished" }))).toBe(false);
    expect(made).toHaveLength(1);
  });

  it("reads the settings once and follows changes after that", async () => {
    const { service, getSettings } = setup();
    await service.show(WINDOW, input());
    await service.show(WINDOW, input({ sessionId: "s2" }));
    await service.setBadge(WINDOW, 2);
    expect(getSettings).toHaveBeenCalledOnce();
  });

  it("shows nothing where the system has no notifications", async () => {
    const { service, made } = setup({}, { isSupported: () => false });
    expect(await service.show(WINDOW, input())).toBe(false);
    expect(made).toEqual([]);
  });

  it("replaces a session's older notification and keeps other sessions'", async () => {
    const { service, made } = setup();
    await service.show(WINDOW, input());
    await service.show(WINDOW, input({ sessionId: "s2", title: "Add CSV export" }));
    await service.show(WINDOW, input({ reason: "finished", body: "Finished" }));
    expect(made.map((notification) => notification.closed)).toEqual([true, false, false]);
    expect(service.showing()).toEqual(["s2", "s1"]);
    // The replaced one closing late does not drop its replacement.
    made[0]?.dismiss();
    expect(service.showing()).toEqual(["s2", "s1"]);
  });

  it("forgets a notification the person dismissed", async () => {
    const { service, made } = setup();
    await service.show(WINDOW, input());
    made[0]?.dismiss();
    expect(service.showing()).toEqual([]);
  });

  it("returns false and logs without the text when the notification cannot be made", async () => {
    const lines: string[] = [];
    const { service } = setup(
      {},
      {
        createNotification: () => {
          throw new Error("Notifications are not allowed");
        },
        log: (line) => lines.push(line),
      },
    );
    expect(await service.show(WINDOW, input())).toBe(false);
    expect(lines).toEqual(["Could not make a notification: Notifications are not allowed"]);
    expect(lines.join("\n")).not.toContain("Fix the flaky test");
  });

  it("closes every notification when the app quits", async () => {
    const { service, made } = setup();
    await service.show(WINDOW, input());
    await service.show(WINDOW, input({ sessionId: "s2" }));
    service.closeAll();
    expect(made.every((notification) => notification.closed)).toBe(true);
    expect(service.showing()).toEqual([]);
  });
});

describe("clicking a notification", () => {
  it("opens the session in the window that asked and closes its notification", async () => {
    const { service, made, opened, mainWindowOpened } = setup();
    const other: FakeSender = { key: "2", alive: true };
    await service.show(WINDOW, input());
    await service.show(other, input({ sessionId: "s2" }));
    made[1]?.click();
    expect(opened).toEqual([{ window: "2", sessionId: "s2" }]);
    expect(mainWindowOpened).toEqual([]);
    expect(made[1]?.closed).toBe(true);
    expect(made[0]?.closed).toBe(false);
    expect(service.showing()).toEqual(["s1"]);
  });

  it("falls back to the main window when the window that asked has closed", async () => {
    const { service, made, opened, mainWindowOpened } = setup();
    const gone: FakeSender = { key: "3", alive: true };
    await service.show(gone, input());
    gone.alive = false;
    made[0]?.click();
    expect(opened).toEqual([]);
    expect(mainWindowOpened).toEqual(["s1"]);
    expect(service.showing()).toEqual([]);
  });
});

describe("the Dock badge", () => {
  it("shows the count and clears it at 0, without repeating itself", async () => {
    const { service, badges } = setup();
    await service.setBadge(WINDOW, 2);
    await service.setBadge(WINDOW, 2);
    await service.setBadge(WINDOW, 3);
    await service.setBadge(WINDOW, 0);
    expect(badges).toEqual(["2", "3", ""]);
  });

  it("shows nothing while the badge is off, and the latest count once it is on again", async () => {
    const { service, badges, change } = setup({ dockBadge: false });
    await service.setBadge(WINDOW, 2);
    expect(badges).toEqual([]);
    change({ dockBadge: true });
    expect(badges).toEqual(["2"]);
    change({ dockBadge: false });
    expect(badges).toEqual(["2", ""]);
    await service.setBadge(WINDOW, 4);
    expect(badges).toEqual(["2", ""]);
    change({ dockBadge: true });
    expect(badges).toEqual(["2", "", "4"]);
    // Other settings changing leaves the badge alone.
    change({ notifications: false });
    expect(badges).toEqual(["2", "", "4"]);
  });

  it("keeps a change made while the settings were still being read", async () => {
    let release: (value: NotificationSettings) => void = () => {};
    const { service, badges } = setup(
      {},
      {
        getSettings: () =>
          new Promise<NotificationSettings>((resolve) => {
            release = resolve;
          }),
      },
    );
    const pending = service.setBadge(WINDOW, 2);
    service.settingsChanged({ notifications: true, dockBadge: false });
    release({ notifications: true, dockBadge: true });
    await pending;
    expect(badges).toEqual([]);
  });

  it("drops a closed window's count", async () => {
    const { service, badges } = setup();
    await service.setBadge(WINDOW, 1);
    await service.setBadge({ key: "2", alive: true }, 3);
    service.windowClosed("2");
    service.windowClosed("2");
    service.windowClosed("1");
    expect(badges).toEqual(["1", "3", "1", ""]);
  });
});
