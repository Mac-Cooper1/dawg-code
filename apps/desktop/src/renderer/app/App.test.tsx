import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DawgBridge, ResolvedTheme } from "../../shared/bridge.ts";
import { setBridgeForTests } from "../bridge/index.ts";
import type { AppState, ConnectionState, Layout } from "../state/types.ts";
import { THEMES } from "../test/render.tsx";
import type { TranscriptProps } from "../transcript/contract.ts";
import { App } from "./App.tsx";
import {
  createTestStore,
  HOME,
  renderWithStore,
  resetTestViews,
  sampleComposer,
  sampleSidebar,
  sampleTranscript,
  type TestViews,
} from "./testing.tsx";

vi.mock("../state/selectors.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./testing.tsx")).mockedSelectors,
}));

// The transcript is built separately; here only its wiring matters.
const transcript = vi.hoisted(() => ({ props: null as TranscriptProps | null }));
vi.mock("../transcript/Transcript.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Transcript: (props: TranscriptProps) => {
      transcript.props = props;
      return createElement("section", { "aria-label": "Transcript" });
    },
  };
});

const READY: ConnectionState = { phase: "ready", engine: { name: "mock", version: "1" } };

function setup(
  theme: ResolvedTheme,
  options: {
    state?: Partial<AppState>;
    layout?: Partial<Layout>;
    views?: Partial<TestViews>;
  } = {},
) {
  resetTestViews({
    sidebar: sampleSidebar(),
    composer: { fix: sampleComposer() },
    transcript: { fix: sampleTranscript("fix") },
    ...options.views,
  });
  const test = createTestStore((state) => ({
    connection: READY,
    // The test theme is applied by the app itself, from the appearance setting.
    settings: { ...state.settings, appearance: theme },
    ...options.state,
    layout: { ...state.layout, selectedSessionId: "fix", ...options.layout },
  }));
  renderWithStore(<App />, { theme, store: test.store });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  return { ...test, user };
}

afterEach(() => {
  transcript.props = null;
  setBridgeForTests(null);
});

describe.each(THEMES)("App (%s)", (theme) => {
  it("lays out the title bar, sidebar, transcript and composer", () => {
    setup(theme);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize the sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message to dawg" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Side panes" })).not.toBeInTheDocument();
  });

  it("offers to start a session when none is selected", async () => {
    const { user, actions } = setup(theme, {
      layout: { selectedSessionId: null },
    });
    expect(screen.getByRole("heading", { name: "Start a session" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message to dawg" })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("main")).getByRole("button", { name: /New session/ }));
    expect(actions.newSession).toHaveBeenCalledWith();
  });

  it("hides and shows the sidebar with ⌘B and with the title-bar button", async () => {
    const { user, actions } = setup(theme);
    await user.keyboard("{Meta>}b{/Meta}");
    expect(actions.setSidebarOpen).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("navigation", { name: "Sessions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize the sidebar" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show the sidebar" }));
    expect(screen.getByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide the sidebar" }));
    expect(actions.setSidebarOpen).toHaveBeenLastCalledWith(false);
  });

  it("starts a new session with ⌘N and focuses the search with ⌘K", async () => {
    const { user, actions } = setup(theme);
    await user.keyboard("{Meta>}n{/Meta}");
    expect(actions.newSession).toHaveBeenCalledOnce();

    await user.keyboard("{Meta>}b{/Meta}");
    await user.keyboard("{Meta>}k{/Meta}");
    expect(actions.setSidebarOpen).toHaveBeenLastCalledWith(true);
    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: "Search sessions" })).toHaveFocus(),
    );
  });

  it("opens Settings with ⌘, and comes back", async () => {
    const { user, actions } = setup(theme);
    await user.keyboard("{Meta>},{/Meta}");
    expect(actions.setView).toHaveBeenLastCalledWith("settings");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Sessions" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to sessions" }));
    expect(screen.getByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
  });

  it("interrupts a working session with Esc", async () => {
    const { user, actions } = setup(theme, {
      views: { composer: { fix: sampleComposer({ working: true, status: "working" }) } },
    });
    await user.keyboard("{Escape}");
    expect(actions.interrupt).toHaveBeenCalledWith("fix");
  });

  it("leaves Esc alone when nothing is working", async () => {
    const { user, actions } = setup(theme);
    await user.keyboard("{Escape}");
    expect(actions.interrupt).not.toHaveBeenCalled();
  });

  it("lets an open menu or the command menu take Esc first", async () => {
    const { user, actions } = setup(theme, {
      views: { composer: { fix: sampleComposer({ working: true, status: "working" }) } },
    });
    await user.click(screen.getByRole("button", { name: "Permission mode: Accept edits" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(actions.interrupt).not.toHaveBeenCalled();

    await user.click(screen.getByRole("textbox", { name: "Message to dawg" }));
    await user.keyboard("/");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
    expect(actions.interrupt).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(actions.interrupt).toHaveBeenCalledWith("fix");
  });

  it("resizes the sidebar and the dock from the keyboard", async () => {
    const { user, actions } = setup(theme, {
      layout: { dockOpen: true, dockPane: "files" },
    });
    screen.getByRole("separator", { name: "Resize the sidebar" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(actions.setSidebarWidth).toHaveBeenLastCalledWith(280);
    expect(screen.getByRole("navigation", { name: "Sessions" })).toHaveStyle({ width: "280px" });

    screen.getByRole("separator", { name: "Resize the panes" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(actions.setDockWidth).toHaveBeenLastCalledWith(576);
    expect(screen.getByRole("complementary", { name: "Side panes" })).toHaveStyle({
      width: "576px",
    });
  });

  it("opens the dock from the title bar and closes it", async () => {
    const { user, actions } = setup(theme);
    const panes = within(screen.getByRole("navigation", { name: "Side panes" }));
    await user.click(panes.getByRole("button", { name: "Files" }));
    expect(actions.openPane).toHaveBeenLastCalledWith("files");
    const dock = screen.getByRole("complementary", { name: "Side panes" });
    expect(within(dock).getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(panes.getByRole("button", { name: "Files" })).toHaveAttribute("aria-pressed", "true");

    await user.click(panes.getByRole("button", { name: "Files" }));
    expect(actions.closeDock).toHaveBeenCalledOnce();
    expect(screen.queryByRole("complementary", { name: "Side panes" })).not.toBeInTheDocument();

    await user.click(panes.getByRole("button", { name: /^Tasks/ }));
    await user.click(screen.getByRole("button", { name: "Close the panes" }));
    expect(screen.queryByRole("complementary", { name: "Side panes" })).not.toBeInTheDocument();
  });

  it("shows notices and dismisses them", async () => {
    const { user, actions } = setup(theme, {
      state: {
        notices: [
          {
            id: "restart",
            text: "The engine restarted. Sessions were resumed from their transcripts.",
            tone: "neutral",
          },
        ],
      },
    });
    expect(
      screen.getByText("The engine restarted. Sessions were resumed from their transcripts."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(actions.dismissNotice).toHaveBeenCalledWith("restart");
    expect(screen.queryByText(/The engine restarted/)).not.toBeInTheDocument();
  });

  it("cannot send while connecting", async () => {
    const { user, actions } = setup(theme, { state: { connection: { phase: "connecting" } } });
    expect(screen.getByText("Connecting to the engine…")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Message to dawg" }), "hello{Enter}");
    expect(actions.submit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it("disables the composer when the connection failed", () => {
    setup(theme, {
      state: { connection: { phase: "failed", message: "The engine is too old for this app." } },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("The engine is too old for this app.");
    expect(screen.getByRole("textbox", { name: "Message to dawg" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("saves the opposite appearance from the title bar and repaints", async () => {
    const { user, actions } = setup(theme);
    const next = theme === "dark" ? "light" : "dark";
    expect(actions.setResolvedTheme).toHaveBeenLastCalledWith(theme);
    await user.click(screen.getByRole("button", { name: `Switch to ${next} appearance` }));
    expect(actions.setAppearance).toHaveBeenCalledWith(next);
    expect(document.documentElement.dataset.theme).toBe(next);
    expect(actions.setResolvedTheme).toHaveBeenLastCalledWith(next);
    expect(
      screen.getByRole("button", { name: `Switch to ${theme} appearance` }),
    ).toBeInTheDocument();
  });

  it("wires the transcript to the session and its actions", async () => {
    const openExternal = vi.fn(async () => {});
    setBridgeForTests({ shell: { openExternal } } as unknown as DawgBridge);
    const { user, actions } = setup(theme);
    const props = transcript.props;
    if (!props) throw new Error("the transcript was not rendered");
    expect(props.sessionId).toBe("fix");
    expect(props.homeDir).toBe(HOME);
    expect(props.view.cwd).toBe(`${HOME}/code/tally`);
    expect(props.autoFocusPendingCard).toBe(true);
    expect(props.onOpenInChanges).toBeUndefined();

    act(() => {
      props.onSetItemOpen("tool-1", true);
      props.onShowCardAgain("req-1", true);
      props.onRespondPermission("req-1", { decision: "allow-once" } as never);
      props.onRespondQuestion("req-2", { answers: [] } as never);
      props.onRespondPlan("req-3", { decision: "approve" } as never);
      props.onOpenLink("https://example.com/docs");
    });
    expect(actions.setItemOpen).toHaveBeenCalledWith("fix", "tool-1", true);
    expect(actions.setShownAgain).toHaveBeenCalledWith("fix", "req-1", true);
    expect(actions.respondPermission).toHaveBeenCalledWith("fix", "req-1", {
      decision: "allow-once",
    });
    expect(actions.respondQuestion).toHaveBeenCalledWith("fix", "req-2", { answers: [] });
    expect(actions.respondPlan).toHaveBeenCalledWith("fix", "req-3", { decision: "approve" });
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://example.com/docs"));

    // With text in the composer, a new card must not take the focus.
    await user.type(screen.getByRole("textbox", { name: "Message to dawg" }), "wait");
    expect(transcript.props?.autoFocusPendingCard).toBe(false);
  });
});
