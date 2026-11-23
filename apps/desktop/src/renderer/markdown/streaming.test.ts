import { describe, expect, it } from "vitest";
import { closeOpenFence, prepareStreamingMarkdown } from "./streaming.ts";

describe("closeOpenFence", () => {
  it("closes an open backtick fence with the same length", () => {
    expect(closeOpenFence("Run this:\n\n````ts\nconst a = 1;")).toBe(
      "Run this:\n\n````ts\nconst a = 1;\n````",
    );
  });

  it("closes a tilde fence, and leaves closed fences alone", () => {
    expect(closeOpenFence("~~~\ncode\n")).toBe("~~~\ncode\n~~~");
    const closed = "```py\nprint(1)\n```\n\nDone.";
    expect(closeOpenFence(closed)).toBe(closed);
  });

  it("does not take a shorter run as the closing fence", () => {
    expect(closeOpenFence("````\n```\ninner")).toBe("````\n```\ninner\n````");
  });
});

describe("prepareStreamingMarkdown", () => {
  it("closes a code block that is still streaming", () => {
    expect(prepareStreamingMarkdown("Here:\n\n```python\ndef split(")).toBe(
      "Here:\n\n```python\ndef split(\n```",
    );
  });

  it("keeps everything inside an open fence as code, markup included", () => {
    const text = "```md\n**not bold\n- item\n#";
    expect(prepareStreamingMarkdown(text)).toBe(`${text}\n\`\`\``);
  });

  it("opens a code block as soon as its fence line arrives", () => {
    expect(prepareStreamingMarkdown("Look:\n```")).toBe("Look:\n```\n```");
  });

  it("closes emphasis, strikethrough and code spans left open at the end", () => {
    expect(prepareStreamingMarkdown("This is **bol")).toBe("This is **bol**");
    expect(prepareStreamingMarkdown("This is *ital")).toBe("This is *ital*");
    expect(prepareStreamingMarkdown("Call `split_ev")).toBe("Call `split_ev`");
    expect(prepareStreamingMarkdown("Old ~~way")).toBe("Old ~~way~~");
    expect(prepareStreamingMarkdown("**Use `cents")).toBe("**Use `cents`**");
    expect(prepareStreamingMarkdown("an _aside")).toBe("an _aside_");
  });

  it("leaves balanced markup, snake_case, list bullets and arithmetic alone", () => {
    expect(prepareStreamingMarkdown("**done** and `code`")).toBe("**done** and `code`");
    expect(prepareStreamingMarkdown("use split_evenly_keeps")).toBe("use split_evenly_keeps");
    expect(prepareStreamingMarkdown("* first\n* second")).toBe("* first\n* second");
    expect(prepareStreamingMarkdown("2 * 3 is six")).toBe("2 * 3 is six");
  });

  it("drops a marker with nothing after it yet", () => {
    expect(prepareStreamingMarkdown("Hello **")).toBe("Hello");
    expect(prepareStreamingMarkdown("Call `")).toBe("Call");
  });

  it("holds back a last line that is only block markup so far", () => {
    expect(prepareStreamingMarkdown("Title\n-")).toBe("Title");
    expect(prepareStreamingMarkdown("Steps:\n\n1.")).toBe("Steps:");
    expect(prepareStreamingMarkdown("Intro\n\n##")).toBe("Intro");
    expect(prepareStreamingMarkdown("A\n``")).toBe("A");
  });

  it("settles a link that is still being typed", () => {
    expect(prepareStreamingMarkdown("See [the docs](https://exa")).toBe(
      "See [the docs](https://exa)",
    );
    expect(prepareStreamingMarkdown("See [the do")).toBe("See the do");
  });

  it("only looks at the last paragraph", () => {
    expect(prepareStreamingMarkdown("an *open one\n\nThen **more")).toBe(
      "an *open one\n\nThen **more**",
    );
  });
});
