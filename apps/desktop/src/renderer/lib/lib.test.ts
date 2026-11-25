import { describe, expect, it } from "vitest";
import {
  basename,
  displayPath,
  formatBytes,
  formatDuration,
  formatMemory,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
  formatTimeLeft,
  formatTokens,
  shortenPath,
  truncate,
} from "./format.ts";
import { MODE_CYCLE, nextMode } from "./modes.ts";
import { permissionNeed, toolActivity, toolTarget, toolVerb } from "./tools.ts";

describe("format", () => {
  it("formats numbers and tokens", () => {
    expect(formatNumber(18240)).toBe("18,240");
    expect(formatTokens(840)).toBe("840");
    expect(formatTokens(74_200)).toBe("74.2K");
    expect(formatTokens(204_800)).toBe("204.8K");
    expect(formatTokens(133_000)).toBe("133K");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatPercent(0.364)).toBe("36%");
  });

  it("formats durations the way the transcript shows them", () => {
    expect(formatDuration(900)).toBe("0.9 s");
    expect(formatDuration(5000)).toBe("5 s");
    expect(formatDuration(48_200)).toBe("48 s");
    expect(formatDuration(72_000)).toBe("1 min 12 s");
    expect(formatDuration(120_000)).toBe("2 min");
    expect(formatDuration(3_900_000)).toBe("1 h 5 min");
  });

  it("formats sizes, memory, speeds and time left", () => {
    expect(formatBytes(512_000)).toBe("512 KB");
    expect(formatBytes(950_000_000)).toBe("950 MB");
    expect(formatBytes(30_000_000_000)).toBe("30.0 GB");
    expect(formatBytes(180_400_000_000)).toBe("180 GB");
    expect(formatBytes(1_210_000_000_000)).toBe("1.21 TB");
    expect(formatMemory(64 * 2 ** 30)).toBe("64 GB");
    expect(formatMemory(43.5 * 2 ** 30)).toBe("43.5 GB");
    expect(formatMemory(512 * 2 ** 20)).toBe("512 MB");
    expect(formatSpeed(86_000_000)).toBe("86 MB/s");
    expect(formatTimeLeft(150)).toBe("about 2 min 30 s left");
    expect(formatTimeLeft(0.2)).toBe("about 1 s left");
  });

  it("formats relative times for the sidebar", () => {
    const now = new Date(2026, 10, 22, 15, 0, 0).getTime();
    expect(formatRelativeTime(now - 20_000, now)).toBe("now");
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3m");
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2h");
    expect(formatRelativeTime(new Date(2026, 10, 21, 18, 0).getTime(), now)).toBe("Yesterday");
    expect(formatRelativeTime(new Date(2026, 10, 17, 9, 0).getTime(), now)).toBe("Tue");
    expect(formatRelativeTime(new Date(2026, 10, 3, 9, 0).getTime(), now)).toBe("Nov 3");
    expect(formatRelativeTime(new Date(2025, 10, 3, 9, 0).getTime(), now)).toBe("Nov 3, 2025");
  });

  it("shortens paths", () => {
    expect(shortenPath("/Users/me/code/tally", "/Users/me")).toBe("~/code/tally");
    expect(shortenPath("/Users/me", "/Users/me/")).toBe("~");
    expect(shortenPath("/opt/x", "/Users/me")).toBe("/opt/x");
    expect(displayPath("/Users/me/code/tally/src/a.py", "/Users/me/code/tally", "/Users/me")).toBe(
      "src/a.py",
    );
    expect(displayPath("/Users/me/other/a.py", "/Users/me/code/tally", "/Users/me")).toBe(
      "~/other/a.py",
    );
    expect(basename("/a/b/money.py")).toBe("money.py");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("modes", () => {
  it("cycles default → acceptEdits → plan → default", () => {
    expect(MODE_CYCLE).toEqual(["default", "acceptEdits", "plan"]);
    expect(nextMode("default")).toBe("acceptEdits");
    expect(nextMode("plan")).toBe("default");
    expect(nextMode("bypassPermissions")).toBe("default");
  });
});

describe("tools", () => {
  const cwd = "/Users/me/code/tally";
  it("names targets and verbs", () => {
    expect(toolTarget("Bash", { command: "uv run pytest -q" }, cwd, "/Users/me")).toBe(
      "uv run pytest -q",
    );
    expect(toolTarget("Edit", { file_path: `${cwd}/src/tally/money.py` }, cwd, "/Users/me")).toBe(
      "src/tally/money.py",
    );
    expect(toolTarget("Grep", { pattern: "currency" }, cwd, "/Users/me")).toBe("currency");
    expect(toolVerb("Bash", "running")).toBe("Running");
    expect(toolVerb("Bash", "error")).toBe("Ran");
    expect(toolVerb("Edit", "success")).toBe("Edited");
    expect(toolVerb("Edit", "interrupted")).toBe("Stopped");
  });

  it("describes activity and needs", () => {
    expect(toolActivity("Edit", { file_path: `${cwd}/src/tally/money.py` })).toBe(
      "editing money.py",
    );
    expect(permissionNeed({ toolName: "Bash" })).toBe("run a command");
    expect(permissionNeed({ toolName: "Edit" })).toBe("edit a file");
    expect(permissionNeed({ toolName: "mcp__github__create_issue" })).toBe("use a tool");
  });
});
