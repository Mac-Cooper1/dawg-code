import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";

function setup(theme: "dark" | "light", edge: "left" | "right", value = 300) {
  const onChange = vi.fn();
  renderInTheme(
    <ResizeHandle
      label="Resize the sidebar"
      value={value}
      min={200}
      max={420}
      defaultValue={264}
      edge={edge}
      onChange={onChange}
    />,
    theme,
  );
  return { onChange, handle: screen.getByRole("separator", { name: "Resize the sidebar" }) };
}

describe.each(THEMES)("ResizeHandle (%s)", (theme) => {
  it("is a focusable vertical separator reporting its width", async () => {
    const { handle } = setup(theme, "right");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "300");
    expect(handle).toHaveAttribute("aria-valuemin", "200");
    expect(handle).toHaveAttribute("aria-valuemax", "420");
    await userEvent.tab();
    expect(handle).toHaveFocus();
  });

  it("moves its edge with the arrow keys: on a right edge, right widens", async () => {
    const { handle, onChange } = setup(theme, "right");
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(316);
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(284);
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(364);
  });

  it("on a left edge, left widens", async () => {
    const { handle, onChange } = setup(theme, "left");
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(316);
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(284);
  });

  it("jumps to the limits with Home and End, and stays within them", async () => {
    const { handle, onChange } = setup(theme, "right", 410);
    handle.focus();
    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith(200);
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith(420);
    onChange.mockClear();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(420);
  });

  it("follows a pointer drag and restores the default on double click", () => {
    const { handle, onChange } = setup(theme, "right");
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(340);
    fireEvent.pointerUp(handle, { clientX: 140, pointerId: 1 });
    onChange.mockClear();
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.doubleClick(handle);
    expect(onChange).toHaveBeenLastCalledWith(264);
  });
});
