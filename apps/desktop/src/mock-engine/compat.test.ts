import { type CompatItem, CompatReportSchema } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { projectSetupSummary } from "../renderer/state/project-setup.ts";
import { sortReportItems } from "./compat.ts";
import { HOME, harness } from "./test-support.ts";

describe("project.inspect in the mock engine", () => {
  it("answers with a full report for tally, valid and in the real report's order", async () => {
    const peer = await harness().connect();
    const report = CompatReportSchema.parse(
      await peer.request("project.inspect", { projectDir: `${HOME}/code/tally` }),
    );
    expect(new Set(report.items.map((item) => item.kind))).toEqual(
      new Set(["instructions", "settings", "agent", "hook", "mcp-server", "other"]),
    );
    expect(sortReportItems(report.items)).toEqual(report.items);
    expect(new Set(report.items.map((item) => item.status))).toEqual(
      new Set(["loaded", "partly-supported", "not-supported", "invalid"]),
    );
    expect(projectSetupSummary(report)).toBe(
      "2 subagents, 1 MCP server, 1 settings file, 1 other item",
    );
    peer.close();
  });

  it("adds the hooks trust.ts reads, and has nothing to tell for AGENTS.md alone", async () => {
    const peer = await harness().connect();
    const notes = await peer.request("project.inspect", { projectDir: `${HOME}/code/notes-cli` });
    expect(notes.items.some((item) => item.kind === "hook")).toBe(true);
    expect(notes.items.some((item) => item.kind === "instructions")).toBe(true);
    const site = await peer.request("project.inspect", { projectDir: `${HOME}/code/dawg-site` });
    expect(projectSetupSummary(site)).toBeNull();
    const home = await peer.request("project.inspect", { projectDir: null });
    expect(home.items.every((item: CompatItem) => item.source.scope === "user")).toBe(true);
    peer.close();
  });
});
