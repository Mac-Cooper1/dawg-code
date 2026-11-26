import type { FileMention } from "@dawg/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FindFilesResult, ResolvedTheme } from "../../shared/bridge.ts";
import { fuzzySearch, prepareTarget } from "../../shared/fuzzy.ts";
import { sampleComposer, TEST_MODELS } from "../app/testing.tsx";
import type { ComposerView, ImageAttachment } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import styles from "./Composer.module.css";
import { Composer } from "./Composer.tsx";

const CWD = "/Users/me/code/tally";
const FILES = [
  "README.md",
  "src/",
  "src/tally/",
  "src/tally/money.py",
  "src/tally/report.py",
  "tests/",
  "tests/test_money.py",
  "My Notes/",
  "My Notes/plan.md",
];
const TARGETS = FILES.map(prepareTarget);

/** A search over FILES that ranks as main does; an empty query lists the top level. */
async function findOver(query: string): Promise<FindFilesResult> {
  const matches =
    query === ""
      ? TARGETS.filter((target) => target.depth === 0).map((target) => ({ target, positions: [] }))
      : fuzzySearch(query, TARGETS, 50);
  return {
    matches: matches.map(({ target, positions }) => ({
      path: `${CWD}/${target.text.replace(/\/$/, "")}`,
      relativePath: target.text,
      kind: target.directory ? "directory" : "file",
      highlights: positions,
    })),
    truncated: false,
  };
}

interface Spies {
  onSubmit: ReturnType<typeof vi.fn<(text: string, mentions?: FileMention[]) => void>>;
  onFindFiles: ReturnType<typeof vi.fn<(query: string) => Promise<FindFilesResult>>>;
  onRememberMention: ReturnType<typeof vi.fn<(path: string) => void>>;
  onInterrupt: ReturnType<typeof vi.fn<() => void>>;
}

/** Holds the draft and the remembered paths, as the store does. */
function Harness(props: { view: ComposerView; spies: Spies }) {
  const [draft, setDraft] = useState(props.view.draft);
  const [paths, setPaths] = useState<string[]>([]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  return (
    <Composer
      view={{ ...props.view, draft }}
      models={TEST_MODELS}
      canSend
      attachments={images}
      mentionPaths={paths}
      onDraftChange={setDraft}
      onSubmit={(text, mentions) => {
        props.spies.onSubmit(text, mentions);
        setDraft("");
        setPaths([]);
      }}
      onFindFiles={props.spies.onFindFiles}
      onAddAttachments={(added) => setImages((current) => [...current, ...added])}
      onRemoveAttachment={(id) => setImages((current) => current.filter((i) => i.id !== id))}
      onRememberMention={(path) => {
        props.spies.onRememberMention(path);
        setPaths((current) => [...current, path]);
      }}
      onInterrupt={props.spies.onInterrupt}
      onSetMode={vi.fn()}
      onCycleMode={vi.fn()}
      onSetModel={vi.fn()}
      onSetEffort={vi.fn()}
      onCompact={vi.fn()}
      onSendQueuedNow={vi.fn()}
      onRemoveQueued={vi.fn()}
      onManageModels={vi.fn()}
    />
  );
}

function setup(
  theme: ResolvedTheme,
  options: {
    view?: Partial<ComposerView>;
    find?: (query: string) => Promise<FindFilesResult>;
  } = {},
) {
  const spies: Spies = {
    onSubmit: vi.fn(),
    onFindFiles: vi.fn(options.find ?? findOver),
    onRememberMention: vi.fn(),
    onInterrupt: vi.fn(),
  };
  renderInTheme(<Harness view={sampleComposer(options.view)} spies={spies} />, theme);
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const textbox = screen.getByRole("textbox", { name: "Message to dawg" });
  return { spies, user, textbox };
}

/** The options' accessible names, once the list shows them. */
async function options(): Promise<string[]> {
  const list = await screen.findByRole("listbox", { name: "Files" });
  return within(list)
    .queryAllByRole("option")
    .map((option) => option.getAttribute("aria-label") ?? "");
}

async function optionsFor(expected: string[]) {
  await waitFor(async () => expect(await options()).toEqual(expected));
}

describe.each(THEMES)("the @ menu (%s)", (theme) => {
  it("opens on @ with the starting list, and points the textbox at it", async () => {
    const { spies, user, textbox } = setup(theme);
    await user.type(textbox, "Look at @");
    await optionsFor(["README.md", "src/, folder", "tests/, folder", "My Notes/, folder"]);
    expect(spies.onFindFiles).toHaveBeenCalledWith("");
    const list = screen.getByRole("listbox", { name: "Files" });
    expect(textbox).toHaveAttribute("aria-haspopup", "listbox");
    expect(textbox).toHaveAttribute("aria-controls", list.id);
    const [first] = within(list).getAllByRole("option");
    expect(textbox).toHaveAttribute("aria-activedescendant", first?.id);
    expect(first).toHaveAttribute("aria-selected", "true");
  });

  it("searches as the path is typed and marks the matched characters", async () => {
    const { spies, user, textbox } = setup(theme);
    await user.type(textbox, "@money");
    await waitFor(() => expect(spies.onFindFiles).toHaveBeenLastCalledWith("money"));
    await optionsFor(["src/tally/money.py", "tests/test_money.py"]);
    const option = screen.getByRole("option", { name: "src/tally/money.py" });
    const hits = option.querySelectorAll(`.${styles.mentionHit}`);
    expect([...hits].map((hit) => hit.textContent).join("")).toBe("money");
    expect(option.querySelector(`.${styles.mentionFolder}`)?.textContent).toBe("src/tally/");
  });

  it("moves with the arrow keys and inserts with Enter, remembering the path", async () => {
    const { spies, user, textbox } = setup(theme);
    await user.type(textbox, "Check @money");
    await optionsFor(["src/tally/money.py", "tests/test_money.py"]);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "tests/test_money.py" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "src/tally/money.py" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowUp}{Enter}");
    expect(textbox).toHaveValue("Check @tests/test_money.py ");
    expect(spies.onRememberMention).toHaveBeenCalledWith("tests/test_money.py");
    expect(screen.queryByRole("listbox", { name: "Files" })).not.toBeInTheDocument();
    expect(spies.onSubmit).not.toHaveBeenCalled();
    // The caret is after the space: typing goes on from there.
    await user.keyboard("now");
    expect(textbox).toHaveValue("Check @tests/test_money.py now");
  });

  it("browses into a folder with Tab, and inserts a file with Tab", async () => {
    const { user, textbox } = setup(theme);
    await user.type(textbox, "@tal");
    await waitFor(async () => expect((await options())[0]).toBe("src/tally/, folder"));
    await user.keyboard("{Tab}");
    expect(textbox).toHaveValue("@src/tally/");
    await waitFor(async () =>
      expect(await options()).toEqual(
        expect.arrayContaining(["src/tally/money.py", "src/tally/report.py"]),
      ),
    );
    await user.type(textbox, "rep");
    await waitFor(async () => expect((await options())[0]).toBe("src/tally/report.py"));
    await user.keyboard("{Tab}");
    expect(textbox).toHaveValue("@src/tally/report.py ");
  });

  it("chooses with the mouse", async () => {
    const { user, textbox } = setup(theme);
    await user.type(textbox, "@read");
    await optionsFor(["README.md"]);
    await user.click(screen.getByRole("option", { name: "README.md" }));
    expect(textbox).toHaveValue("@README.md ");
    expect(textbox).toHaveFocus();
  });

  it("quotes a path with a space", async () => {
    const { user, textbox } = setup(theme);
    await user.type(textbox, "@plan");
    await optionsFor(["My Notes/plan.md"]);
    await user.keyboard("{Enter}");
    expect(textbox).toHaveValue('@"My Notes/plan.md" ');
  });

  it("closes on Esc without interrupting, until the next @", async () => {
    const { spies, user, textbox } = setup(theme, { view: { working: true } });
    await user.type(textbox, "@mon");
    await screen.findByRole("listbox", { name: "Files" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Files" })).not.toBeInTheDocument();
    expect(spies.onInterrupt).not.toHaveBeenCalled();
    expect(textbox).toHaveValue("@mon");
    expect(textbox).not.toHaveAttribute("aria-controls");
    await user.type(textbox, "ey");
    expect(screen.queryByRole("listbox", { name: "Files" })).not.toBeInTheDocument();
    await user.type(textbox, " and @");
    expect(await screen.findByRole("listbox", { name: "Files" })).toBeInTheDocument();
  });

  it("leaves e-mail addresses alone and never opens with the command menu", async () => {
    const { user, textbox } = setup(theme);
    await user.type(textbox, "mail me@exa");
    expect(screen.queryByRole("listbox", { name: "Files" })).not.toBeInTheDocument();
    await user.clear(textbox);
    await user.type(textbox, "/comp");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Files" })).not.toBeInTheDocument();
    await user.type(textbox, "act @mon");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
    expect(await screen.findByRole("listbox", { name: "Files" })).toBeInTheDocument();
  });

  it("says when nothing matches, and why a search failed", async () => {
    const { user, textbox } = setup(theme, {
      find: async (query) => {
        if (query === "zz") return { matches: [], truncated: false };
        throw new Error("Error invoking remote method 'x': Error: The session's folder is gone");
      },
    });
    await user.type(textbox, "@zz");
    expect(await screen.findByText("No matching files")).toBeInTheDocument();
    // With nothing to choose, Enter sends.
    await user.type(textbox, " @q");
    expect(
      await screen.findByText("Files can't be searched here. The session's folder is gone."),
    ).toBeInTheDocument();
  });
});

describe.each(THEMES)("sending mentions (%s)", (theme) => {
  // Long typing: give a busy machine time.
  it("sends the inserted paths, with a line range, keeping the text as typed", {
    timeout: 20_000,
  }, async () => {
    const { spies, user, textbox } = setup(theme);
    await user.type(textbox, "Compare @money");
    await optionsFor(["src/tally/money.py", "tests/test_money.py"]);
    await user.keyboard("{Enter}{Backspace}#L10-20 with @rep");
    await waitFor(async () => expect((await options())[0]).toBe("src/tally/report.py"));
    await user.keyboard("{Enter}and @xyzzy");
    expect(await screen.findByText("No matching files")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(spies.onSubmit).toHaveBeenCalledWith(
      "Compare @src/tally/money.py#L10-20 with @src/tally/report.py and @xyzzy",
      [{ path: "src/tally/money.py", startLine: 10, endLine: 20 }, { path: "src/tally/report.py" }],
    );
  });

  it("counts a path the menu showed, typed out in full", async () => {
    const { spies, user, textbox } = setup(theme);
    await user.type(textbox, "@README");
    await optionsFor(["README.md"]);
    await user.type(textbox, ".md#L3");
    expect(screen.queryByRole("listbox", { name: "Files" })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(spies.onSubmit).toHaveBeenCalledWith("@README.md#L3", [
      { path: "README.md", startLine: 3, endLine: 3 },
    ]);
  });

  it("sends plain text without mentions", async () => {
    const { spies, user, textbox } = setup(theme);
    await user.type(textbox, "Hello @xyzzy");
    expect(await screen.findByText("No matching files")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(spies.onSubmit).toHaveBeenCalledWith("Hello @xyzzy", undefined);
  });
});
