/** The marker where a forked session's own conversation starts (a rewind's, or a plain fork). */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { type ForkMarkerView, forkBoundary, forkMarkerText } from "./ForkMarker.tsx";
import { Transcript } from "./Transcript.tsx";
import { assistantItem, makeProps, makeView, userItem } from "./testing.ts";

const REWOUND: ForkMarkerView = {
  originalId: "original",
  originalTitle: "Fix the split",
  originalShown: true,
  point: { position: "beforeTurn", turnId: "turn-9" },
};

/** The first turn (copied from the original), then optionally one the fork made itself. */
function items(withOwnTurn: boolean) {
  const copied = [
    userItem({ id: "u2", turnId: "turn-2", text: "Make notes" }),
    assistantItem({ id: "a2", turnId: "turn-2", text: "Made them." }),
  ];
  if (!withOwnTurn) return copied;
  return [
    ...copied,
    userItem({ id: "u12", turnId: "turn-12", text: "Try another way" }),
    assistantItem({ id: "a12", turnId: "turn-12", text: "Done another way." }),
  ];
}

/** The texts of the transcript's rows and the marker, in order. */
function order(): string[] {
  const marker = screen.getByRole("note");
  const texts = ["Make notes", "Made them.", "Try another way"]
    .map((text) => screen.queryByText(text))
    .filter((node): node is HTMLElement => node !== null);
  return [...texts, marker]
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map((node) => (node === marker ? "marker" : (node.textContent ?? "")));
}

describe("forkBoundary", () => {
  it("is the turn's number for a fork from before a turn, else none", () => {
    expect(forkBoundary(REWOUND.point)).toBe(9);
    expect(forkBoundary({ position: "end" })).toBeNull();
    expect(forkBoundary({ position: "beforeTurn", turnId: "t1" })).toBeNull();
  });

  it("says rewound or forked", () => {
    expect(forkMarkerText(REWOUND)).toBe(
      "Rewound from “Fix the split”. The conversation goes on from here; the original is kept.",
    );
    expect(forkMarkerText({ ...REWOUND, originalTitle: null, point: { position: "end" } })).toBe(
      "Forked from the original conversation. The messages above are copied from it.",
    );
  });
});

describe.each(THEMES)("the fork marker (%s)", (theme) => {
  it("goes before the fork's own first message", () => {
    renderInTheme(
      <Transcript {...makeProps({ view: makeView({ items: items(true) }), fork: REWOUND })} />,
      theme,
    );
    expect(order()).toEqual(["Make notes", "Made them.", "marker", "Try another way"]);
  });

  it("goes after the copied conversation while the fork has no message of its own", () => {
    renderInTheme(
      <Transcript {...makeProps({ view: makeView({ items: items(false) }), fork: REWOUND })} />,
      theme,
    );
    expect(order()).toEqual(["Make notes", "Made them.", "marker"]);
  });

  it("opens the original", async () => {
    const user = userEvent.setup();
    const onOpenOriginal = vi.fn();
    renderInTheme(
      <Transcript
        {...makeProps({
          view: makeView({ items: items(false) }),
          fork: REWOUND,
          onOpenOriginal,
        })}
      />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: "Open the original" }));
    expect(onOpenOriginal).toHaveBeenCalled();
  });

  it("is not there for a session that is not a fork", () => {
    renderInTheme(<Transcript {...makeProps({ view: makeView({ items: items(true) }) })} />, theme);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
