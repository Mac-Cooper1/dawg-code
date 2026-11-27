/**
 * The action registry: every action a person can take in the window, with its shortcut. Actions
 * call the store's actions; nothing here keeps state of its own.
 *
 * Entries without `run` document keys that another part of the window handles itself (⏎ in the
 * composer, ⌘⏎ on a card), so Settings → Shortcuts lists the whole keymap.
 */
import type { SessionId } from "@dawg/protocol";
import {
  type Appearance,
  type Pane,
  PROJECT_URL,
  type ToolCallDisplay,
} from "../../../shared/bridge.ts";
import { shortenPath } from "../../lib/format.ts";
import { EFFORT_INFO, MODE_INFO, MODE_ORDER } from "../../lib/modes.ts";
import { SIDEBAR_SEARCH_ID } from "../../sidebar/Sidebar.tsx";
import { selectComposer } from "../../state/selectors.ts";
import { sidebarOrder } from "../../state/sidebar-order.ts";
import type { AppStore, SettingsPage } from "../../state/types.ts";
import { PANES } from "../panes.ts";
import { run } from "../run.ts";
import type { Shortcut } from "./keys.ts";
import { requestNewTerminal } from "./requests.ts";
import { SHORTCUTS } from "./shortcuts.ts";
import type {
  Availability,
  Command,
  CommandContext,
  CommandShortcut,
  ShortcutScope,
} from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A shortcut the registry runs, also while typing (it types nothing itself). */
function inWindow(...keys: Shortcut[]): CommandShortcut {
  return { keys, scope: "window", whileTyping: true };
}

/** Keys that part of the window handles itself, listed for the keymap. */
function handledIn(scope: ShortcutScope, ...keys: Shortcut[]): CommandShortcut {
  return { keys, scope };
}

const key = (name: string, modifiers: Omit<Shortcut, "key"> = {}): Shortcut => ({
  key: name,
  ...modifiers,
});

/** The composer's text field, focused by "Go to the message field". */
const COMPOSER_SELECTOR = 'textarea[aria-label="Message to dawg"]';

function isFirstRun(state: AppStore): boolean {
  return state.onboarding !== null;
}

/** The session the window shows, while the sessions view is up. */
export function currentSessionId(state: AppStore): SessionId | null {
  if (isFirstRun(state) || state.layout.view !== "sessions") return null;
  const id = state.layout.selectedSessionId;
  return id !== null && selectComposer(state, id) !== null ? id : null;
}

/** For actions on the session the window shows. Not offered in Settings or on first run. */
function forSession(state: AppStore, check?: (id: SessionId) => Availability): Availability {
  if (isFirstRun(state) || state.layout.view !== "sessions") return false;
  const id = currentSessionId(state);
  if (id === null) return "Select a session first";
  return check ? check(id) : true;
}

function onSession(task: (id: SessionId, context: CommandContext) => void) {
  return (context: CommandContext) => {
    const id = currentSessionId(context.state);
    if (id !== null) task(id, context);
  };
}

/** Anywhere but first run, where no model runs yet. */
function afterFirstRun(state: AppStore): Availability {
  return !isFirstRun(state);
}

function toSessions(context: CommandContext): void {
  if (context.state.layout.view !== "sessions") context.actions.setView("sessions");
}

/** The project of the session the window shows. */
function currentProject(state: AppStore): string | null {
  const id = currentSessionId(state);
  return id === null ? null : (state.sessions[id]?.summary.projectDir ?? null);
}

/** Sessions in sidebar order (with its search applied), flattened. */
function sessionOrder(state: AppStore): SessionId[] {
  return sidebarOrder(state.sessions, state.layout.search).flatMap((group) =>
    group.sessions.map((session) => session.id),
  );
}

/** The session after (1) or before (-1) the selected one in the sidebar, wrapping round. */
export function neighbourSession(state: AppStore, step: 1 | -1): SessionId | null {
  const order = sessionOrder(state);
  if (order.length === 0) return null;
  const index = order.indexOf(state.layout.selectedSessionId ?? "");
  if (index === -1) return (step === 1 ? order[0] : order.at(-1)) ?? null;
  const next = order[(index + step + order.length) % order.length] ?? null;
  return next === state.layout.selectedSessionId ? null : next;
}

function stepSession(step: 1 | -1) {
  return {
    when: (state: AppStore): Availability => {
      if (isFirstRun(state)) return false;
      return neighbourSession(state, step) !== null || "There is no other session";
    },
    run: (context: CommandContext) => {
      const next = neighbourSession(context.state, step);
      if (next === null) return;
      context.actions.selectSession(next);
      toSessions(context);
    },
  };
}

function focusSidebarSearch(): boolean {
  const input = document.getElementById(SIDEBAR_SEARCH_ID);
  if (!(input instanceof HTMLInputElement)) return false;
  input.focus();
  input.select();
  return true;
}

function focusComposer(): boolean {
  const field = document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
  if (!field) return false;
  field.focus();
  return true;
}

/** Focuses once React has drawn what the action changed (the sidebar may only now appear). */
function focusSoon(focus: () => boolean): void {
  if (!focus()) setTimeout(focus, 0);
}

function openSettings(page: SettingsPage) {
  return (context: CommandContext) => {
    context.actions.setSettingsPage(page);
    context.actions.setView("settings");
  };
}

function isWorkingIn(state: AppStore, id: SessionId): boolean {
  return selectComposer(state, id)?.working ?? false;
}

function heldMessage(state: AppStore, id: SessionId) {
  return state.ui.queues[id]?.find((message) => message.state === "held") ?? null;
}

// ---------------------------------------------------------------------------------------------
// The actions
// ---------------------------------------------------------------------------------------------

const SESSIONS: Command[] = [
  {
    id: "session.new",
    title: "New session…",
    group: "Sessions",
    keywords: ["start", "create", "folder", "project"],
    shortcut: inWindow(SHORTCUTS.newSession),
    when: afterFirstRun,
    run: (context) => {
      toSessions(context);
      // Opens the folder picker, and maybe the new-session dialog.
      context.palette.whenClosed(() => run(context.actions.newSession()));
    },
  },
  {
    id: "session.new-worktree",
    title: "New session in a worktree…",
    group: "Sessions",
    keywords: ["start", "create", "branch", "git", "checkout"],
    when: (state) => {
      if (isFirstRun(state)) return false;
      const id = currentSessionId(state);
      // A project known not to be a git repository has no worktrees.
      if (id !== null && state.workspaces[id] && state.workspaces[id].git === null) {
        return "This project is not a git repository";
      }
      return true;
    },
    run: (context) => {
      const projectDir = currentProject(context.state);
      toSessions(context);
      context.palette.whenClosed(() =>
        run(
          context.actions.newSession(
            projectDir === null ? { ask: "worktree" } : { projectDir, ask: "worktree" },
          ),
        ),
      );
    },
  },
  {
    id: "session.new-in-folder",
    title: "New session in the project folder",
    group: "Sessions",
    keywords: ["start", "create", "without a worktree", "no worktree"],
    when: afterFirstRun,
    run: (context) => {
      const projectDir = currentProject(context.state);
      toSessions(context);
      context.palette.whenClosed(() =>
        run(
          context.actions.newSession(
            projectDir === null ? { worktree: false } : { projectDir, worktree: false },
          ),
        ),
      );
    },
  },
  {
    id: "session.next",
    title: "Next session",
    group: "Sessions",
    keywords: ["switch", "go to", "down"],
    shortcut: inWindow(SHORTCUTS.nextSession),
    ...stepSession(1),
  },
  {
    id: "session.previous",
    title: "Previous session",
    group: "Sessions",
    keywords: ["switch", "go to", "up"],
    shortcut: inWindow(SHORTCUTS.previousSession),
    ...stepSession(-1),
  },
  {
    id: "sessions.search",
    title: "Search sessions",
    group: "Sessions",
    keywords: ["find", "filter", "sidebar"],
    shortcut: inWindow(SHORTCUTS.searchSessions),
    when: afterFirstRun,
    run: (context) => {
      toSessions(context);
      if (!context.state.layout.sidebarOpen) context.actions.setSidebarOpen(true);
      context.palette.whenClosed(() => focusSoon(focusSidebarSearch));
    },
  },
  {
    id: "sidebar.clear-search",
    title: "Clear the search",
    group: "Sessions",
    shortcut: handledIn("sidebar-search", key("Escape")),
  },
  {
    id: "sidebar.rename-save",
    title: "Save the new title",
    group: "Sessions",
    shortcut: handledIn("rename", key("Enter")),
  },
  {
    id: "sidebar.rename-cancel",
    title: "Cancel renaming",
    group: "Sessions",
    shortcut: handledIn("rename", key("Escape")),
  },
];

const THIS_SESSION: Command[] = [
  {
    id: "session.stop",
    title: "Stop the running turn",
    group: "This session",
    keywords: ["interrupt", "cancel", "halt", "esc"],
    shortcut: inWindow(SHORTCUTS.stop),
    when: (state) => forSession(state, (id) => isWorkingIn(state, id) || "Nothing is running"),
    run: onSession((id, { actions }) => run(actions.interrupt(id))),
  },
  {
    id: "session.send-held",
    title: "Send the held message now",
    group: "This session",
    keywords: ["queued", "queue", "waiting"],
    when: (state) =>
      forSession(state, (id) => heldMessage(state, id) !== null || "No message is held"),
    run: onSession((id, { state, actions }) => {
      const message = heldMessage(state, id);
      if (message) run(actions.sendQueuedNow(id, message.id));
    }),
  },
  {
    id: "session.compact",
    title: "Compact the conversation",
    group: "This session",
    keywords: ["/compact", "context", "summarise", "summarize", "free"],
    when: (state) =>
      forSession(
        state,
        (id) => !(selectComposer(state, id)?.context?.compacting ?? false) || "Already compacting",
      ),
    run: onSession((id, { actions }) => run(actions.compact(id))),
  },
  {
    id: "session.rename",
    title: "Rename the session…",
    group: "This session",
    keywords: ["title"],
    when: (state) => forSession(state),
    run: onSession((id, { palette }) => palette.rename(id)),
  },
  {
    id: "session.fork",
    title: "Fork the session",
    group: "This session",
    keywords: ["copy", "duplicate", "branch"],
    when: (state) => forSession(state),
    run: onSession((id, { actions }) => run(actions.forkSession(id))),
  },
  {
    id: "session.mark-unread",
    title: "Mark the session as unread",
    group: "This session",
    keywords: ["unread", "later"],
    when: (state) => forSession(state),
    run: onSession((id, { actions }) => actions.markUnread(id)),
  },
  {
    id: "session.archive",
    title: "Archive the session",
    group: "This session",
    keywords: ["hide", "done", "close"],
    when: (state) => forSession(state),
    run: onSession((id, { actions }) => run(actions.archiveSession(id))),
  },
  {
    id: "session.delete",
    title: "Delete the session…",
    group: "This session",
    keywords: ["remove", "trash"],
    when: (state) => forSession(state),
    run: onSession((id, { palette }) => palette.confirmDelete(id)),
  },
];

const COMPOSER: Command[] = [
  {
    id: "composer.focus",
    title: "Go to the message field",
    group: "Composer",
    keywords: ["composer", "type", "write", "prompt"],
    when: (state) => forSession(state),
    run: (context) => context.palette.whenClosed(() => focusSoon(focusComposer)),
  },
  {
    id: "composer.send",
    title: "Send the message",
    group: "Composer",
    shortcut: handledIn("composer", key("Enter")),
  },
  {
    id: "composer.new-line",
    title: "Start a new line",
    group: "Composer",
    shortcut: handledIn("composer", key("Enter", { shift: true })),
  },
  {
    id: "mode.cycle",
    title: "Cycle the permission mode",
    group: "Composer",
    keywords: ["mode", "permission", "next mode", "shift tab"],
    shortcut: handledIn("composer", key("Tab", { shift: true })),
    when: (state) => forSession(state),
    run: onSession((id, { actions }) => run(actions.cycleMode(id))),
  },
  ...MODE_ORDER.map(
    (mode): Command => ({
      id: `mode.${mode}`,
      title: `Permission mode: ${MODE_INFO[mode].label}`,
      group: "Composer",
      keywords: ["mode", "permission", MODE_INFO[mode].description],
      checked: (state) => {
        const id = currentSessionId(state);
        return id !== null && selectComposer(state, id)?.mode === mode;
      },
      when: (state) => forSession(state),
      run: onSession((id, { actions }) => run(actions.setMode(id, mode))),
    }),
  ),
  {
    id: "composer.commands",
    title: "Show the commands",
    group: "Composer",
    keywords: ["slash"],
    shortcut: handledIn("composer", key("/")),
  },
  {
    id: "composer.mention",
    title: "Mention a file",
    group: "Composer",
    shortcut: handledIn("composer", key("@")),
  },
  {
    id: "composer.paste",
    title: "Paste an image",
    group: "Composer",
    shortcut: handledIn("composer", key("v", { mod: true })),
  },
  {
    id: "composer-menu.move",
    title: "Move through the menu",
    group: "Composer",
    shortcut: handledIn("composer-menu", key("ArrowUp"), key("ArrowDown")),
  },
  {
    id: "composer-menu.choose",
    title: "Run the command, or mention the file",
    group: "Composer",
    shortcut: handledIn("composer-menu", key("Enter")),
  },
  {
    id: "composer-menu.complete",
    title: "Complete the command, or open the folder",
    group: "Composer",
    shortcut: handledIn("composer-menu", key("Tab")),
  },
  {
    id: "composer-menu.close",
    title: "Close the menu",
    group: "Composer",
    shortcut: handledIn("composer-menu", key("Escape")),
  },
];

const DECISION_CARDS: Command[] = [
  {
    id: "card.primary",
    title: "Allow once, approve, or send the answer",
    group: "Decision cards",
    shortcut: handledIn("card", key("Enter")),
  },
  {
    id: "card.secondary",
    title: "Always allow, approve and accept edits, or send your note",
    group: "Decision cards",
    shortcut: handledIn("card", key("Enter", { mod: true })),
  },
  {
    id: "card.escape",
    title: "Deny, keep planning, dismiss, or go back",
    group: "Decision cards",
    shortcut: handledIn("card", key("Escape")),
  },
  {
    id: "card.option",
    title: "Choose an option",
    group: "Decision cards",
    shortcut: handledIn("question", key("1–9")),
  },
];

const PANE_SHORTCUTS: Readonly<Record<Pane, Shortcut>> = {
  changes: SHORTCUTS.changesPane,
  files: SHORTCUTS.filesPane,
  terminal: SHORTCUTS.terminalPane,
  plan: SHORTCUTS.planPane,
  tasks: SHORTCUTS.tasksPane,
};

const PANE_COMMANDS: Command[] = [
  ...PANES.map(
    (pane): Command => ({
      id: `pane.${pane.id}`,
      title: `Show the ${pane.label} pane`,
      group: "Panes",
      keywords: ["open", "dock", "side pane"],
      shortcut: inWindow(PANE_SHORTCUTS[pane.id]),
      when: (state) => forSession(state),
      run: (context) => context.actions.openPane(pane.id),
    }),
  ),
  {
    id: "panes.toggle",
    title: "Show or hide the panes",
    group: "Panes",
    keywords: ["dock", "side panes", "close", "toggle"],
    shortcut: inWindow(SHORTCUTS.togglePanes),
    when: (state) => forSession(state),
    run: ({ state, actions }) => {
      if (state.layout.dockOpen) actions.closeDock();
      else actions.openPane(state.layout.dockPane);
    },
  },
  {
    id: "terminal.new",
    title: "New terminal",
    group: "Panes",
    keywords: ["shell", "console", "command line"],
    when: (state) => forSession(state),
    run: onSession((id, context) => {
      context.actions.openPane("terminal");
      // The pane starts the shell and focuses it, once the palette has handed focus back.
      context.palette.whenClosed(() => requestNewTerminal(id));
    }),
  },
  {
    id: "pane-tabs.move",
    title: "Move between the panes",
    group: "Panes",
    shortcut: handledIn("pane-tabs", key("ArrowLeft"), key("ArrowRight")),
  },
  {
    id: "changes.move",
    title: "Move through the changed files",
    group: "Panes",
    shortcut: handledIn("changes", key("ArrowUp"), key("ArrowDown"), key("Home"), key("End")),
  },
  {
    id: "comment.add",
    title: "Add the comment",
    group: "Panes",
    shortcut: handledIn("comment", key("Enter", { mod: true })),
  },
  {
    id: "comment.cancel",
    title: "Cancel the comment",
    group: "Panes",
    shortcut: handledIn("comment", key("Escape")),
  },
  {
    id: "file-tree.move",
    title: "Move through the files",
    group: "Panes",
    shortcut: handledIn("file-tree", key("ArrowUp"), key("ArrowDown"), key("Home"), key("End")),
  },
  {
    id: "file-tree.fold",
    title: "Open or close a folder",
    group: "Panes",
    shortcut: handledIn("file-tree", key("ArrowRight"), key("ArrowLeft")),
  },
  {
    id: "file-tree.open",
    title: "Open the file or folder",
    group: "Panes",
    shortcut: handledIn("file-tree", key("Enter"), key(" ")),
  },
  {
    id: "files.save",
    title: "Save the file",
    group: "Panes",
    shortcut: handledIn("files", key("s", { mod: true })),
  },
  {
    id: "terminal.copy",
    title: "Copy the selection",
    group: "Panes",
    shortcut: handledIn("terminal", key("c", { mod: true })),
  },
  {
    id: "terminal.paste",
    title: "Paste",
    group: "Panes",
    shortcut: handledIn("terminal", key("v", { mod: true })),
  },
  {
    id: "terminal.escape",
    title: "Send Esc to the shell, not to dawg",
    group: "Panes",
    shortcut: handledIn("terminal", key("Escape")),
  },
];

const APPEARANCES: readonly { value: Appearance; label: string; keywords: string[] }[] = [
  { value: "dark", label: "Dark", keywords: ["theme", "night", "moon"] },
  { value: "light", label: "Light", keywords: ["theme", "day", "sun"] },
  { value: "system", label: "Match macOS", keywords: ["theme", "system", "automatic"] },
];

const TOOL_CALL_DISPLAYS: readonly { value: ToolCallDisplay; label: string }[] = [
  { value: "smart", label: "Open what needs a look" },
  { value: "closed", label: "All closed" },
  { value: "open", label: "All open" },
];

const VIEW: Command[] = [
  // F6 is installed by ui/regions.ts, ahead of the terminal and the editor, which would take it.
  {
    id: "regions.next",
    title: "Move to the next part of the window",
    group: "View",
    keywords: ["focus", "sidebar", "panes", "message field", "f6"],
    shortcut: handledIn("regions", key("F6")),
  },
  {
    id: "regions.previous",
    title: "Move to the previous part of the window",
    group: "View",
    keywords: ["focus", "sidebar", "panes", "message field", "f6"],
    shortcut: handledIn("regions", key("F6", { shift: true })),
  },
  {
    id: "sidebar.toggle",
    title: "Show or hide the sidebar",
    group: "View",
    keywords: ["sessions", "toggle", "collapse"],
    shortcut: inWindow(SHORTCUTS.toggleSidebar),
    when: (state) => !isFirstRun(state) && state.layout.view === "sessions",
    run: ({ state, actions }) => actions.setSidebarOpen(!state.layout.sidebarOpen),
  },
  {
    id: "appearance.toggle",
    title: "Switch between dark and light",
    group: "View",
    keywords: ["appearance", "theme", "moon", "sun"],
    run: ({ state, actions }) =>
      run(actions.setAppearance(state.resolvedTheme === "dark" ? "light" : "dark")),
  },
  ...APPEARANCES.map(
    (appearance): Command => ({
      id: `appearance.${appearance.value}`,
      title: `Appearance: ${appearance.label}`,
      group: "View",
      keywords: appearance.keywords,
      checked: (state) => state.settings.appearance === appearance.value,
      run: ({ actions }) => run(actions.setAppearance(appearance.value)),
    }),
  ),
  ...TOOL_CALL_DISPLAYS.map(
    (display): Command => ({
      id: `tool-calls.${display.value}`,
      title: `Tool calls: ${display.label}`,
      group: "View",
      keywords: ["transcript", "expand", "collapse", "open", "closed"],
      checked: (state) => state.settings.toolCalls === display.value,
      run: ({ actions }) => run(actions.setToolCallDisplay(display.value)),
    }),
  ),
  {
    id: "resize.step",
    title: "Resize the sidebar or the panes",
    group: "View",
    shortcut: handledIn("resize", key("ArrowLeft"), key("ArrowRight")),
  },
  {
    id: "resize.limits",
    title: "Make them as narrow or as wide as they go",
    group: "View",
    shortcut: handledIn("resize", key("Home"), key("End")),
  },
];

const PALETTE: Command[] = [
  {
    id: "palette.toggle",
    title: "Show the command palette",
    group: "Command palette",
    keywords: ["actions", "commands", "everything"],
    shortcut: inWindow(SHORTCUTS.palette),
    run: ({ palette }) => palette.toggle(),
  },
  {
    id: "palette.run",
    title: "Run the action or open the session",
    group: "Command palette",
    shortcut: handledIn("palette", key("Enter")),
  },
  {
    id: "palette.move",
    title: "Move through the list",
    group: "Command palette",
    shortcut: handledIn("palette", key("ArrowUp"), key("ArrowDown")),
  },
  {
    id: "palette.ends",
    title: "Go to the first or last row",
    group: "Command palette",
    shortcut: handledIn("palette", key("Home"), key("End")),
  },
  {
    id: "palette.page",
    title: "Move a page up or down",
    group: "Command palette",
    shortcut: handledIn("palette", key("PageUp"), key("PageDown")),
  },
  {
    id: "palette.close",
    title: "Close the palette",
    group: "Command palette",
    shortcut: handledIn("palette", key("Escape")),
  },
];

const SETTINGS: Command[] = [
  {
    id: "settings.open",
    title: "Open Settings",
    group: "Settings",
    keywords: ["preferences", "options"],
    shortcut: inWindow(SHORTCUTS.settings),
    run: ({ actions }) => actions.setView("settings"),
  },
  {
    id: "settings.general",
    title: "Settings: General",
    group: "Settings",
    keywords: ["appearance", "tool calls", "notifications", "worktree", "preferences"],
    run: openSettings("general"),
  },
  {
    id: "settings.models",
    title: "Settings: Models",
    group: "Settings",
    keywords: ["manage models", "download", "servers", "memory", "preferences"],
    run: openSettings("models"),
  },
  {
    id: "settings.permissions",
    title: "Settings: Permissions",
    group: "Settings",
    keywords: ["rules", "allow", "ask", "deny", "default mode", "preferences"],
    run: openSettings("permissions"),
  },
  {
    id: "settings.shortcuts",
    title: "Settings: Shortcuts",
    group: "Settings",
    keywords: ["keyboard", "keys", "keymap", "preferences"],
    run: openSettings("shortcuts"),
  },
  {
    id: "settings.back",
    title: "Back to sessions",
    group: "Settings",
    keywords: ["close settings", "leave"],
    // Settings handles Esc itself (SettingsView), so a text field keeps Esc for its own use.
    shortcut: handledIn("settings", key("Escape")),
    when: (state) => state.layout.view === "settings",
    run: ({ actions }) => actions.setView("sessions"),
  },
];

const MODELS: Command[] = [
  {
    id: "models.add-file",
    title: "Add a model file…",
    group: "Models",
    keywords: ["gguf", "import", "local"],
    when: afterFirstRun,
    run: (context) => {
      openSettings("models")(context);
      // The native file picker.
      context.palette.whenClosed(() => run(context.actions.addModelFile()));
    },
  },
  {
    id: "models.stop",
    title: "Stop the model",
    group: "Models",
    keywords: ["unload", "free memory"],
    when: (state) => {
      if (isFirstRun(state)) return false;
      const status = state.modelStatus?.state;
      return status === "ready" || status === "loading" || "No model is running";
    },
    run: ({ actions }) => run(actions.stopModel()),
  },
  {
    id: "models.start-default",
    title: "Start the default model",
    group: "Models",
    keywords: ["load", "run"],
    when: (state) => {
      if (isFirstRun(state)) return false;
      if (!state.modelsState?.defaultModelId) return "There is no default model";
      const status = state.modelStatus?.state;
      return !(status === "ready" || status === "loading") || "A model is running";
    },
    run: ({ state, actions }) => {
      const id = state.modelsState?.defaultModelId;
      if (id) run(actions.startModel(id));
    },
  },
  {
    id: "models.refresh-servers",
    title: "Check the servers again",
    group: "Models",
    keywords: ["refresh", "ollama", "lm studio", "remote"],
    when: (state) =>
      !isFirstRun(state) && ((state.modelsState?.servers.length ?? 0) > 0 || "No servers added"),
    run: ({ actions }) => run(actions.refreshServers()),
  },
];

const HELP: Command[] = [
  {
    id: "help.shortcuts",
    title: "Keyboard shortcuts",
    group: "Help",
    keywords: ["keys", "keymap", "help", "cheat sheet"],
    shortcut: inWindow(SHORTCUTS.keyboardShortcuts),
    run: openSettings("shortcuts"),
  },
  {
    id: "help.github",
    title: "Open dawg-code on GitHub",
    group: "Help",
    keywords: ["website", "source", "repository", "issues", "report a problem"],
    run: ({ actions }) => run(actions.openExternal(PROJECT_URL)),
  },
];

/** Every action with a fixed title, in palette and keymap order. */
export const COMMANDS: readonly Command[] = [
  ...SESSIONS,
  ...THIS_SESSION,
  ...COMPOSER,
  ...DECISION_CARDS,
  ...PANE_COMMANDS,
  ...VIEW,
  ...PALETTE,
  ...SETTINGS,
  ...MODELS,
  ...HELP,
];

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

export function commandById(id: string): Command | undefined {
  return BY_ID.get(id);
}

/** The "window" shortcuts, which `useGlobalShortcuts` runs. */
export const WINDOW_COMMANDS: readonly Command[] = COMMANDS.filter(
  (command) => command.run !== undefined && command.shortcut?.scope === "window",
);

// ---------------------------------------------------------------------------------------------
// Actions that depend on the state: projects, models, effort levels
// ---------------------------------------------------------------------------------------------

/** "New session in tally" for each known project. */
function projectCommands(state: AppStore): Command[] {
  if (isFirstRun(state)) return [];
  return Object.values(state.projects)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((project) => ({
      id: `session.new-in:${project.dir}`,
      title: `New session in ${project.name}`,
      group: "Sessions",
      keywords: ["start", "create", "project", shortenPath(project.dir, state.homeDir)],
      run: (context) => {
        toSessions(context);
        context.palette.whenClosed(() =>
          run(context.actions.newSession({ projectDir: project.dir })),
        );
      },
    }));
}

/** "Model: …" for each model that can run, for the session the window shows. */
function modelCommands(state: AppStore): Command[] {
  const id = currentSessionId(state);
  if (id === null) return [];
  const current = selectComposer(state, id)?.model.id ?? null;
  return state.models.map((model) => ({
    id: `model:${model.id}`,
    title: `Model: ${model.label}`,
    group: "Composer",
    keywords: ["model", "switch model", model.shortLabel, model.description],
    checked: () => model.id === current,
    run: onSession((session, { actions }) => run(actions.setModel(session, model.id))),
  }));
}

/** "Effort: high" for each level the session's model reports, and its default. */
function effortCommands(state: AppStore): Command[] {
  const id = currentSessionId(state);
  const effort = id === null ? null : (selectComposer(state, id)?.effort ?? null);
  if (!effort || effort.levels.length === 0) return [];
  const levels: (string | null)[] = [null, ...effort.levels];
  return levels.map((level) => ({
    id: `effort:${level ?? "default"}`,
    title: `Effort: ${level ?? "model default"}`,
    group: "Composer",
    keywords: ["effort", "reasoning", "thinking", ...(level ? [EFFORT_INFO[level] ?? ""] : [])],
    checked: () => effort.value === level,
    run: onSession((session, { actions }) => run(actions.setEffort(session, level))),
  }));
}

/** "Default model: …" for each model that can run. */
function defaultModelCommands(state: AppStore): Command[] {
  if (isFirstRun(state)) return [];
  const current = state.modelsState?.defaultModelId ?? null;
  return state.models.map((model) => ({
    id: `default-model:${model.id}`,
    title: `Default model: ${model.label}`,
    group: "Models",
    keywords: ["new sessions", model.shortLabel],
    checked: () => model.id === current,
    run: ({ actions }) => run(actions.setDefaultModel(model.id)),
  }));
}

/** Actions whose titles come from the state. None has a shortcut. */
export function dynamicCommands(state: AppStore): Command[] {
  return [
    ...projectCommands(state),
    ...modelCommands(state),
    ...effortCommands(state),
    ...defaultModelCommands(state),
  ];
}

export function availability(command: Command, state: AppStore): Availability {
  return command.when ? command.when(state) : true;
}
