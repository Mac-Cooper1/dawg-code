import type { PermissionRequest, WebFetchDisplay, WebSearchDisplay } from "@dawg/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PermissionCard } from "../cards/PermissionCard.tsx";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { makeEnv, permissionItem, toolItem } from "./testing.ts";
import { toolMeta } from "./toolInfo.ts";

const PAGE: WebFetchDisplay = {
  kind: "web-fetch",
  url: "https://docs.example.com/guide/install",
  status: 200,
  contentType: "text/html",
  bytes: 14_336,
  chars: 9_120,
  preview: "# Install\n\nRun the installer, then sign in.",
  redirectUrl: null,
  answeredBy: "model",
  cached: false,
};

const RESULTS: WebSearchDisplay = {
  kind: "web-search",
  query: "vitest fake timers",
  provider: "Brave Search",
  results: [
    {
      title: "Timers | Vitest",
      url: "https://vitest.dev/guide/mocking/timers",
      snippet: "Use vi.useFakeTimers() to control time.",
    },
    { title: "Timer mocks", url: "https://jestjs.io/docs/timer-mocks", snippet: "" },
  ],
};

const fetchItem = (display: WebFetchDisplay | null, state: "success" | "error" = "success") =>
  toolItem({
    toolName: "WebFetch",
    input: { url: "https://docs.example.com/guide/install", prompt: "How do I install it?" },
    state,
    content: [{ type: "text", text: "Fetched it." }],
    display,
  });

const searchItem = (display: WebSearchDisplay) =>
  toolItem({ toolName: "WebSearch", input: { query: display.query }, display, content: [] });

describe.each(THEMES)("web tool cards (%s)", (theme) => {
  it("shows a fetched page: where, status, size and a short preview", () => {
    renderInTheme(<ToolCard item={fetchItem(PAGE)} open env={makeEnv()} />, theme);
    expect(
      screen.getByRole("button", { name: "Fetched docs.example.com/guide/install, 14 KB" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: PAGE.url })).toBeInTheDocument();
    expect(screen.getByText("200 · text/html · 14 KB · 9,120 characters")).toBeInTheDocument();
    expect(screen.getByText(/The utility model read the page/)).toBeInTheDocument();
    expect(screen.getByText(/Run the installer/)).toBeInTheDocument();
  });

  it("says a page came from the cache", () => {
    renderInTheme(
      <ToolCard
        item={fetchItem({ ...PAGE, cached: true, answeredBy: "page" })}
        open
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText(/From the 15-minute cache/)).toBeInTheDocument();
    expect(screen.getByText(/The page text was given to the model/)).toBeInTheDocument();
  });

  it("shows a redirect to another host as not followed", () => {
    const moved = {
      ...PAGE,
      status: 301,
      redirectUrl: "https://other.example.org/install",
      preview: "",
      bytes: 0,
      chars: 0,
    };
    renderInTheme(<ToolCard item={fetchItem(moved)} open env={makeEnv()} />, theme);
    expect(screen.getByRole("button", { name: /moved to another host/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "https://other.example.org/install" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not followed/)).toBeInTheDocument();
  });

  it("shows why a fetch was refused, with the URL asked for", () => {
    const refused = toolItem({
      toolName: "WebFetch",
      input: { url: "http://127.0.0.1:8080/admin", prompt: "x" },
      state: "error",
      content: [
        {
          type: "text",
          text: "Error: WebFetch does not fetch local or private addresses: 127.0.0.1 is this machine (loopback).",
        },
      ],
      display: null,
    });
    renderInTheme(<ToolCard item={refused} open env={makeEnv()} />, theme);
    expect(
      screen.getByRole("button", { name: /^Fetched 127\.0\.0\.1:8080\/admin, failed/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not fetch local or private addresses/)).toBeInTheDocument();
    expect(
      screen.getByText(/127\.0\.0\.1:8080\/admin/, { selector: "pre *, pre" }),
    ).toBeInTheDocument();
  });

  it("lists search results as links that ask before opening in the browser", async () => {
    const env = makeEnv();
    renderInTheme(<ToolCard item={searchItem(RESULTS)} open env={env} />, theme);
    expect(
      screen.getByRole("button", { name: "Searched the web vitest fake timers, 2 results" }),
    ).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Results from Brave Search" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("vitest.dev")).toBeInTheDocument();
    expect(within(list).getByText("Use vi.useFakeTimers() to control time.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(list).getByRole("button", { name: "Timers | Vitest" }));
    expect(env.openLink).not.toHaveBeenCalled();
    expect(screen.getByText("https://vitest.dev/guide/mocking/timers")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(env.openLink).toHaveBeenCalledWith("https://vitest.dev/guide/mocking/timers");
  });

  it("says when a search found nothing", () => {
    renderInTheme(
      <ToolCard item={searchItem({ ...RESULTS, results: [] })} open env={makeEnv()} />,
      theme,
    );
    expect(screen.getByText("No results from Brave Search.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /no results/ })).toBeInTheDocument();
  });

  it("puts the whole URL in the permission card", () => {
    const request: PermissionRequest = {
      requestId: "r1",
      toolCallId: "call-1",
      toolName: "WebFetch",
      input: { url: "https://docs.example.com/guide?x=1", prompt: "What changed?" },
      title: "Fetch a page from docs.example.com",
      reason: "No rule allows fetching from docs.example.com.",
      suggestions: ["WebFetch(domain:docs.example.com)"],
    };
    renderInTheme(
      <PermissionCard
        item={permissionItem({ request })}
        env={makeEnv()}
        shownAgain={false}
        autoFocus={false}
      />,
      theme,
    );
    expect(screen.getByText("Fetch a page from docs.example.com")).toBeInTheDocument();
    expect(screen.getByText("https://docs.example.com/guide?x=1")).toBeInTheDocument();
    expect(screen.getByText(/WebFetch\(domain:docs\.example\.com\)/)).toBeInTheDocument();
  });
});

describe("web card meta", () => {
  it("summarises each display in a few words", () => {
    expect(toolMeta(fetchItem(PAGE))).toEqual([{ kind: "text", text: "14 KB", tone: "neutral" }]);
    expect(toolMeta(fetchItem({ ...PAGE, cached: true }))).toEqual([
      { kind: "text", text: "14 KB, cached", tone: "neutral" },
    ]);
    expect(toolMeta(searchItem({ ...RESULTS, results: [RESULTS.results[0] as never] }))).toEqual([
      { kind: "text", text: "1 result", tone: "neutral" },
    ]);
  });
});
