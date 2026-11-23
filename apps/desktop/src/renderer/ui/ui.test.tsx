import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { Button, Chip, IconButton, Kbd, Spinner, Tag } from "./index.ts";

describe.each(THEMES)("ui primitives (%s)", (theme) => {
  it("renders a primary button with a keyboard hint and clicks it", async () => {
    const onClick = vi.fn();
    renderInTheme(
      <Button variant="primary" kbd="⏎" onClick={onClick}>
        Allow once
      </Button>,
      theme,
    );
    expect(document.documentElement.dataset.theme).toBe(theme);
    const button = screen.getByRole("button", { name: /allow once/i });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("gives icon buttons an accessible name", () => {
    renderInTheme(<IconButton icon="sidebar" label="Hide the sidebar" active />, theme);
    expect(screen.getByRole("button", { name: "Hide the sidebar" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("renders chips, tags, keys and a labelled spinner", () => {
    renderInTheme(
      <div>
        <Chip icon="folder">tally</Chip>
        <Tag tone="accent">Recommended</Tag>
        <Kbd>⌘N</Kbd>
        <Spinner label="Working" />
      </div>,
      theme,
    );
    expect(screen.getByText("tally")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText("⌘N").tagName).toBe("KBD");
    expect(screen.getByRole("status", { name: "Working" })).toBeInTheDocument();
  });
});
