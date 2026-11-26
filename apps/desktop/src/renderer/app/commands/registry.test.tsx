import type { PermissionMode } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { MODE_ORDER } from "../../lib/modes.ts";
import type { AppStore } from "../../state/types.ts";
import { paletteFor } from "../palette/controller.ts";
import { commandContext } from "./dispatch.ts";
import { shortcutSignature } from "./keys.ts";
import {
  availability,
  COMMANDS,
  commandById,
  currentSessionId,
  dynamicCommands,
  neighbourSession,
  WINDOW_COMMANDS,
} from "./registry.ts";
import { takeNewTerminalRequest } from "./requests.ts";
import { SHORTCUTS } from "./shortcuts.ts";
import { SAMPLE_SESSIONS, SITE, sessionsStore, TALLY } from "./testing.ts";
import { COMMAND_GROUPS, type Command } from "./types.ts";

function command(id: string): Command {
  const found = commandById(id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

function runIn(test: ReturnType<typeof sessionsStore>, id: string, from?: Command[]): void {
  const context = commandContext(test.store, "darwin");
  const found = from?.find((candidate) => candidate.id === id) ?? command(id);
  expect(availability(found, context.state)).toBe(true);
  found.run?.(context);
}

/** Keys macOS, the app menu, text editing and the editor keep for themselves. */
const RESERVED = [
  "mod+q",
  "mod+h",
  "alt+mod+h",
  "mod+m",
  "mod+w",
  "mod+`",
  "mod+z",
  "shift+mod+z",
  "mod+x",
  "mod+c",
  "mod+v",
  "mod+a",
  "alt+shift+mod+v",
  "mod+0",
  "mod+=",
  "mod+-",
  "mod+r",
  "shift+mod+r",
  "alt+mod+i",
  "mod+f",
  "mod+s",
  "mod+d",
  "mod+l",
  "mod+[",
  "mod+]",
  "alt+mod+[",
  "alt+mod+]",
  "shift+mod+3",
  "shift+mod+4",
  "shift+mod+5",
];

describe("the action registry", () => {
  it("gives every action a unique id, a sentence-case title and a known group", () => {
    const ids = new Set<string>();
    for (const entry of COMMANDS) {
      expect(ids.has(entry.id), entry.id).toBe(false);
      ids.add(entry.id);
      expect(entry.title, entry.id).toMatch(/^[A-Z1-9]/);
      expect(entry.title, entry.id).not.toMatch(/[.!]$/);
      expect(COMMAND_GROUPS, entry.id).toContain(entry.group);
      // Either it runs, or it documents keys handled elsewhere.
      expect(entry.run !== undefined || entry.shortcut !== undefined, entry.id).toBe(true);
    }
    for (const group of COMMAND_GROUPS) {
      expect(
        COMMANDS.some((entry) => entry.group === group),
        group,
      ).toBe(true);
    }
  });

  it("never gives two actions the same keys in the same place", () => {
    const seen = new Map<string, string>();
    for (const entry of COMMANDS) {
      for (const keys of entry.shortcut?.keys ?? []) {
        const slot = `${entry.shortcut?.scope}:${shortcutSignature(keys)}`;
        expect(seen.get(slot), `${entry.id} and ${seen.get(slot)} share ${slot}`).toBeUndefined();
        seen.set(slot, entry.id);
      }
    }
  });

  it("runs every window shortcut itself, and only lists the keys other parts handle", () => {
    for (const entry of COMMANDS) {
      if (entry.shortcut?.scope === "window") expect(entry.run, entry.id).toBeDefined();
      if (entry.run === undefined) expect(entry.shortcut?.scope, entry.id).not.toBe("window");
    }
    const bound = new Set(WINDOW_COMMANDS.flatMap((entry) => entry.shortcut?.keys ?? []));
    for (const [name, shortcut] of Object.entries(SHORTCUTS)) {
      expect(bound.has(shortcut), name).toBe(true);
    }
  });

  it("stays clear of the keys macOS, the menus, text fields and the editor use", () => {
    for (const entry of WINDOW_COMMANDS) {
      for (const keys of entry.shortcut?.keys ?? []) {
        const signature = shortcutSignature(keys);
        expect(RESERVED, `${entry.id} uses ${signature}`).not.toContain(signature);
        // Every ⌃-key belongs to text fields on macOS and to the shell in the terminal.
        expect(keys.ctrl, entry.id).not.toBe(true);
      }
    }
  });

  it("follows Claude Code: Esc stops the turn, ⇧Tab cycles the mode, ⌘K opens the palette", () => {
    expect(command("session.stop").shortcut?.keys).toEqual([{ key: "Escape" }]);
    expect(command("mode.cycle").shortcut).toEqual({
      keys: [{ key: "Tab", shift: true }],
      scope: "composer",
    });
    expect(command("palette.toggle").shortcut?.keys).toEqual([SHORTCUTS.palette]);
    expect(command("sessions.search").shortcut?.keys).not.toEqual([SHORTCUTS.palette]);
  });

  it("adds the projects, models and effort levels the state has, without shortcuts", () => {
    const { store } = sessionsStore();
    const dynamic = dynamicCommands(store.getState());
    const titles = dynamic.map((entry) => entry.title);
    expect(titles).toContain("New session in tally");
    expect(titles).toContain("New session in dawg-site");
    expect(titles).toContain("Model: Qwen3.8 27B (8-bit)");
    expect(titles).toContain("Effort: model default");
    expect(titles).toContain("Effort: xhigh");
    expect(titles).toContain("Default model: gpt-oss 20B (4-bit)");
    for (const entry of dynamic) {
      expect(entry.shortcut, entry.id).toBeUndefined();
      expect(
        COMMANDS.some((other) => other.id === entry.id),
        entry.id,
      ).toBe(false);
    }
    expect(new Set(dynamic.map((entry) => entry.id)).size).toBe(dynamic.length);
  });
});

describe("what applies when", () => {
  const canRun = (state: AppStore, id: string) => availability(command(id), state);

  it("offers the session's actions while it shows", () => {
    const { store } = sessionsStore();
    const state = store.getState();
    expect(currentSessionId(state)).toBe("fix");
    for (const id of ["session.rename", "session.fork", "session.archive", "pane.files"]) {
      expect(canRun(state, id), id).toBe(true);
    }
    expect(canRun(state, "session.stop")).toBe("Nothing is running");
    expect(canRun(state, "session.send-held")).toBe("No message is held");
    expect(canRun(state, "settings.back")).toBe(false);
  });

  it("says a session must be selected first", () => {
    const { store } = sessionsStore({ selected: null });
    expect(canRun(store.getState(), "session.fork")).toBe("Select a session first");
    expect(canRun(store.getState(), "pane.changes")).toBe("Select a session first");
  });

  it("leaves the session's actions out of Settings", () => {
    const { store } = sessionsStore({
      patch: (state) => ({ layout: { ...state.layout, view: "settings" } }),
    });
    const state = store.getState();
    expect(canRun(state, "session.fork")).toBe(false);
    expect(canRun(state, "sidebar.toggle")).toBe(false);
    expect(canRun(state, "settings.back")).toBe(true);
    expect(canRun(state, "session.new")).toBe(true);
    expect(dynamicCommands(state).some((entry) => entry.id.startsWith("model:"))).toBe(false);
  });

  it("offers only Settings, appearance and help on first run", () => {
    const { store } = sessionsStore({ patch: () => ({ onboarding: { step: "welcome" } }) });
    const state = store.getState();
    const runnable = [...COMMANDS, ...dynamicCommands(state)]
      .filter((entry) => entry.run && availability(entry, state) === true)
      .map((entry) => entry.group);
    expect(new Set(runnable)).toEqual(new Set(["View", "Command palette", "Settings", "Help"]));
  });

  it("stops a working session and sends a held message", () => {
    const { store, actions } = sessionsStore({
      open: { fix: { activeTurnId: "t1" } },
      patch: (state) => ({
        ui: {
          ...state.ui,
          queues: { fix: [{ id: "q1", text: "and the docs", state: "held" }] },
        },
      }),
    });
    runIn({ store, actions }, "session.stop");
    expect(actions.interrupt).toHaveBeenCalledWith("fix");
    runIn({ store, actions }, "session.send-held");
    expect(actions.sendQueuedNow).toHaveBeenCalledWith("fix", "q1");
  });

  it("does not offer a worktree for a project that is not a git repository", () => {
    const { store } = sessionsStore({
      patch: () => ({ workspaces: { fix: { sessionId: "fix", cwd: TALLY, git: null } } }),
    });
    expect(canRun(store.getState(), "session.new-worktree")).toBe(
      "This project is not a git repository",
    );
  });
});

describe("running actions", () => {
  it("sets each mode and cycles them", () => {
    const test = sessionsStore();
    for (const mode of MODE_ORDER) runIn(test, `mode.${mode}`);
    expect(test.actions.setMode.mock.calls.map(([, mode]) => mode)).toEqual<PermissionMode[]>([
      ...MODE_ORDER,
    ]);
    expect(command("mode.default").checked?.(test.store.getState())).toBe(true);
    runIn(test, "mode.cycle");
    expect(test.actions.cycleMode).toHaveBeenCalledWith("fix");
  });

  it("chooses a model and an effort level", () => {
    const test = sessionsStore();
    const dynamic = dynamicCommands(test.store.getState());
    runIn(test, "model:gpt-oss-20b-q4", dynamic);
    expect(test.actions.setModel).toHaveBeenCalledWith("fix", "gpt-oss-20b-q4");
    runIn(test, "effort:high", dynamic);
    runIn(test, "effort:default", dynamic);
    expect(test.actions.setEffort.mock.calls).toEqual([
      ["fix", "high"],
      ["fix", null],
    ]);
    runIn(test, "default-model:gpt-oss-20b-q4", dynamic);
    expect(test.actions.setDefaultModel).toHaveBeenCalledWith("gpt-oss-20b-q4");
  });

  it("starts sessions in the project, its folder or a new worktree", () => {
    const test = sessionsStore();
    runIn(test, "session.new");
    runIn(test, "session.new-in-folder");
    runIn(test, "session.new-worktree");
    runIn(test, `session.new-in:${SITE}`, dynamicCommands(test.store.getState()));
    expect(test.actions.newSession.mock.calls).toEqual([
      [],
      [{ projectDir: TALLY, worktree: false }],
      [{ projectDir: TALLY, ask: "worktree" }],
      [{ projectDir: SITE }],
    ]);
  });

  it("moves to the next and previous session in sidebar order, wrapping round", () => {
    const test = sessionsStore({ selected: "csv" });
    const state = () => test.store.getState();
    // tally: fix, csv; dawg-site: docs, links. The archived session is not listed.
    expect(neighbourSession(state(), 1)).toBe("docs");
    expect(neighbourSession(state(), -1)).toBe("fix");
    runIn(test, "session.next");
    expect(test.actions.selectSession).toHaveBeenLastCalledWith("docs");
    runIn(test, "session.next");
    runIn(test, "session.next");
    expect(test.actions.selectSession).toHaveBeenLastCalledWith("fix");
    runIn(test, "session.previous");
    expect(test.actions.selectSession).toHaveBeenLastCalledWith("links");
  });

  it("has nowhere to go with one session", () => {
    const test = sessionsStore({ summaries: SAMPLE_SESSIONS.slice(0, 1) });
    expect(availability(command("session.next"), test.store.getState())).toBe(
      "There is no other session",
    );
  });

  it("opens panes and shows or hides the dock", () => {
    const test = sessionsStore();
    runIn(test, "pane.terminal");
    expect(test.actions.openPane).toHaveBeenLastCalledWith("terminal");
    runIn(test, "panes.toggle");
    expect(test.actions.closeDock).toHaveBeenCalledOnce();
    runIn(test, "panes.toggle");
    expect(test.actions.openPane).toHaveBeenLastCalledWith("terminal");
  });

  it("opens a terminal by asking the Terminal pane for one", () => {
    const test = sessionsStore();
    runIn(test, "terminal.new");
    expect(test.actions.openPane).toHaveBeenLastCalledWith("terminal");
    expect(takeNewTerminalRequest("fix")).toBe(true);
    expect(takeNewTerminalRequest("fix")).toBe(false);
  });

  it("asks for a title or a confirmation in the palette", () => {
    const test = sessionsStore();
    const palette = paletteFor(test.store);
    runIn(test, "session.rename");
    expect(palette.getSnapshot().view).toEqual({ kind: "rename", sessionId: "fix" });
    palette.close();
    runIn(test, "session.delete");
    expect(palette.getSnapshot().deleting).toBe("fix");
    expect(test.actions.deleteSession).not.toHaveBeenCalled();
  });

  it("opens Settings pages and changes the appearance", () => {
    const test = sessionsStore();
    runIn(test, "settings.permissions");
    expect(test.actions.setSettingsPage).toHaveBeenLastCalledWith("permissions");
    expect(test.actions.setView).toHaveBeenLastCalledWith("settings");
    runIn(test, "help.shortcuts");
    expect(test.actions.setSettingsPage).toHaveBeenLastCalledWith("shortcuts");
    runIn(test, "appearance.system");
    expect(test.actions.setAppearance).toHaveBeenLastCalledWith("system");
    runIn(test, "appearance.toggle");
    expect(test.actions.setAppearance).toHaveBeenLastCalledWith("light");
    runIn(test, "tool-calls.open");
    expect(test.actions.setToolCallDisplay).toHaveBeenLastCalledWith("open");
  });
});
