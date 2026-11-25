import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { sampleComposer, TEST_MODELS } from "../app/testing.tsx";
import type { ComposerView } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import styles from "./Composer.module.css";
import { Composer, type ComposerProps } from "./Composer.tsx";

/** A CSS-module class name, which TypeScript sees as possibly undefined. */
function cls(name: string | undefined): string {
  if (!name) throw new Error("missing CSS module class");
  return name;
}

type Handlers = Omit<ComposerProps, "view" | "models" | "canSend" | "disabled">;

function handlers(): Handlers {
  return {
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    onSetMode: vi.fn(),
    onCycleMode: vi.fn(),
    onSetModel: vi.fn(),
    onSetEffort: vi.fn(),
    onCompact: vi.fn(),
    onSendQueuedNow: vi.fn(),
    onRemoveQueued: vi.fn(),
    onManageModels: vi.fn(),
  };
}

/** Holds the draft, as the store does. */
function Harness(
  props: Handlers & {
    view: ComposerView;
    canSend: boolean;
    disabled?: boolean;
    loadedModelId?: string | null;
  },
) {
  const [draft, setDraft] = useState(props.view.draft);
  return (
    <Composer
      {...props}
      view={{ ...props.view, draft }}
      models={TEST_MODELS}
      onDraftChange={(text) => {
        setDraft(text);
        props.onDraftChange(text);
      }}
      onSubmit={(text) => {
        props.onSubmit(text);
        setDraft("");
      }}
    />
  );
}

function setup(
  theme: ResolvedTheme,
  options: {
    view?: Partial<ComposerView>;
    canSend?: boolean;
    disabled?: boolean;
    loadedModelId?: string | null;
  } = {},
) {
  const on = handlers();
  renderInTheme(
    <Harness
      {...on}
      view={sampleComposer(options.view)}
      canSend={options.canSend ?? true}
      disabled={options.disabled}
      loadedModelId={options.loadedModelId ?? null}
    />,
    theme,
  );
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const textbox = screen.getByRole("textbox", { name: "Message to dawg" });
  return { on, user, textbox };
}

describe.each(THEMES)("Composer (%s)", (theme) => {
  describe("the message box", () => {
    it("sends with Enter and adds a line with Shift+Enter", async () => {
      const { on, user, textbox } = setup(theme);
      expect(textbox).toHaveAttribute(
        "placeholder",
        "Reply to dawg. / for commands, @ to mention a file",
      );
      await user.type(textbox, "Fix the test{Shift>}{Enter}{/Shift}without changing it");
      expect(textbox).toHaveValue("Fix the test\nwithout changing it");
      expect(on.onSubmit).not.toHaveBeenCalled();
      await user.keyboard("{Enter}");
      expect(on.onSubmit).toHaveBeenCalledWith("Fix the test\nwithout changing it");
      expect(textbox).toHaveValue("");
    });

    it("keeps the draft in the store as it is typed", async () => {
      const { on, user, textbox } = setup(theme);
      await user.type(textbox, "hi");
      expect(on.onDraftChange).toHaveBeenLastCalledWith("hi");
    });

    it("does not send while an IME composition is open", async () => {
      const { on, user, textbox } = setup(theme);
      await user.type(textbox, "nihao");
      fireEvent.compositionStart(textbox);
      fireEvent.keyDown(textbox, { key: "Enter" });
      expect(on.onSubmit).not.toHaveBeenCalled();
      fireEvent.compositionEnd(textbox);
      fireEvent.keyDown(textbox, { key: "Enter", isComposing: true });
      expect(on.onSubmit).not.toHaveBeenCalled();
      fireEvent.keyDown(textbox, { key: "Enter" });
      expect(on.onSubmit).toHaveBeenCalledWith("nihao");
    });

    it("sends nothing when the draft is blank, and Send puts focus in the box", async () => {
      const { on, user, textbox } = setup(theme);
      const send = screen.getByRole("button", { name: "Send" });
      expect(send).toBeEnabled();
      expect(send).toHaveClass(cls(styles.send));
      await user.click(send);
      expect(on.onSubmit).not.toHaveBeenCalled();
      expect(textbox).toHaveFocus();
      await user.type(textbox, "   {Enter}");
      await user.click(send);
      expect(on.onSubmit).not.toHaveBeenCalled();
      expect(textbox).toHaveFocus();
    });

    it("sends with the Send button", async () => {
      const { on, user, textbox } = setup(theme);
      await user.type(textbox, "go");
      await user.click(screen.getByRole("button", { name: "Send" }));
      expect(on.onSubmit).toHaveBeenCalledWith("go");
    });

    it("sends nothing while the engine is not ready", async () => {
      const { on, user, textbox } = setup(theme, { canSend: false });
      await user.type(textbox, "hello{Enter}");
      expect(on.onSubmit).not.toHaveBeenCalled();
      const send = screen.getByRole("button", { name: "Send" });
      expect(send).toBeEnabled();
      await user.click(send);
      expect(on.onSubmit).not.toHaveBeenCalled();
      expect(textbox).toHaveFocus();
    });

    it("is disabled when the connection failed", () => {
      const { textbox } = setup(theme, { disabled: true });
      expect(textbox).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Permission mode: Accept edits" })).toBeDisabled();
    });

    it("cycles the mode with Shift+Tab", async () => {
      const { on, user, textbox } = setup(theme);
      await user.click(textbox);
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(on.onCycleMode).toHaveBeenCalledOnce();
      expect(textbox).toHaveFocus();
    });

    it("says how a message answers a waiting card, and offers Send", () => {
      setup(theme, {
        view: {
          status: "waiting",
          working: false,
          answering: { kind: "permission", requestId: "r1", turnId: "t1" },
          placeholder: "Waiting on you. A message here denies the command and tells dawg why.",
        },
      });
      expect(screen.getByRole("textbox", { name: "Message to dawg" })).toHaveAttribute(
        "placeholder",
        "Waiting on you. A message here denies the command and tells dawg why.",
      );
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop, or press Esc" })).not.toBeInTheDocument();
    });
  });

  describe("Send and Stop", () => {
    it("shows Stop while dawg works", async () => {
      const { on, user } = setup(theme, { view: { working: true, status: "working" } });
      expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
      const stop = screen.getByRole("button", { name: "Stop, or press Esc" });
      expect(stop).toHaveClass(cls(styles.send), cls(styles.stop));
      await user.click(stop);
      expect(on.onInterrupt).toHaveBeenCalledOnce();
    });

    it("still takes Enter while dawg works, to queue the message", async () => {
      const { on, user, textbox } = setup(theme, { view: { working: true, status: "working" } });
      await user.type(textbox, "also the README{Enter}");
      expect(on.onSubmit).toHaveBeenCalledWith("also the README");
    });
  });

  describe("the command menu", () => {
    it("opens on / and filters by what is typed", async () => {
      const { user, textbox } = setup(theme);
      await user.type(textbox, "/");
      const list = screen.getByRole("listbox", { name: "Commands" });
      expect(within(list).getAllByRole("option")).toHaveLength(4);
      expect(textbox).toHaveAttribute("aria-controls", list.id);

      await user.type(textbox, "c");
      const names = () =>
        within(list)
          .getAllByRole("option")
          .map((option) => option.textContent?.match(/^\/[a-z]+/)?.[0]);
      expect(names()).toEqual(["/clear", "/compact", "/context"]);
      expect(screen.getByRole("option", { name: /compact/ })).toHaveTextContent(
        "/compact [focus]Summarise the conversation to free context",
      );
      await user.type(textbox, "omp");
      expect(within(list).getAllByRole("option")).toHaveLength(1);
      await user.type(textbox, "x");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("moves with the arrow keys and sends a command without arguments on Enter", async () => {
      const { on, user, textbox } = setup(theme);
      await user.type(textbox, "/");
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
      expect(textbox).toHaveAttribute("aria-activedescendant", options[0]?.id);
      await user.keyboard("{ArrowDown}{ArrowDown}");
      const current = screen.getAllByRole("option")[2];
      expect(current).toHaveAttribute("aria-selected", "true");
      expect(current).toHaveTextContent("/context");
      expect(textbox).toHaveAttribute("aria-activedescendant", current?.id);
      await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
      expect(screen.getAllByRole("option")[3]).toHaveAttribute("aria-selected", "true");

      await user.clear(textbox);
      await user.type(textbox, "/he");
      await user.keyboard("{Enter}");
      expect(on.onSubmit).toHaveBeenCalledWith("/help");
    });

    it("completes a command that takes arguments, with Enter or Tab", async () => {
      const { on, user, textbox } = setup(theme);
      await user.type(textbox, "/comp{Enter}");
      expect(textbox).toHaveValue("/compact ");
      expect(on.onSubmit).not.toHaveBeenCalled();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

      await user.clear(textbox);
      await user.type(textbox, "/comp{Tab}");
      expect(textbox).toHaveValue("/compact ");
      expect(textbox).toHaveFocus();
    });

    it("completes a command without arguments on Tab, then sends it on Enter", async () => {
      const { on, user, textbox } = setup(theme);
      await user.type(textbox, "/hel{Tab}");
      expect(textbox).toHaveValue("/help");
      expect(on.onSubmit).not.toHaveBeenCalled();
      await user.keyboard("{Enter}");
      expect(on.onSubmit).toHaveBeenCalledWith("/help");
    });

    it("chooses with the mouse", async () => {
      const { on, user, textbox } = setup(theme);
      await user.type(textbox, "/");
      await user.click(screen.getByRole("option", { name: /clear/ }));
      expect(on.onSubmit).toHaveBeenCalledWith("/clear");
      expect(textbox).toHaveFocus();
    });

    it("closes on Esc without touching the draft", async () => {
      const { on, user, textbox } = setup(theme);
      await user.type(textbox, "/co");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(textbox).toHaveValue("/co");
      expect(on.onInterrupt).not.toHaveBeenCalled();
      await user.type(textbox, "m");
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      await user.clear(textbox);
      await user.type(textbox, "/com");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
  });

  describe("the mode menu", () => {
    it("shows the mode in its tone with the ⇧⇥ hint", () => {
      setup(theme);
      const pill = screen.getByRole("button", { name: "Permission mode: Accept edits" });
      expect(pill).toHaveClass(cls(styles.pill), cls(styles.toneAccent));
      expect(pill).toHaveTextContent("Accept edits⇧⇥");
    });

    it.each([
      ["default", "Ask first", undefined],
      ["plan", "Plan", styles.toneBlue],
      ["dontAsk", "Don’t ask", styles.toneAmber],
      ["bypassPermissions", "Bypass", styles.toneRed],
    ] as const)("tones %s", (mode, label, tone) => {
      setup(theme, { view: { mode } });
      const pill = screen.getByRole("button", { name: `Permission mode: ${label}` });
      for (const name of [styles.toneAccent, styles.toneBlue, styles.toneAmber, styles.toneRed]) {
        if (name === tone) expect(pill).toHaveClass(cls(name));
        else expect(pill).not.toHaveClass(cls(name));
      }
    });

    it("lists the five modes with the current one checked, and picks one", async () => {
      const { on, user } = setup(theme);
      await user.click(screen.getByRole("button", { name: "Permission mode: Accept edits" }));
      const menu = screen.getByRole("menu");
      expect(within(menu).getByText("Permission mode")).toBeInTheDocument();
      const items = within(menu).getAllByRole("menuitemradio");
      expect(items.map((item) => item.textContent)).toEqual([
        "Ask firstAsks before every edit and command",
        "Accept editsEdits apply; commands still ask",
        "PlanReads and plans; changes nothing",
        "Don’t askOnly what rules allow; the rest is refused",
        "BypassEverything runs without asking",
      ]);
      expect(within(menu).getByRole("menuitemradio", { name: /^Accept edits/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(within(menu).getByText("cycles through the modes")).toBeInTheDocument();
      await user.click(within(menu).getByRole("menuitemradio", { name: /^Plan/ }));
      expect(on.onSetMode).toHaveBeenCalledWith("plan");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("works from the keyboard and closes on Esc", async () => {
      const { on, user } = setup(theme);
      screen.getByRole("button", { name: "Permission mode: Accept edits" }).focus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("menu")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(on.onSetMode).not.toHaveBeenCalled();
    });
  });

  describe("the model menu", () => {
    it("groups models on this Mac and on servers, checks the current one, and picks", async () => {
      const { on, user } = setup(theme);
      await user.click(screen.getByRole("button", { name: "Model: Qwen3.8 27B · 8-bit" }));
      const menu = screen.getByRole("menu");
      expect(within(menu).getByText("On this Mac")).toBeInTheDocument();
      expect(within(menu).getByText("Servers")).toBeInTheDocument();
      expect(
        within(menu).getByRole("menuitemradio", { name: /^Qwen3.8 27B \(8-bit\)/ }),
      ).toHaveAttribute("aria-checked", "true");
      expect(
        within(menu).getByText("Bundled runtime · 204.8K context · loaded"),
      ).toBeInTheDocument();
      expect(
        within(menu).getByRole("menuitemradio", { name: /^Ollama · qwen3.6:35b-a3b/ }),
      ).toHaveAttribute("aria-checked", "false");
      await user.click(within(menu).getByRole("menuitemradio", { name: /^gpt-oss 20B/ }));
      expect(on.onSetModel).toHaveBeenCalledWith("gpt-oss-20b-q4");
    });

    it("says switching to another model on this Mac reloads it", async () => {
      const { user } = setup(theme, { loadedModelId: "qwen3.8-27b-q8" });
      await user.click(screen.getByRole("button", { name: "Model: Qwen3.8 27B · 8-bit" }));
      const menu = screen.getByRole("menu");
      // The loaded one does not; another bundled one does, once; a server's model does not.
      expect(
        within(menu).getByRole("menuitemradio", { name: /^Qwen3.8 27B \(8-bit\)/ }),
      ).not.toHaveTextContent("reloads");
      expect(
        within(menu).getByText(
          "Found in LM Studio’s folder · 64K context · text only · switching reloads the model",
        ),
      ).toBeInTheDocument();
      expect(
        within(menu).getByText("Bundled runtime · 128K context · switching reloads the model"),
      ).toBeInTheDocument();
      expect(
        within(menu).getByRole("menuitemradio", { name: /^Ollama · qwen3.6:35b-a3b/ }),
      ).not.toHaveTextContent("reloads");
    });

    it("links to the model settings", async () => {
      const { on, user } = setup(theme);
      await user.click(screen.getByRole("button", { name: "Model: Qwen3.8 27B · 8-bit" }));
      await user.click(screen.getByRole("menuitem", { name: "Manage models…" }));
      expect(on.onManageModels).toHaveBeenCalledOnce();
    });
  });

  describe("the effort menu", () => {
    it("shows the effort and picks a level or the model's default", async () => {
      const { on, user } = setup(theme);
      await user.click(screen.getByRole("button", { name: "Effort: xhigh" }));
      const menu = screen.getByRole("menu");
      expect(within(menu).getByText("Reasoning effort · Qwen3.8 27B · 8-bit")).toBeInTheDocument();
      expect(
        within(menu)
          .getAllByRole("menuitemradio")
          .map((item) => item.textContent),
      ).toEqual([
        "Model defaultUses the model’s own default level",
        "lowQuickest; for small, clear edits",
        "mediumFaster replies, still plans ahead",
        "highThinks it through; good default for real work",
        "xhighThinks longest; best for hard bugs",
      ]);
      expect(within(menu).getByRole("menuitemradio", { name: /^xhigh/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(
        within(menu).getByText("Levels come from the model. Lower effort answers sooner."),
      ).toBeInTheDocument();
      await user.click(within(menu).getByRole("menuitemradio", { name: /^low/ }));
      expect(on.onSetEffort).toHaveBeenLastCalledWith("low");

      await user.click(screen.getByRole("button", { name: "Effort: xhigh" }));
      await user.click(screen.getByRole("menuitemradio", { name: /^Model default/ }));
      expect(on.onSetEffort).toHaveBeenLastCalledWith(null);
    });

    it("says default when no effort is set", () => {
      setup(theme, { view: { effort: { value: null, levels: ["low", "high"] } } });
      expect(screen.getByRole("button", { name: "Effort: default" })).toBeInTheDocument();
    });

    it("is hidden when the model has no levels", () => {
      setup(theme, { view: { effort: { value: null, levels: [] } } });
      expect(screen.queryByRole("button", { name: /^Effort/ })).not.toBeInTheDocument();
    });
  });

  describe("the context meter", () => {
    it("shows how full the context is, and the details in a popover", async () => {
      const { on, user } = setup(theme);
      const pill = screen.getByRole("button", { name: "Context used: 74.2K / 204.8K" });
      const ring = pill.querySelector("svg");
      expect(ring?.querySelectorAll("circle")).toHaveLength(2);
      await user.click(pill);
      const dialog = screen.getByRole("dialog", { name: "Context · 36% of 204.8K tokens" });
      const rows = within(dialog)
        .getAllByRole("term")
        .map((term) => term.textContent);
      expect(rows).toEqual(["System prompt", "Instructions", "Tools", "Messages", "Free"]);
      expect(
        within(dialog)
          .getAllByRole("definition")
          .map((value) => value.textContent),
      ).toEqual(["4.1K", "1.2K", "11K", "57.9K", "130.6K"]);
      expect(dialog).toHaveTextContent(
        "Last request: read 1,240 tokens/s, wrote 41 tokens/s, 97% of the prompt from cache.",
      );
      expect(dialog).toHaveTextContent("Compacts on its own at 65% (133.1K).");
      const mark = within(dialog).getByTestId("compact-mark");
      expect(mark.style.left).toBe("65%");
      await user.click(within(dialog).getByRole("button", { name: /Compact now/ }));
      expect(on.onCompact).toHaveBeenCalledOnce();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("falls back for sessions stored before the split and the threshold were reported", async () => {
      const { user } = setup(theme, {
        view: {
          context: {
            ...(sampleComposer().context as NonNullable<ComposerView["context"]>),
            breakdown: null,
            compactAt: null,
          },
        },
      });
      await user.click(screen.getByRole("button", { name: /^Context used/ }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog)
          .getAllByRole("term")
          .map((term) => term.textContent),
      ).toEqual(["Read from cache on the last request", "Rest of the context", "Free"]);
      expect(dialog).not.toHaveTextContent("Compacts on its own");
      expect(within(dialog).queryByTestId("compact-mark")).toBeNull();
    });

    it("closes its popover on Esc", async () => {
      const { user } = setup(theme);
      await user.click(screen.getByRole("button", { name: /^Context used/ }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("says so while compacting", async () => {
      const { user } = setup(theme, {
        view: {
          context: {
            ...(sampleComposer().context as NonNullable<ComposerView["context"]>),
            compacting: true,
          },
        },
      });
      await user.click(screen.getByRole("button", { name: /^Context used/ }));
      expect(screen.getByRole("button", { name: /Compacting…/ })).toBeDisabled();
    });

    it("is hidden until the context is known", () => {
      setup(theme, { view: { context: null } });
      expect(screen.queryByRole("button", { name: /^Context used/ })).not.toBeInTheDocument();
    });
  });

  describe("waiting messages", () => {
    it("shows queued and held messages with their actions", async () => {
      const { on, user } = setup(theme, {
        view: {
          working: true,
          queue: [
            { id: "q1", text: "also update the README example", state: "queued" },
            { id: "q2", text: "and bump the version", state: "held" },
          ],
        },
      });
      const list = screen.getByRole("list", { name: "Waiting messages" });
      const [queued, held] = within(list).getAllByRole("listitem");
      if (!queued || !held) throw new Error("expected two rows");
      expect(queued).toHaveTextContent(
        "Queued: also update the README example · sends when this turn ends",
      );
      expect(within(queued).getByText("also update the README example").tagName).toBe("B");
      expect(within(queued).queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
      expect(held).toHaveTextContent(
        "Held: and bump the version · not sent, because you stopped the turn",
      );

      await user.click(within(held).getByRole("button", { name: "Send now" }));
      expect(on.onSendQueuedNow).toHaveBeenCalledWith("q2");
      await user.click(within(held).getByRole("button", { name: "Remove" }));
      expect(on.onRemoveQueued).toHaveBeenCalledWith("q2");
      await user.click(within(queued).getByRole("button", { name: "Remove" }));
      expect(on.onRemoveQueued).toHaveBeenCalledWith("q1");
    });

    it("shows nothing when nothing waits", () => {
      setup(theme);
      expect(screen.queryByRole("list", { name: "Waiting messages" })).not.toBeInTheDocument();
    });
  });

  describe("attaching images", () => {
    it("is not available yet, and says why on focus", async () => {
      const { user, textbox } = setup(theme);
      const attach = screen.getByRole("button", { name: "Attach an image" });
      expect(attach).toHaveAttribute("aria-disabled", "true");
      await user.click(textbox);
      await user.tab();
      expect(attach).toHaveFocus();
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Images come in a later build");
    });
  });
});
