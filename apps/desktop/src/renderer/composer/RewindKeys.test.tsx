/** Esc twice in the composer, with the field empty and nothing running, opens the rewind dialog. */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleComposer, TEST_MODELS } from "../app/testing.tsx";
import type { ComposerView } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { Composer, REWIND_ESCAPE_MS } from "./Composer.tsx";

afterEach(() => {
  vi.useRealTimers();
});

function setup(theme: "dark" | "light", view: Partial<ComposerView> = {}) {
  const onRewind = vi.fn();
  const onInterrupt = vi.fn();
  renderInTheme(
    <Composer
      view={sampleComposer({ draft: "", ...view })}
      models={TEST_MODELS}
      canSend
      attachments={[]}
      mentionPaths={[]}
      onDraftChange={vi.fn()}
      onSubmit={vi.fn()}
      onFindFiles={vi.fn(async () => ({ matches: [], truncated: false }))}
      onAddAttachments={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onRememberMention={vi.fn()}
      onInterrupt={onInterrupt}
      onSetMode={vi.fn()}
      onCycleMode={vi.fn()}
      onSetModel={vi.fn()}
      onSetEffort={vi.fn()}
      onCompact={vi.fn()}
      onSendQueuedNow={vi.fn()}
      onRemoveQueued={vi.fn()}
      onManageModels={vi.fn()}
      onRewind={onRewind}
    />,
    theme,
  );
  const field = screen.getByRole("textbox", { name: "Message to dawg" });
  const esc = () => fireEvent.keyDown(field, { key: "Escape" });
  return { onRewind, onInterrupt, esc };
}

describe.each(THEMES)("Esc twice in the composer (%s)", (theme) => {
  it("opens rewind when pressed twice quickly", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { onRewind, esc } = setup(theme);
    esc();
    expect(onRewind).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REWIND_ESCAPE_MS - 100);
    esc();
    expect(onRewind).toHaveBeenCalledTimes(1);
    // A third press starts over.
    esc();
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the presses are too far apart", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { onRewind, esc } = setup(theme);
    esc();
    vi.advanceTimersByTime(REWIND_ESCAPE_MS + 100);
    esc();
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("does nothing with text in the field", () => {
    const { onRewind, esc } = setup(theme, { draft: "half a thought" });
    esc();
    esc();
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("does nothing while dawg works", () => {
    const { onRewind, esc } = setup(theme, { status: "working", working: true });
    esc();
    esc();
    expect(onRewind).not.toHaveBeenCalled();
  });
});
