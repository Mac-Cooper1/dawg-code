/** How the MCP resource tools and a server's request for input are named in the window. */
import { describe, expect, it } from "vitest";
import { announcementFor } from "../transcript/Transcript.tsx";
import { toolIcon } from "../transcript/toolInfo.ts";
import { toolActivity, toolTarget, toolVerb } from "./tools.ts";

describe("the MCP resource tools", () => {
  it("are named on their cards and in the sidebar", () => {
    expect(toolVerb("ListMcpResourcesTool", "running")).toBe("Listing MCP resources");
    expect(toolVerb("ListMcpResourcesTool", "success")).toBe("Listed MCP resources");
    expect(toolVerb("ReadMcpResourceTool", "success")).toBe("Read an MCP resource");
    expect(toolTarget("ListMcpResourcesTool", {}, "/p", "/h")).toBe("every server");
    expect(toolTarget("ListMcpResourcesTool", { server: "notes" }, "/p", "/h")).toBe("notes");
    expect(
      toolTarget("ReadMcpResourceTool", { server: "notes", uri: "notes://readme" }, "/p", "/h"),
    ).toBe("notes · notes://readme");
    expect(toolActivity("ReadMcpResourceTool", { server: "notes" })).toBe(
      "reading a resource of notes",
    );
    expect(toolIcon("ListMcpResourcesTool")).toBe("server");
  });
});

describe("a server's request for input, read out", () => {
  const base = {
    id: "elicitation:e1",
    turnId: "t1",
    seq: 1,
    kind: "elicitation" as const,
    requestId: "e1",
    toolCallId: null,
    server: "tracker",
    message: "Hi",
    fields: [],
    response: null,
  };
  it("says who asks while it waits, and nothing once answered", () => {
    expect(announcementFor({ ...base, mode: "form", url: null, state: "pending" })).toBe(
      "tracker asks for input.",
    );
    expect(
      announcementFor({ ...base, mode: "url", url: "https://x.example", state: "pending" }),
    ).toBe("tracker asks you to open a page.");
    expect(announcementFor({ ...base, mode: "form", url: null, state: "answered" })).toBeNull();
  });
});
