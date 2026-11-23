import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { Transcript } from "./Transcript.tsx";
import {
  assistantItem,
  bashFailure,
  editItem,
  makeProps,
  makeView,
  permissionItem,
  readItem,
  summaryItem,
  tasksItem,
  toolItem,
  userItem,
} from "./testing.ts";

/** Gives the scroller fixed sizes, since jsdom does no layout. */
function sizeScroller(
  scroller: HTMLElement,
  sizes: { scrollHeight: number; clientHeight: number },
) {
  let top = 0;
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => sizes.scrollHeight,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => sizes.clientHeight,
  });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, sizes.scrollHeight - sizes.clientHeight));
    },
  });
}

const FIRST_TURN: TranscriptItem[] = [
  userItem(),
  bashFailure({ id: "tool-a" }),
  readItem({ id: "tool-b" }),
  editItem({ id: "tool-c" }),
  toolItem({ id: "tool-d" }),
  assistantItem(),
  summaryItem(),
];

describe.each(THEMES)("Transcript (%s)", (theme) => {
  it("is a labelled log of the items in order", () => {
    renderInTheme(<Transcript {...makeProps({ view: makeView({ items: FIRST_TURN }) })} />, theme);
    expect(screen.getByRole("region", { name: "Transcript" })).toHaveAttribute(
      "data-session",
      "session-1",
    );
    const log = screen.getByRole("log", { name: "Transcript" });
    expect(log).toHaveAttribute("aria-live", "off");
    const text = log.textContent ?? "";
    const order = ["test_split_evenly", "Ran", "Read", "Edited", "Fixed.", "48 s"].map((part) =>
      text.indexOf(part),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it("shows a quiet loading line, then a hint for an empty session", () => {
    const { rerender } = renderInTheme(
      <Transcript {...makeProps({ view: makeView({ loaded: false }) })} />,
      theme,
    );
    expect(screen.getByText("Loading the conversation…")).toBeInTheDocument();
    rerender(<Transcript {...makeProps({ view: makeView({ loaded: true }) })} />);
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
  });

  it("opens what needs a look by default in smart mode, and follows the setting", () => {
    const { rerender } = renderInTheme(
      <Transcript {...makeProps({ view: makeView({ items: FIRST_TURN }) })} />,
      theme,
    );
    const expanded = (name: RegExp) =>
      screen.getByRole("button", { name }).getAttribute("aria-expanded");
    expect(expanded(/^Ran .*exit 1/)).toBe("true");
    expect(expanded(/^Read /)).toBe("false");
    expect(expanded(/^Edited /)).toBe("true");
    expect(expanded(/^Ran .*exit 0/)).toBe("false");

    rerender(
      <Transcript
        {...makeProps({ view: makeView({ items: FIRST_TURN, toolCallDisplay: "open" }) })}
      />,
    );
    for (const name of [/^Ran .*exit 1/, /^Read /, /^Edited /, /^Ran .*exit 0/]) {
      expect(expanded(name)).toBe("true");
    }

    rerender(
      <Transcript
        {...makeProps({ view: makeView({ items: FIRST_TURN, toolCallDisplay: "closed" }) })}
      />,
    );
    for (const name of [/^Ran .*exit 1/, /^Read /, /^Edited /, /^Ran .*exit 0/]) {
      expect(expanded(name)).toBe("false");
    }

    rerender(
      <Transcript
        {...makeProps({
          view: makeView({
            items: FIRST_TURN,
            toolCallDisplay: "closed",
            openItems: { "tool-b": true },
          }),
        })}
      />,
    );
    expect(expanded(/^Read /)).toBe("true");
  });

  it("passes toggles and answers up with the item and request ids", async () => {
    const user = userEvent.setup();
    const props = makeProps({ view: makeView({ items: [...FIRST_TURN, permissionItem()] }) });
    renderInTheme(<Transcript {...props} />, theme);
    await user.click(screen.getByRole("button", { name: /^Read / }));
    expect(props.onSetItemOpen).toHaveBeenCalledWith("tool-b", true);
    await user.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(props.onRespondPermission).toHaveBeenCalledWith("perm-1", {
      behavior: "allow",
      scope: "once",
    });
  });

  it("hides a tool call while its permission waits, and after the person denied it", () => {
    const pending = permissionItem();
    const call = toolItem({
      id: "tool-perm",
      input: { command: "uv add --dev pytest-repeat" },
      state: "running",
      content: null,
      display: null,
      permissionRequestId: "perm-1",
    });
    const { rerender } = renderInTheme(
      <Transcript {...makeProps({ view: makeView({ items: [pending, call] }) })} />,
      theme,
    );
    expect(screen.getByRole("region", { name: /Permission needed/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Running uv add/ })).toBeNull();

    const denied = permissionItem({ state: "answered", response: { behavior: "deny" } });
    rerender(
      <Transcript
        {...makeProps({ view: makeView({ items: [denied, { ...call, state: "denied" }] }) })}
      />,
    );
    expect(screen.getByText("You denied it")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /uv add/ })).toBeNull();

    const allowed = permissionItem({
      state: "answered",
      response: { behavior: "allow", scope: "once" },
    });
    rerender(<Transcript {...makeProps({ view: makeView({ items: [allowed, call] }) })} />);
    expect(screen.getByText("You allowed this once")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Running uv add --dev pytest-repeat/ }),
    ).toBeInTheDocument();
  });

  it("marks a message sent from the queue", () => {
    const items = [
      ...FIRST_TURN,
      userItem({ id: "user-2", turnId: "turn-2", text: "Also update the README example." }),
    ];
    renderInTheme(
      <Transcript
        {...makeProps({ view: makeView({ items, queuedTurnIds: { "turn-2": true } }) })}
      />,
      theme,
    );
    const divider = screen.getByText("Queued message sent");
    const message = screen.getByText("Also update the README example.");
    expect(
      divider.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByText("Queued message sent")).toHaveLength(1);
  });

  it("shows prompt-reading progress at the bottom", () => {
    renderInTheme(
      <Transcript
        {...makeProps({
          view: makeView({
            items: FIRST_TURN,
            working: true,
            promptProgress: {
              turnId: "turn-2",
              total: 24_410,
              cached: 14_080,
              processed: 18_240,
              tokensPerSecond: 1_240,
              secondsLeft: 4,
            },
          }),
        })}
      />,
      theme,
    );
    expect(
      screen.getByRole("progressbar", { name: "Reading the conversation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Reading the conversation · 18,240 of 24,410 tokens"),
    ).toBeInTheDocument();
  });

  it("lists tasks while their turn runs and folds them once it finished", () => {
    const tasks = tasksItem({ turnId: "turn-2" });
    const running = [userItem({ id: "user-2", turnId: "turn-2" }), tasks];
    const { rerender } = renderInTheme(
      <Transcript
        {...makeProps({
          view: makeView({ items: running, working: true, activeTurnId: "turn-2" }),
        })}
      />,
      theme,
    );
    expect(screen.getByRole("region", { name: "Tasks" })).toHaveTextContent("1 of 3 done");
    // A later turn running does not make an earlier turn's tasks live again.
    rerender(
      <Transcript
        {...makeProps({
          view: makeView({ items: running, working: true, activeTurnId: "turn-3" }),
        })}
      />,
    );
    expect(screen.queryByRole("region", { name: "Tasks" })).toBeNull();
    rerender(
      <Transcript
        {...makeProps({
          view: makeView({ items: running, working: true, activeTurnId: "turn-2" }),
        })}
      />,
    );
    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
    rerender(
      <Transcript
        {...makeProps({
          view: makeView({
            items: [...running, summaryItem({ turnId: "turn-2" })],
            working: false,
          }),
        })}
      />,
    );
    expect(screen.queryByRole("region", { name: "Tasks" })).toBeNull();
    expect(screen.getByRole("button", { name: "Tasks, 1 of 3 done" })).toBeInTheDocument();
  });

  it("follows new output until the person scrolls up, then offers Jump to latest", async () => {
    const user = userEvent.setup();
    const sizes = { scrollHeight: 2000, clientHeight: 500 };
    const props = makeProps({ view: makeView({ items: FIRST_TURN, working: true }) });
    const { rerender } = renderInTheme(<Transcript {...props} />, theme);
    const scroller = screen.getByRole("log", { name: "Transcript" });
    sizeScroller(scroller, sizes);

    // New output arrives: the view stays at the bottom.
    sizes.scrollHeight = 2400;
    const streaming = assistantItem({ id: "assistant-2", text: "Working", streaming: true });
    rerender(
      <Transcript
        {...props}
        view={makeView({ items: [...FIRST_TURN, streaming], working: true })}
      />,
    );
    expect(scroller.scrollTop).toBe(1900);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    // The person scrolls up: following stops.
    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    const jump = await screen.findByRole("button", { name: "Jump to latest" });
    sizes.scrollHeight = 2800;
    rerender(
      <Transcript
        {...props}
        view={makeView({
          items: [...FIRST_TURN, { ...streaming, text: "Working in cents now" }],
          working: true,
        })}
      />,
    );
    expect(scroller.scrollTop).toBe(600);

    // Jump to latest scrolls down (smoothly) and resumes following.
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollTop = options.top ?? 0;
    });
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    await user.click(jump);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2800, behavior: "smooth" });
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    sizes.scrollHeight = 3200;
    rerender(
      <Transcript
        {...props}
        view={makeView({
          items: [...FIRST_TURN, { ...streaming, text: "Working in cents now. Done." }],
          working: true,
        })}
      />,
    );
    expect(scroller.scrollTop).toBe(2700);
  });

  it("resumes following when the person scrolls back to the bottom", async () => {
    const sizes = { scrollHeight: 2000, clientHeight: 500 };
    renderInTheme(<Transcript {...makeProps({ view: makeView({ items: FIRST_TURN }) })} />, theme);
    const scroller = screen.getByRole("log", { name: "Transcript" });
    sizeScroller(scroller, sizes);
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
    scroller.scrollTop = 1490;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("announces finished turns and new decisions politely, not history or deltas", () => {
    const props = makeProps({ view: makeView({ items: FIRST_TURN }) });
    const { rerender } = renderInTheme(<Transcript {...props} />, theme);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toBeEmptyDOMElement();

    const next = [...FIRST_TURN, userItem({ id: "user-2", turnId: "turn-2" })];
    const streaming = assistantItem({ id: "a2", turnId: "turn-2", text: "Look", streaming: true });
    rerender(
      <Transcript {...props} view={makeView({ items: [...next, streaming], working: true })} />,
    );
    expect(status).toBeEmptyDOMElement();

    const perm = permissionItem({ id: "p2", turnId: "turn-2" });
    rerender(
      <Transcript
        {...props}
        view={makeView({ items: [...next, streaming, perm], working: true })}
      />,
    );
    expect(status).toHaveTextContent("dawg needs permission: Run a shell command");

    act(() => {
      rerender(
        <Transcript
          {...props}
          view={makeView({
            items: [
              ...next,
              { ...streaming, streaming: false },
              summaryItem({ id: "s2", turnId: "turn-2", durationMs: 12_000, modelRequests: 2 }),
            ],
          })}
        />,
      );
    });
    expect(status).toHaveTextContent("dawg finished. 12 s · 2 model requests");
    expect(within(status).queryByText(/Look/)).toBeNull();
  });
});
