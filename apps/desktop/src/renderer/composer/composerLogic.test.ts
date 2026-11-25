import type { CommandInfo } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import type { ContextMeterView } from "../state/types.ts";
import { commandQuery, filterCommands, takesArguments } from "./commands.ts";
import {
  compactLine,
  compactMarker,
  contextHeading,
  contextLabel,
  contextSegments,
  lastRequestLine,
} from "./contextMeter.ts";

const COMMANDS: CommandInfo[] = [
  { name: "help", description: "", argumentHint: null },
  { name: "compact", description: "", argumentHint: "[focus]" },
  { name: "context", description: "", argumentHint: null },
  { name: "recompact", description: "", argumentHint: null },
];

describe("commandQuery", () => {
  it("reads a bare command name at the start of the draft", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/Co")).toBe("co");
    expect(commandQuery("/compact ")).toBeNull();
    expect(commandQuery("hello /compact")).toBeNull();
    expect(commandQuery("")).toBeNull();
  });
});

describe("filterCommands", () => {
  it("puts names that start with the query first", () => {
    expect(filterCommands(COMMANDS, "comp").map((command) => command.name)).toEqual([
      "compact",
      "recompact",
    ]);
    expect(filterCommands(COMMANDS, "").map((command) => command.name)).toEqual([
      "compact",
      "context",
      "help",
      "recompact",
    ]);
    expect(filterCommands(COMMANDS, "zz")).toEqual([]);
  });

  it("knows which commands take arguments", () => {
    expect(takesArguments(COMMANDS[1] as CommandInfo)).toBe(true);
    expect(takesArguments(COMMANDS[0] as CommandInfo)).toBe(false);
  });
});

const CONTEXT: ContextMeterView = {
  used: 74_200,
  window: 204_800,
  fraction: 74_200 / 204_800,
  last: {
    promptTokens: 74_200,
    cachedTokens: 72_000,
    completionTokens: 320,
    promptTokensPerSecond: 1240,
    completionTokensPerSecond: 41,
  },
  compactAt: 133_120,
  breakdown: null,
  compacting: false,
};

describe("the context meter's text", () => {
  it("labels and heads the meter", () => {
    expect(contextLabel(CONTEXT)).toBe("74.2K / 204.8K");
    expect(contextHeading(CONTEXT)).toBe("Context · 36% of 204.8K tokens");
    expect(compactLine(CONTEXT)).toBe("Compacts on its own at 65% (133.1K).");
  });

  it("splits the used part by what the engine says fills it", () => {
    const context: ContextMeterView = {
      ...CONTEXT,
      breakdown: { systemPrompt: 4_112, instructions: 1_186, tools: 10_992, messages: 57_910 },
    };
    const segments = contextSegments(context);
    expect(segments.map(({ key, label, tokens }) => [key, label, tokens])).toEqual([
      ["systemPrompt", "System prompt", 4_112],
      ["instructions", "Instructions", 1_186],
      ["tools", "Tools", 10_992],
      ["messages", "Messages", 57_910],
      ["free", "Free", 130_600],
    ]);
    expect(segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1);
    // Never more than the window, whatever the parts say.
    const over = contextSegments({
      ...context,
      used: 204_800,
      breakdown: { systemPrompt: 4_112, instructions: 1_186, tools: 10_992, messages: 300_000 },
    });
    expect(over.map(({ tokens }) => tokens)).toEqual([4_112, 1_186, 10_992, 188_510, 0]);
  });

  it("marks where compaction starts, and says when the context is past it", () => {
    expect(compactMarker(CONTEXT)).toBeCloseTo(0.65);
    const past = { ...CONTEXT, used: 140_000, fraction: 140_000 / 204_800 };
    expect(compactLine(past)).toBe("Compacts on its own before the next turn: past 65% (133.1K).");
  });

  it("says nothing about compaction when the engine did not report a threshold", () => {
    const old = { ...CONTEXT, compactAt: null };
    expect(compactLine(old)).toBeNull();
    expect(compactMarker(old)).toBeNull();
  });

  it("splits the used part by what the cache served, for sessions stored before the split", () => {
    expect(contextSegments(CONTEXT).map(({ key, tokens }) => [key, tokens])).toEqual([
      ["cached", 72_000],
      ["rest", 2_200],
      ["free", 130_600],
    ]);
    const shares = contextSegments(CONTEXT).reduce((sum, segment) => sum + segment.share, 0);
    expect(shares).toBeCloseTo(1);
  });

  it("shows the used part whole when the cache figure is unknown", () => {
    expect(contextSegments({ ...CONTEXT, last: null }).map(({ key }) => key)).toEqual([
      "used",
      "free",
    ]);
  });

  it("describes the last request with what the engine reported", () => {
    expect(lastRequestLine(CONTEXT)).toBe(
      "Last request: read 1,240 tokens/s, wrote 41 tokens/s, 97% of the prompt from cache.",
    );
    expect(
      lastRequestLine({
        ...CONTEXT,
        last: {
          promptTokens: null,
          cachedTokens: null,
          completionTokens: null,
          promptTokensPerSecond: null,
          completionTokensPerSecond: 12.4,
        },
      }),
    ).toBe("Last request: wrote 12 tokens/s.");
    expect(lastRequestLine({ ...CONTEXT, last: null })).toBeNull();
  });
});
