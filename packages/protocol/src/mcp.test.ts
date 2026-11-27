import { describe, expect, it } from "vitest";
import { ToolDisplaySchema } from "./common.ts";
import { McpServerInfoSchema } from "./mcp.ts";

describe("MCP schemas", () => {
  it("carries an MCP call's display among the tool displays", () => {
    const display = ToolDisplaySchema.parse({
      kind: "mcp",
      server: "test",
      tool: "echo",
      text: "hello",
      images: 0,
      isError: false,
      chars: 5,
      savedTo: null,
    });
    expect(display.kind).toBe("mcp");
    expect(() => ToolDisplaySchema.parse({ kind: "mcp", server: "test" })).toThrow();
  });

  it("fills a server's notes when an older engine leaves them out", () => {
    const server = McpServerInfoSchema.parse({
      name: "github",
      scope: "user",
      source: { path: "/Users/me/.dawg/mcp.json", origin: "dawg", scope: "user" },
      transport: "http",
      target: "https://api.example.com/mcp",
      state: "needs-sign-in",
      reason: "The server wants you to sign in.",
      tools: [],
      prompts: 0,
      resources: 0,
      enabled: true,
    });
    expect(server.notes).toEqual([]);
  });
});
