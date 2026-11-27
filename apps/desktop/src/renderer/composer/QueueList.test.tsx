import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { imagesNotKeptText, QueueList } from "./QueueList.tsx";

describe.each(THEMES)("QueueList (%s)", (theme) => {
  it("says why a message brought back after a relaunch is held, and that its images were not kept", () => {
    const onSendNow = vi.fn();
    renderInTheme(
      <QueueList
        queue={[
          { id: "a", text: "then this", state: "held", restored: true, imagesNotKept: 2 },
          { id: "b", text: "stopped one", state: "held" },
          { id: "c", text: "next", state: "queued" },
        ]}
        onSendNow={onSendNow}
        onRemove={vi.fn()}
      />,
      theme,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Held: then this · not sent before dawg-code quit");
    expect(items[0]).toHaveTextContent("Its 2 images were not kept when dawg-code quit.");
    expect(items[1]).toHaveTextContent("not sent, because you stopped the turn");
    expect(items[1]).not.toHaveTextContent("not kept");
    expect(items[2]).toHaveTextContent("Queued: next · sends when this turn ends");
    // Held messages, restored or not, offer Send now; a queued one does not.
    expect(screen.getAllByRole("button", { name: "Send now" })).toHaveLength(2);
  });
});

describe("imagesNotKeptText", () => {
  it("counts in words a person reads", () => {
    expect(imagesNotKeptText(1, "its")).toBe("Its image was not kept when dawg-code quit.");
    expect(imagesNotKeptText(1, "draft")).toBe(
      "The image attached here was not kept when dawg-code quit.",
    );
    expect(imagesNotKeptText(3, "draft")).toBe(
      "The 3 images attached here were not kept when dawg-code quit.",
    );
  });
});
