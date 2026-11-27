/** A permission card a subagent raised: it says which agent asks, and answers like any other. */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  applyLive,
  createStream,
  makeSummary,
  openSession,
} from "../state/__fixtures__/streams.ts";
import type { PermissionItem } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { makeEnv, permissionItem, permissionRequest } from "../transcript/testing.ts";
import { PermissionCard } from "./PermissionCard.tsx";

const AGENT = {
  agentId: "agent-1",
  sessionId: "session-1-agent-1",
  agentType: "Explore",
  description: "Find the config loader",
};

function agentItem(overrides: Partial<PermissionItem> = {}): PermissionItem {
  return permissionItem({ request: permissionRequest({ agent: AGENT }), ...overrides });
}

describe.each(THEMES)("PermissionCard from a subagent (%s)", (theme) => {
  it("says which agent asks, and allows once", () => {
    const respondPermission = vi.fn();
    const item = agentItem();
    renderInTheme(
      <PermissionCard
        item={item}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv({ respondPermission })}
      />,
      theme,
    );
    const card = screen.getByRole("region", {
      name: "Permission needed for the Explore agent: Find the config loader: Run a shell command",
    });
    expect(within(card).getByText("Explore agent: Find the config loader")).toBeInTheDocument();
    expect(card).toHaveTextContent("Asked by Explore agent: Find the config loader");
    fireEvent.click(within(card).getByRole("button", { name: /Allow once/ }));
    expect(respondPermission).toHaveBeenCalledWith(item.requestId, {
      behavior: "allow",
      scope: "once",
    });
  });

  it("keeps the agent in the record once answered, and on the card shown again", () => {
    const item = agentItem({
      state: "answered",
      response: { behavior: "deny", message: "Read it instead" },
    });
    const { rerender } = renderInTheme(
      <PermissionCard item={item} shownAgain={false} autoFocus={false} env={makeEnv()} />,
      theme,
    );
    expect(
      screen.getByText(/You denied it · note sent: “Read it instead” · Explore agent: Find the/),
    ).toBeInTheDocument();
    rerender(<PermissionCard item={item} shownAgain autoFocus={false} env={makeEnv()} />);
    expect(
      screen.getByRole("region", {
        name: "Permission, answered for the Explore agent: Find the config loader: Run a shell command",
      }),
    ).toBeInTheDocument();
  });

  it("is a pending card of the parent even when its turn is the agent's", () => {
    // The parent is idle while a background agent asks: the request names the agent's turn.
    const s = createStream("s1");
    s.emit("permission.requested", {
      turnId: "agent-turn-1",
      request: { ...permissionRequest({ agent: AGENT }), toolCallId: "agent-call-1" },
    });
    const slice = applyLive(openSession(makeSummary("s1")), s.events);
    const items = slice.transcripts.s1 ?? [];
    expect(items.map((entry) => entry.kind)).toEqual(["permission"]);
    expect(slice.pending.s1).toEqual([
      expect.objectContaining({ kind: "permission", turnId: "agent-turn-1" }),
    ]);
  });
});
