import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { refractor } from "refractor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { Markdown } from "./index.ts";

function reduceMotion(reduced: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: reduced && query.includes("reduce"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(THEMES)("Markdown (%s)", (theme) => {
  it("renders GitHub-flavoured Markdown: tables, task lists, strikethrough", () => {
    const text = [
      "| Share | Amount |",
      "| --- | --- |",
      "| First | 33.34 |",
      "",
      "- [x] Add refund tests",
      "- [ ] Run the suite",
      "",
      "~~rounding each share~~ working in cents",
    ].join("\n");
    const { container } = renderInTheme(<Markdown text={text} onOpenLink={vi.fn()} />, theme);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Amount" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "33.34" })).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(container.querySelector("del")).toHaveTextContent("rounding each share");
  });

  it("never renders raw HTML: it shows as text", () => {
    const text = 'Hi <img src="x" onerror="alert(1)"> and <script>alert(2)</script> <b>bold</b>';
    const { container } = renderInTheme(<Markdown text={text} onOpenLink={vi.fn()} />, theme);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container).toHaveTextContent('<img src="x" onerror="alert(1)">');
    expect(container).toHaveTextContent("<b>bold</b>");
  });

  it("asks before opening a link, then opens the full URL", async () => {
    const user = userEvent.setup();
    const onOpenLink = vi.fn();
    renderInTheme(
      <Markdown
        text="Read [the docs](https://docs.example.com/guide?a=1)."
        onOpenLink={onOpenLink}
      />,
      theme,
    );
    expect(screen.queryByRole("link")).toBeNull();
    await user.click(screen.getByRole("button", { name: "the docs" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Open https://docs.example.com/guide?a=1 in your browser?");
    expect(onOpenLink).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Open" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://docs.example.com/guide?a=1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels a link without opening it", async () => {
    const user = userEvent.setup();
    const onOpenLink = vi.fn();
    renderInTheme(<Markdown text="[site](http://example.com)" onOpenLink={onOpenLink} />, theme);
    await user.click(screen.getByRole("button", { name: "site" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("renders links that are not http(s) as plain text", () => {
    const text = "[run](javascript:alert(1)) [mail](mailto:a@b.c) [file](src/money.py)";
    const { container } = renderInTheme(<Markdown text={text} onOpenLink={vi.fn()} />, theme);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("run mail file");
  });

  it("does not load remote images; they become a link", () => {
    const { container } = renderInTheme(
      <Markdown text="![chart](https://example.com/chart.png)" onOpenLink={vi.fn()} />,
      theme,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Image: chart" })).toBeInTheDocument();
  });

  it("highlights code blocks and labels their language", () => {
    const { container } = renderInTheme(
      <Markdown text={"```ts\nconst share = 1; // cents\n```"} onOpenLink={vi.fn()} />,
      theme,
    );
    expect(screen.getByText("ts")).toBeInTheDocument();
    const code = container.querySelector("pre code");
    expect(code).toHaveTextContent("const share = 1; // cents");
    const keyword = Array.from(code?.querySelectorAll("span") ?? []).find(
      (span) => span.textContent === "const",
    );
    expect(keyword?.className).toMatch(/keyword/);
    const comment = Array.from(code?.querySelectorAll("span") ?? []).find((span) =>
      span.textContent?.includes("// cents"),
    );
    expect(comment?.className).toMatch(/comment/);
  });

  it("shows unknown languages as plain text", () => {
    const { container } = renderInTheme(
      <Markdown text={"```cobol\nDISPLAY 'HI'.\n```"} onOpenLink={vi.fn()} />,
      theme,
    );
    expect(container.querySelector("pre code span")).toBeNull();
    expect(container.querySelector("pre code")).toHaveTextContent("DISPLAY 'HI'.");
  });

  it("copies a code block and says so", async () => {
    const user = userEvent.setup();
    renderInTheme(<Markdown text={"```sh\nuv run pytest -q\n```"} onOpenLink={vi.fn()} />, theme);
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await navigator.clipboard.readText()).toBe("uv run pytest -q");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("renders an unclosed fence as a code block while streaming", () => {
    const { container } = renderInTheme(
      <Markdown
        text={"Run it:\n\n```bash\nuv run pytest -q\nuv run ruff"}
        streaming
        onOpenLink={vi.fn()}
      />,
      theme,
    );
    expect(container.querySelector("pre code")).toHaveTextContent("uv run pytest -q uv run ruff");
    expect(container).not.toHaveTextContent("```");
  });

  it("shows a caret at the end while streaming, and none when finished", () => {
    reduceMotion(false);
    const { container, rerender } = renderInTheme(
      <Markdown text="Splitting the **absolute amount" streaming onOpenLink={vi.fn()} />,
      theme,
    );
    const caret = container.querySelector("[data-caret]");
    expect(caret).not.toBeNull();
    expect(caret).toHaveAttribute("aria-hidden", "true");
    // The caret sits inside the paragraph, right after the last word, and the bold is closed.
    expect(caret?.closest("p")).not.toBeNull();
    expect(caret?.previousSibling?.textContent).toBe("absolute amount");
    expect(container.querySelector("strong")).toHaveTextContent("absolute amount");
    rerender(<Markdown text="Splitting the **absolute amount**." onOpenLink={vi.fn()} />);
    expect(container.querySelector("[data-caret]")).toBeNull();
  });

  it("shows no caret when reduced motion is on", () => {
    reduceMotion(true);
    const { container } = renderInTheme(
      <Markdown text="Working on it" streaming onOpenLink={vi.fn()} />,
      theme,
    );
    expect(container.querySelector("[data-caret]")).toBeNull();
  });

  it("does not highlight unchanged code blocks again while the reply streams", () => {
    const highlight = vi.spyOn(refractor, "highlight");
    const block = `\`\`\`python\ndef split_${theme}(total):\n    return total\n\`\`\``;
    const onOpenLink = vi.fn();
    const { rerender } = renderInTheme(
      <Markdown text={`${block}\n\nThen`} streaming onOpenLink={onOpenLink} />,
      theme,
    );
    const calls = highlight.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    rerender(<Markdown text={`${block}\n\nThen I ran`} streaming onOpenLink={onOpenLink} />);
    rerender(
      <Markdown text={`${block}\n\nThen I ran the tests`} streaming onOpenLink={onOpenLink} />,
    );
    expect(highlight.mock.calls.length).toBe(calls);
  });
});
