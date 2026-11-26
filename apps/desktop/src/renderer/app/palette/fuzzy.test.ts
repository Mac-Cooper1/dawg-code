import { describe, expect, it } from "vitest";
import { matchScore, prepare, queryWords } from "./fuzzy.ts";

function score(query: string, title: string, extra = ""): number | null {
  return matchScore(queryWords(query), prepare({ title, extra }));
}

describe("fuzzy matching", () => {
  it("matches everything with an empty query", () => {
    expect(queryWords("   ")).toEqual([]);
    expect(score("", "Fork the session")).toBe(0);
  });

  it("finds a word, or its letters in order from a word start, in the title", () => {
    expect(score("fork", "Fork the session")).not.toBeNull();
    expect(score("frk", "Fork the session")).not.toBeNull();
    expect(score("nsw", "New session in a worktree…")).not.toBeNull();
    expect(score("krof", "Fork the session")).toBeNull();
    // Not from the middle of a word, and not for two letters, which match nearly anything.
    expect(score("rks", "Fork the session")).toBeNull();
    expect(score("fo", "Fix broken links")).toBeNull();
  });

  it("ranks a substring above letters found apart", () => {
    const together = score("sess", "Fork the session") ?? 0;
    const apart = score("sess", "Show the Settings pane") ?? 0;
    expect(together).toBeGreaterThan(apart);
  });

  it("ranks a whole word above the start of one, and that above its middle", () => {
    const whole = score("mode", "Permission mode: Plan") ?? 0;
    const start = score("mode", "Model: Qwen3.8 27B") ?? 0;
    const middle = score("mode", "Remodel the kitchen") ?? 0;
    expect(whole).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(middle);
  });

  it("needs every word, each in the title or the other words", () => {
    expect(score("tally csv", "Flaky CSV import test", "tally · ~/code/tally")).not.toBeNull();
    expect(score("tally pdf", "Flaky CSV import test", "tally · ~/code/tally")).toBeNull();
    // The other words match as substrings only, not as scattered letters.
    expect(score("tly", "Flaky CSV import test".replace("Flaky", "Odd"), "tally")).toBeNull();
  });

  it("prefers the title to the other words, and the phrase to words apart", () => {
    const inTitle = score("theme", "Switch the theme") ?? 0;
    const inKeywords = score("theme", "Appearance: Dark", "theme · night") ?? 0;
    expect(inTitle).toBeGreaterThan(inKeywords);
    const phrase = score("new session", "New session…") ?? 0;
    const apart = score("new session", "Session list, new") ?? 0;
    expect(phrase).toBeGreaterThan(apart);
  });

  it("ignores case and curly apostrophes", () => {
    expect(score("DON'T", "Permission mode: Don’t ask")).not.toBeNull();
  });
});
