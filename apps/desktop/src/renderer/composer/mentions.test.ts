import { describe, expect, it } from "vitest";
import { activeMention, applyMention, mentionText, resolveMentions } from "./mentions.ts";

/** The active mention with the caret at "|". */
function active(withCaret: string) {
  const caret = withCaret.indexOf("|");
  const text = withCaret.replace("|", "");
  return { text, active: activeMention(text, caret) };
}

describe("activeMention", () => {
  it("finds the token being typed and its query", () => {
    expect(active("look at @src/mo|").active).toEqual({
      start: 8,
      end: 15,
      query: "src/mo",
      suffix: "",
      quoted: false,
    });
    expect(active("@|").active).toMatchObject({ start: 0, end: 1, query: "" });
    expect(active("(@a|)").active).toMatchObject({ start: 1, query: "a" });
  });

  it("covers the rest of the word when the caret is inside it", () => {
    expect(active("@sr|c/money.py and more").active).toMatchObject({
      start: 0,
      end: 13,
      query: "sr",
    });
  });

  it("ignores e-mail addresses, finished tokens and line ranges being typed", () => {
    expect(active("me@exa|").active).toBeNull();
    expect(active("@src/a.ts |").active).toBeNull();
    expect(active("plain|").active).toBeNull();
    expect(active("@src/a.ts#L1|").active).toBeNull();
    expect(active("@src/a.ts#|").active).toBeNull();
  });

  it("keeps a line range after the caret as the suffix", () => {
    expect(active("@mo|ney.py#L4-9 next").active).toMatchObject({
      query: "mo",
      suffix: "#L4-9",
      end: 14,
    });
  });

  it("follows a quoted path with spaces until its quote closes", () => {
    expect(active('see @"My No|').active).toMatchObject({
      start: 4,
      query: "My No",
      quoted: true,
    });
    expect(active('@"My Notes/pl|an.md" rest').active).toMatchObject({
      start: 0,
      end: 19,
      query: "My Notes/pl",
    });
    expect(active('@"My Notes/plan.md" more|').active).toBeNull();
  });
});

describe("applyMention", () => {
  it("writes the path and a space, and puts the caret after it", () => {
    const { text, active: token } = active("fix @mo| please");
    if (!token) throw new Error("expected a mention");
    expect(applyMention(text, token, "src/tally/money.py")).toEqual({
      text: "fix @src/tally/money.py please",
      caret: 24,
    });
    const end = active("fix @mo|");
    if (!end.active) throw new Error("expected a mention");
    expect(applyMention(end.text, end.active, "src/tally/money.py")).toEqual({
      text: "fix @src/tally/money.py ",
      caret: 24,
    });
  });

  it("keeps a typed line range on a file, but not on a folder", () => {
    const { text, active: token } = active("@mo|#L4-9");
    if (!token) throw new Error("expected a mention");
    expect(applyMention(text, token, "money.py").text).toBe("@money.py#L4-9 ");
    expect(applyMention(text, token, "src/").text).toBe("@src/ ");
  });

  it("quotes a path with a space", () => {
    expect(mentionText("My Notes/plan.md")).toBe('@"My Notes/plan.md"');
    const { text, active: token } = active("@pl|");
    if (!token) throw new Error("expected a mention");
    expect(applyMention(text, token, "My Notes/plan.md").text).toBe('@"My Notes/plan.md" ');
  });

  it("leaves a folder open to browse inside it", () => {
    const { text, active: token } = active("@sr|");
    if (!token) throw new Error("expected a mention");
    const browsed = applyMention(text, token, "src/", { browse: true });
    expect(browsed).toEqual({ text: "@src/", caret: 5 });
    expect(activeMention(browsed.text, browsed.caret)).toMatchObject({ query: "src/" });
  });
});

describe("resolveMentions", () => {
  const known = (paths: string[]) => (path: string) => paths.includes(path);

  it("turns known paths into mentions, in order and once each", () => {
    const text = "compare @src/a.ts with @lib/ and @src/a.ts again, and @nope";
    expect(resolveMentions(text, known(["src/a.ts", "lib/"]))).toEqual([
      { path: "src/a.ts" },
      { path: "lib/" },
    ]);
  });

  it("reads line ranges, one line or several, either way round", () => {
    const paths = known(["a.ts", "src/"]);
    expect(resolveMentions("@a.ts#L10 @a.ts#L3-7 @a.ts#L9-2 @src/#L4", paths)).toEqual([
      { path: "a.ts", startLine: 10, endLine: 10 },
      { path: "a.ts", startLine: 3, endLine: 7 },
      { path: "a.ts", startLine: 2, endLine: 9 },
      { path: "src/" },
    ]);
  });

  it("drops a sentence's punctuation, and finds a folder written without its slash", () => {
    expect(resolveMentions("see @a.ts, then (@src).", known(["a.ts", "src/"]))).toEqual([
      { path: "a.ts" },
      { path: "src/" },
    ]);
    expect(resolveMentions("@v1.", known(["v1."]))).toEqual([{ path: "v1." }]);
  });

  it("reads quoted paths with spaces", () => {
    expect(
      resolveMentions('read @"My Notes/plan.md"#L2-4 now', known(["My Notes/plan.md"])),
    ).toEqual([{ path: "My Notes/plan.md", startLine: 2, endLine: 4 }]);
  });

  it("leaves e-mail addresses and unknown words alone", () => {
    expect(resolveMentions("mail me@a.ts or @someone", known(["a.ts"]))).toEqual([]);
  });
});
