/**
 * Test helpers for the Changes and Files panes (imported by tests only).
 *
 * Monaco does not run in jsdom, so pane tests replace the code views with the stand-ins below:
 *
 *   vi.mock("../../code/editors.tsx", async () => (await import("../../code/testing.tsx")).editorStandIns);
 *
 * The editor stand-in is a textarea bound to the document; the diff stand-in shows both versions
 * and has buttons that act as a person selecting lines or pressing the "+" beside one.
 */
import type { DiffHunk, SessionId } from "@dawg/protocol";
import { useSyncExternalStore } from "react";
import { emptyInternals } from "../state/internals.ts";
import type { SessionView, ToolCallItem } from "../state/types.ts";
import type { CodeEditorProps, DiffEditorProps } from "./types.ts";

function CodeEditorStandIn(props: CodeEditorProps) {
  const { document } = props;
  const text = useSyncExternalStore(
    (listener) => document.subscribe(listener),
    () => document.getText(),
  );
  return (
    <textarea
      aria-label={props.label}
      value={text}
      readOnly={props.readOnly}
      onChange={(event) => document.setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.metaKey && event.key === "s") {
          event.preventDefault();
          // The real editor handles ⌘S itself; the pane's handler must not save twice.
          event.stopPropagation();
          props.onSave?.();
        }
      }}
    />
  );
}

function DiffEditorStandIn(props: DiffEditorProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a test stand-in for Monaco's region
    <div role="region" aria-label={props.label} data-inline={props.inline ? "true" : "false"}>
      <pre data-testid="original">{props.original}</pre>
      <pre data-testid="modified">{props.modified}</pre>
      <p data-testid="marks">
        {props.marks.map((mark) => `${mark.side}:${mark.startLine}-${mark.endLine}`).join(" ")}
      </p>
      <p data-testid="reveal">
        {props.reveal ? `${props.reveal.side}:${props.reveal.line}` : "none"}
      </p>
      <button
        type="button"
        onClick={() => props.onSelectLines({ side: "modified", startLine: 2, endLine: 3 })}
      >
        Select modified lines 2–3
      </button>
      <button
        type="button"
        onClick={() => props.onCommentRequest({ side: "original", startLine: 1, endLine: 1 })}
      >
        Press + beside original line 1
      </button>
    </div>
  );
}

export const editorStandIns = {
  CodeEditor: CodeEditorStandIn,
  DiffEditor: DiffEditorStandIn,
};

/** A session in the store, with folders. */
export function sessionView(
  id: SessionId,
  cwd: string,
  options: { projectDir?: string; additionalDirectories?: string[] } = {},
): SessionView {
  return {
    id,
    summary: {
      id,
      title: "Fix the split",
      cwd,
      projectDir: options.projectDir ?? cwd,
      createdAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_100_000,
      status: "idle",
      queuePosition: null,
      mode: "default",
      model: "qwen",
      effort: null,
      archived: false,
      forkedFrom: null,
      lastSeq: 0,
    },
    open: true,
    loaded: true,
    status: "idle",
    waitingOn: null,
    statusMessage: null,
    queuePosition: null,
    modelInfo: null,
    additionalDirectories: options.additionalDirectories ?? [],
    tasks: [],
    background: [],
    subagents: [],
    usage: null,
    commands: [],
    activeTurnId: null,
    promptProgress: null,
    compactionId: null,
    lastTurn: null,
    highWaterSeq: 0,
    internals: emptyInternals(),
  } as SessionView;
}

let nextCall = 1;

/** A finished edit in the transcript, as an Edit or Write call shows it. */
export function editItem(
  path: string,
  hunks: DiffHunk[],
  options: { created?: boolean; state?: ToolCallItem["state"] } = {},
): ToolCallItem {
  const id = nextCall++;
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      if (line.startsWith("-")) deletions++;
    }
  }
  return {
    kind: "tool",
    id: `item-${id}`,
    turnId: "t1",
    seq: id,
    toolCallId: `call-${id}`,
    messageId: "m1",
    toolName: options.created ? "Write" : "Edit",
    input: { file_path: path },
    state: options.state ?? "success",
    output: [],
    statusLine: null,
    content: [],
    display: {
      kind: "diff",
      filePath: path,
      created: options.created ?? false,
      hunks,
      additions,
      deletions,
    },
    startedAt: 0,
    durationMs: 10,
    permissionRequestId: null,
  };
}
