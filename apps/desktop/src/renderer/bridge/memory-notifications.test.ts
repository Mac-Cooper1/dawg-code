/** The in-memory bridge's notifications: recorded as main would show them, for tests and previews. */
import { describe, expect, it, vi } from "vitest";
import type { NotifyInput } from "../../shared/bridge.ts";
import { createMemoryBridge } from "./memory.ts";

const INPUT: NotifyInput = {
  sessionId: "s1",
  reason: "finished",
  title: "Split the bill",
  body: "Finished",
};

describe("memory bridge notifications", () => {
  it("records what it shows, and shows nothing while notifications are off", async () => {
    const bridge = createMemoryBridge({ storage: null });
    expect(await bridge.notifications.show(INPUT)).toBe(true);
    await bridge.settings.update({ notifications: false });
    expect(await bridge.notifications.show({ ...INPUT, sessionId: "s2" })).toBe(false);
    expect(bridge.notificationsShown).toEqual([INPUT]);
  });

  it("refuses what main would refuse", async () => {
    const bridge = createMemoryBridge({ storage: null });
    await expect(bridge.notifications.show({ ...INPUT, title: "" })).rejects.toThrow();
    await expect(bridge.notifications.setBadge(-1)).rejects.toThrow();
    expect(bridge.notificationsShown).toEqual([]);
    expect(bridge.badgeCounts).toEqual([]);
  });

  it("records badge counts and hands a clicked notification's session to listeners", async () => {
    const bridge = createMemoryBridge({ storage: null });
    await bridge.notifications.setBadge(2);
    await bridge.notifications.setBadge(0);
    expect(bridge.badgeCounts).toEqual([2, 0]);

    const listener = vi.fn();
    const stop = bridge.notifications.onOpenSession(listener);
    bridge.openSessionFromNotification("s1");
    stop();
    bridge.openSessionFromNotification("s2");
    expect(listener.mock.calls).toEqual([["s1"]]);
  });
});
