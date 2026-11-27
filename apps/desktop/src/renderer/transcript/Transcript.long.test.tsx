/**
 * A long transcript: the newest items come first and the older ones follow while the window is
 * idle, in order; and once it is drawn, a streamed delta re-renders the one item that changed.
 * The items are stand-ins that count their renders (the real ones have their own tests).
 */
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../state/types.ts";
import { FIRST_ROWS, Transcript } from "./Transcript.tsx";
import { assistantItem, makeProps, makeView, summaryItem, toolItem, userItem } from "./testing.ts";

const renders = vi.hoisted(() => new Map<string, number>());

vi.mock("./AssistantText.tsx", async () => {
  const { createElement, memo } = await import("react");
  return {
    AssistantText: memo(function AssistantText({ item }: { item: TranscriptItem }) {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return createElement("p", { "data-item": item.id }, "text" in item ? item.text : "");
    }),
  };
});
vi.mock("./UserMessage.tsx", async () => {
  const { createElement, memo } = await import("react");
  return {
    UserMessage: memo(function UserMessage({ item }: { item: TranscriptItem }) {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return createElement("p", { "data-item": item.id });
    }),
  };
});
vi.mock("./ToolCard.tsx", async () => {
  const { createElement, memo } = await import("react");
  return {
    ToolCard: memo(function ToolCard({ item }: { item: TranscriptItem }) {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return createElement("p", { "data-item": item.id });
    }),
  };
});
vi.mock("./TurnSummaryView.tsx", async () => {
  const { createElement, memo } = await import("react");
  return {
    turnSummaryText: () => "",
    TurnSummaryView: memo(function TurnSummaryView({ item }: { item: TranscriptItem }) {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return createElement("p", { "data-item": item.id });
    }),
  };
});

/** `turns` turns of four items each: prompt, a call, the answer, the summary. */
function longTranscript(turns: number): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const turnId = `turn-${turn}`;
    items.push(
      userItem({ id: `user-${turn}`, turnId }),
      toolItem({ id: `tool-${turn}`, turnId }),
      assistantItem({ id: `assistant-${turn}`, turnId, messageId: `message-${turn}` }),
      summaryItem({ id: `summary-${turn}`, turnId }),
    );
  }
  return items;
}

function drawn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-item]")).map(
    (element) => element.getAttribute("data-item") ?? "",
  );
}

beforeEach(() => {
  renders.clear();
});

describe("a long transcript", () => {
  it("draws the newest items first, then the rest in order while idle", async () => {
    const items = longTranscript(250);
    const { container } = render(<Transcript {...makeProps({ view: makeView({ items }) })} />);
    const first = drawn(container);
    expect(first.length).toBeLessThanOrEqual(FIRST_ROWS);
    expect(first).toEqual(items.slice(items.length - first.length).map((item) => item.id));
    expect(first.at(-1)).toBe("summary-249");

    await waitFor(() => expect(drawn(container)).toHaveLength(items.length), { timeout: 10_000 });
    expect(drawn(container)).toEqual(items.map((item) => item.id));
    // Each item was drawn once, however many steps it took.
    expect([...renders.values()].every((count) => count === 1)).toBe(true);
  });

  it("re-renders only the item a delta changed", async () => {
    const items = longTranscript(250);
    const props = makeProps({ view: makeView({ items, working: true, activeTurnId: "turn-249" }) });
    const { container, rerender } = render(<Transcript {...props} />);
    await waitFor(() => expect(drawn(container)).toHaveLength(items.length), { timeout: 10_000 });

    renders.clear();
    const last = items.length - 2;
    const streaming = items[last] as Extract<TranscriptItem, { kind: "assistant" }>;
    for (let delta = 1; delta <= 5; delta++) {
      const next = [...items];
      next[last] = { ...streaming, text: `${streaming.text} more ${delta}` };
      act(() => {
        rerender(<Transcript {...props} view={{ ...props.view, items: next }} />);
      });
    }
    expect(Object.fromEntries(renders)).toEqual({ "assistant-249": 5 });
  });

  it("starts with the newest items again for another session", async () => {
    const items = longTranscript(100);
    const { container, rerender } = render(
      <Transcript {...makeProps({ view: makeView({ items }) })} />,
    );
    await waitFor(() => expect(drawn(container)).toHaveLength(items.length), { timeout: 10_000 });
    const other = longTranscript(100).map((item) => ({ ...item, id: `other-${item.id}` }));
    rerender(
      <Transcript
        {...makeProps({
          sessionId: "session-2",
          view: makeView({ sessionId: "session-2", items: other }),
        })}
      />,
    );
    const first = drawn(container);
    expect(first.length).toBeLessThanOrEqual(FIRST_ROWS);
    expect(first.at(-1)).toBe("other-summary-99");
    await waitFor(() => expect(drawn(container)).toHaveLength(other.length), { timeout: 10_000 });
  });
});
