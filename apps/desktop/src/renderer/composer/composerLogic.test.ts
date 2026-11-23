import type { CommandInfo } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import type { ContextMeterView } from "../state/types.ts";
import { commandQuery, filterCommands, takesArguments } from "./commands.ts";
import {
  compactLine,
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
  compactAt: 0.65,
  compacting: false,
};

describe("the context meter's text", () => {
  it("labels and heads the meter", () => {
    expect(contextLabel(CONTEXT)).toBe("74.2K / 204.8K");
    expect(contextHeading(CONTEXT)).toBe("Context · 36% of 204.8K tokens");
    expect(compactLine(CONTEXT)).toBe("Compacts on its own at 65% (133K).");
  });

  it("splits the used part by what the cache served", () => {
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
