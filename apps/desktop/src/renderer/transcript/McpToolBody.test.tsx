import type { McpDisplay } from "@dawg/protocol";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { permissionNeed, toolActivity } from "../lib/tools.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { makeEnv, toolItem } from "./testing.ts";
import { toolIcon, toolMeta } from "./toolInfo.ts";

const ECHO: McpDisplay = {
  kind: "mcp",
  server: "github",
  tool: "get_issue",
  text: "#12: The split rounds the wrong way",
  images: 0,
  isError: false,
  chars: 35,
  savedTo: null,
};

describe.each(THEMES)("MCP tool cards (%s)", (theme) => {
  it("names the server and tool, and shows the arguments and the result", () => {
    const item = toolItem({
      toolName: "mcp__github__get_issue",
      input: { number: 12 },
      content: [{ type: "text", text: ECHO.text }],
      display: ECHO,
    });
    renderInTheme(<ToolCard item={item} open env={makeEnv()} />, theme);
    expect(screen.getByRole("button", { name: "Called github · get_issue" })).toBeInTheDocument();
    const said = (_: string, node: Element | null) =>
      node?.tagName === "SPAN" &&
      node.textContent === "The get_issue tool of the github MCP server";
    expect(screen.getByText(said)).toBeInTheDocument();
    expect(screen.getByText(/"number": 12/)).toBeInTheDocument();
    expect(screen.getByText(ECHO.text)).toBeInTheDocument();
  });

  it("unwraps a call made through CallMcpTool, and says where a long result went", () => {
    const item = toolItem({
      toolName: "CallMcpTool",
      input: { name: "mcp__docs__search", arguments: { query: "install" } },
      content: [{ type: "text", text: "Lots" }],
      display: {
        ...ECHO,
        server: "docs",
        tool: "search",
        text: "x".repeat(200),
        chars: 60_000,
        savedTo: "/Users/me/.dawg/projects/tally/s1/tool-results/mcp-docs-search.txt",
      },
    });
    renderInTheme(<ToolCard item={item} open env={makeEnv()} />, theme);
    expect(
      screen.getByRole("button", { name: "Called docs · search, saved to a file" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/"query": "install"/)).toBeInTheDocument();
    expect(screen.getByText(/The whole result \(60,000 characters\) is in/)).toBeInTheDocument();
  });

  it("shows a call still running, and one the server failed", () => {
    const running = toolItem({
      toolName: "mcp__github__get_issue",
      input: { number: 3 },
      state: "running",
      content: null,
      display: null,
    });
    const { unmount } = renderInTheme(<ToolCard item={running} open env={makeEnv()} />, theme);
    expect(screen.getByRole("button", { name: /^Calling github · get_issue/ })).toBeInTheDocument();
    expect(screen.getByText("Waiting for the server…")).toBeInTheDocument();
    unmount();
    const failed = toolItem({
      toolName: "mcp__github__get_issue",
      input: {},
      state: "error",
      content: [{ type: "text", text: "Error: the MCP server github said: no such issue" }],
      display: null,
    });
    renderInTheme(<ToolCard item={failed} open env={makeEnv()} />, theme);
    expect(screen.getByText(/no such issue/)).toBeInTheDocument();
    expect(toolMeta(failed)).toEqual([{ kind: "text", text: "failed", tone: "bad" }]);
  });
});

describe("MCP tool names", () => {
  it("reads as the server's tool in the sidebar, cards and permission asks", () => {
    expect(toolIcon("mcp__github__get_issue")).toBe("server");
    expect(toolIcon("CallMcpTool")).toBe("server");
    expect(toolIcon("ToolSearch")).toBe("search");
    expect(toolActivity("mcp__github__get_issue", {})).toBe("using github’s get_issue");
    expect(toolActivity("CallMcpTool", { name: "mcp__docs__search" })).toBe("using docs’s search");
    expect(permissionNeed({ toolName: "mcp__github__create_issue" })).toBe(
      "use github’s create_issue",
    );
  });
});
