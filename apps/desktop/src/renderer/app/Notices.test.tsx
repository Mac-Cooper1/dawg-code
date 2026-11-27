import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionState, Notice } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { Notices } from "./Notices.tsx";

const READY: ConnectionState = { phase: "ready", engine: { name: "mock", version: "1" } };

describe.each(THEMES)("Notices (%s)", (theme) => {
  it("keeps an empty live region when connected with no notices", () => {
    const { container } = renderInTheme(
      <Notices notices={[]} connection={READY} onDismiss={vi.fn()} />,
      theme,
    );
    // Mounted while empty, so a notice that arrives later is read out.
    const region = container.firstElementChild;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
  });

  it("shows a quiet line while connecting and while the engine restarts", () => {
    const { rerender } = renderInTheme(
      <Notices notices={[]} connection={{ phase: "connecting" }} onDismiss={vi.fn()} />,
      theme,
    );
    expect(screen.getByText("Connecting to the engine…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(
      <Notices
        notices={[]}
        connection={{ phase: "restarting", reason: "exit 1" }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("The engine is restarting…")).toBeInTheDocument();
  });

  it("shows a failed connection as an alert that cannot be dismissed", () => {
    renderInTheme(
      <Notices
        notices={[]}
        connection={{ phase: "failed", message: "The engine speaks protocol 2; this app needs 1." }}
        onDismiss={vi.fn()}
      />,
      theme,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The engine speaks protocol 2; this app needs 1.",
    );
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("dismisses a notice", async () => {
    const notices: Notice[] = [
      { id: "n1", text: "The engine restarted. Sessions were resumed.", tone: "neutral" },
      { id: "n2", text: "Could not save settings.", tone: "error" },
    ];
    const onDismiss = vi.fn();
    renderInTheme(<Notices notices={notices} connection={READY} onDismiss={onDismiss} />, theme);
    expect(screen.getByText("The engine restarted. Sessions were resumed.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save settings.");
    const [first] = screen.getAllByRole("button", { name: "Dismiss" });
    if (!first) throw new Error("no dismiss button");
    await userEvent.click(first);
    expect(onDismiss).toHaveBeenCalledWith("n1");
  });

  it("moves focus to the next notice, then to the message field, as notices are dismissed", async () => {
    const notices: Notice[] = [
      { id: "n1", text: "The engine restarted.", tone: "neutral" },
      { id: "n2", text: "Could not save settings.", tone: "error" },
    ];
    const { rerender } = renderInTheme(
      <>
        <Notices notices={notices} onDismiss={vi.fn()} />
        <textarea aria-label="Message to dawg" />
      </>,
      theme,
    );
    const [first] = screen.getAllByRole("button", { name: "Dismiss" });
    if (!first) throw new Error("no dismiss button");
    first.focus();
    await userEvent.keyboard("{Enter}");
    rerender(
      <>
        <Notices notices={notices.slice(1)} onDismiss={vi.fn()} />
        <textarea aria-label="Message to dawg" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    rerender(
      <>
        <Notices notices={[]} onDismiss={vi.fn()} />
        <textarea aria-label="Message to dawg" />
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Message to dawg" })).toHaveFocus();
  });
});
