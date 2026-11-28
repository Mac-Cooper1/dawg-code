import { describe, expect, it } from "vitest";
import { ToolDisplaySchema } from "./common.ts";
import { McpServerInfoSchema, McpSignInInfoSchema } from "./mcp.ts";
import { SessionCreateParamsSchema } from "./methods.ts";

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
    // Added in round 3, so an older engine leaves sign-in out too.
    expect(server.signIn).toBeNull();
  });

  it("takes a session's own servers in the .mcp.json shape, and keeps tokens out of sign-in", () => {
    const params = SessionCreateParamsSchema.parse({
      cwd: "/Users/me/tally",
      mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } },
      strictMcpConfig: true,
    });
    expect(params.mcpServers).toEqual({
      docs: { type: "http", url: "https://docs.example.com/mcp" },
    });
    expect(() => SessionCreateParamsSchema.parse({ cwd: "/x", mcpServers: [] })).toThrow();
    expect(() =>
      SessionCreateParamsSchema.parse({ cwd: "/x", mcpServers: { "": { command: "x" } } }),
    ).toThrow();
    // The sign-in shape has no room for a token: a status and a sentence.
    expect(Object.keys(McpSignInInfoSchema.shape).sort()).toEqual(["problem", "status"]);
  });
});
