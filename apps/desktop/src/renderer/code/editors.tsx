/**
 * The code views the Changes and Files panes share: an editor for one file and a diff of one
 * file, both Monaco, loaded on first use. This module is the seam tests replace (Monaco does not
 * run in jsdom): the panes only see the props in `types.ts`.
 */

import type { editor, IDisposable } from "monaco-editor/editor/editor.api.js";
import { type RefObject, useEffect, useRef } from "react";
import styles from "./code.module.css";
import type { DocumentBinding, TextDocument } from "./documents.ts";
import { type Monaco, type MonacoState, prefersReducedMotion, useMonaco } from "./monaco.ts";
import { documentTokens } from "./theme.ts";
import type { CodeEditorProps, DiffEditorProps, DiffSide, LineRange } from "./types.ts";

/** Monaco models behind documents, so an editor shown again reuses its model and undo history. */
const models = new WeakMap<DocumentBinding, editor.ITextModel>();
/** Cursor and scroll position per document, kept while its editor is hidden. */
const viewStates = new Map<string, editor.ICodeEditorViewState>();
let nextModelId = 1;

function uriFor(monaco: Monaco, path: string) {
  // Unique per model (the same file can be open in several places); the path names the language.
  return monaco.Uri.from({ scheme: "dawg", authority: `m${nextModelId++}`, path });
}

/** Options both views share: the app's mono type, no minimap, quiet suggestions. */
function baseOptions(): editor.IEditorOptions {
  const reduced = prefersReducedMotion();
  return {
    automaticLayout: true,
    fixedOverflowWidgets: true,
    fontFamily: documentTokens()("--mono") || "ui-monospace, Menlo, monospace",
    fontSize: 12,
    lineHeight: 19,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    padding: { top: 6, bottom: 6 },
    smoothScrolling: !reduced,
    cursorBlinking: reduced ? "solid" : "smooth",
    cursorSmoothCaretAnimation: "off",
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    stickyScroll: { enabled: false },
    accessibilitySupport: "auto",
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    overviewRulerBorder: false,
  };
}

/**
 * Esc that Monaco did not use (to close its find box, say) stays in the editor, so it does not
 * reach the window, where Esc stops dawg.
 */
function useKeepEscape(host: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const keep = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.stopPropagation();
    };
    element.addEventListener("keydown", keep);
    return () => element.removeEventListener("keydown", keep);
  }, [host]);
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function Placeholder({ state }: { state: MonacoState }) {
  if (state.status === "ready") return null;
  return (
    <div className={styles.placeholder} role="status">
      {state.status === "loading"
        ? "Loading the editor…"
        : `The editor could not load: ${state.message}`}
    </div>
  );
}

function bindModel(monaco: Monaco, document: TextDocument): editor.ITextModel {
  const binding = document.bind((text) => {
    const model = monaco.editor.createModel(text, undefined, uriFor(monaco, document.path));
    const listener = model.onDidChangeContent(() => document.changed());
    const created: DocumentBinding = {
      getText: () => model.getValue(),
      setText: (next) => {
        // An edit rather than setValue, so a reload can be undone like any other change.
        model.pushStackElement();
        model.pushEditOperations(
          [],
          [{ range: model.getFullModelRange(), text: next }],
          () => null,
        );
        model.pushStackElement();
      },
      version: () => model.getAlternativeVersionId(),
      dispose: () => {
        listener.dispose();
        model.dispose();
      },
    };
    models.set(created, model);
    return created;
  });
  const model = models.get(binding);
  if (!model) throw new Error("The document is bound to another editor.");
  return model;
}

/** One file, editable unless `readOnly`. ⌘S calls `onSave`. */
export function CodeEditor(props: CodeEditorProps) {
  const state = useMonaco();
  const host = useRef<HTMLDivElement>(null);
  useKeepEscape(host);
  const view = useRef<editor.IStandaloneCodeEditor | null>(null);
  const onSave = useLatest(props.onSave);
  const { document } = props;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the label and read-only flag are applied below without recreating the editor
  useEffect(() => {
    const element = host.current;
    if (state.status !== "ready" || !element || document.disposed) return;
    const { monaco } = state;
    const model = bindModel(monaco, document);
    const created = monaco.editor.create(element, {
      ...baseOptions(),
      model,
      ariaLabel: props.label,
      readOnly: props.readOnly ?? false,
    });
    created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave.current?.());
    const saved = viewStates.get(document.key);
    if (saved) created.restoreViewState(saved);
    view.current = created;
    return () => {
      const viewState = created.saveViewState();
      if (viewState) viewStates.set(document.key, viewState);
      view.current = null;
      created.dispose();
    };
  }, [state, document]);

  useEffect(() => {
    view.current?.updateOptions({ ariaLabel: props.label, readOnly: props.readOnly ?? false });
  }, [props.label, props.readOnly]);

  return (
    <div className={styles.host} ref={host}>
      <Placeholder state={state} />
    </div>
  );
}

/** Whole lines a selection covers; a selection ending at the start of a line leaves it out. */
function linesOf(selection: {
  startLineNumber: number;
  endLineNumber: number;
  endColumn: number;
}): [number, number] {
  let end = selection.endLineNumber;
  if (end > selection.startLineNumber && selection.endColumn === 1) end--;
  return [selection.startLineNumber, end];
}

/** A file's base version beside (or above, inline) its working-tree version. Read-only. */
export function DiffEditor(props: DiffEditorProps) {
  const state = useMonaco();
  const host = useRef<HTMLDivElement>(null);
  useKeepEscape(host);
  const diff = useRef<editor.IStandaloneDiffEditor | null>(null);
  const callbacks = useLatest({
    onSelectLines: props.onSelectLines,
    onCommentRequest: props.onCommentRequest,
  });
  const markDecorations = useRef<Record<DiffSide, editor.IEditorDecorationsCollection | null>>({
    original: null,
    modified: null,
  });

  // The editor itself, once per mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: options that change later are applied below without recreating the editor
  useEffect(() => {
    const element = host.current;
    if (state.status !== "ready" || !element) return;
    const { monaco } = state;
    const created = monaco.editor.createDiffEditor(element, {
      ...baseOptions(),
      readOnly: true,
      originalEditable: false,
      renderSideBySide: !props.inline,
      useInlineViewWhenSpaceIsLimited: false,
      enableSplitViewResizing: true,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      renderIndicators: true,
      ignoreTrimWhitespace: false,
      diffAlgorithm: "advanced",
      maxComputationTime: 5000,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
      glyphMargin: true,
      folding: false,
      // Tab leaves the read-only view, so the keyboard reaches the pane's buttons.
      tabFocusMode: true,
      ariaLabel: props.label,
    });
    diff.current = created;

    const disposables: IDisposable[] = [];
    const sides: [DiffSide, editor.ICodeEditor][] = [
      ["original", created.getOriginalEditor()],
      ["modified", created.getModifiedEditor()],
    ];
    for (const [side, sideEditor] of sides) {
      markDecorations.current[side] = sideEditor.createDecorationsCollection();
      const hover = sideEditor.createDecorationsCollection();
      const report = () => {
        const selection = sideEditor.getSelection();
        if (!selection || !sideEditor.hasWidgetFocus()) return;
        const [startLine, endLine] = linesOf(selection);
        callbacks.current.onSelectLines({ side, startLine, endLine });
      };
      disposables.push(
        sideEditor.onDidChangeCursorSelection(report),
        sideEditor.onDidFocusEditorWidget(report),
        sideEditor.onMouseMove((event) => {
          const line = event.target.position?.lineNumber;
          const overLine =
            line !== undefined &&
            event.target.type !== monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE &&
            event.target.type !== monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE;
          hover.set(
            overLine
              ? [
                  {
                    range: new monaco.Range(line, 1, line, 1),
                    options: {
                      glyphMarginClassName: styles.addGlyph,
                      glyphMarginHoverMessage: { value: "Comment on this line" },
                    },
                  },
                ]
              : [],
          );
        }),
        sideEditor.onMouseLeave(() => hover.clear()),
        sideEditor.onMouseDown((event) => {
          if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
          const line = event.target.position?.lineNumber;
          if (line === undefined) return;
          event.event.preventDefault();
          const selection = sideEditor.getSelection();
          const [start, end] = selection ? linesOf(selection) : [line, line];
          const inside = selection && !selection.isEmpty() && line >= start && line <= end;
          const range: LineRange = inside
            ? { side, startLine: start, endLine: end }
            : { side, startLine: line, endLine: line };
          callbacks.current.onCommentRequest(range);
        }),
      );
    }
    return () => {
      for (const disposable of disposables) disposable.dispose();
      const model = created.getModel();
      created.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      diff.current = null;
      markDecorations.current = { original: null, modified: null };
    };
  }, [state]);

  // The two versions.
  useEffect(() => {
    const created = diff.current;
    if (state.status !== "ready" || !created) return;
    const { monaco } = state;
    const previous = created.getModel();
    created.setModel({
      original: monaco.editor.createModel(props.original, undefined, uriFor(monaco, props.path)),
      modified: monaco.editor.createModel(props.modified, undefined, uriFor(monaco, props.path)),
    });
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [state, props.path, props.original, props.modified]);

  useEffect(() => {
    diff.current?.updateOptions({ renderSideBySide: !props.inline });
  }, [props.inline]);

  useEffect(() => {
    const created = diff.current;
    if (!created) return;
    created.getOriginalEditor().updateOptions({ ariaLabel: `${props.label}, before` });
    created.getModifiedEditor().updateOptions({ ariaLabel: props.label });
  }, [props.label]);

  // Comment marks, set again on new versions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new versions need the marks again
  useEffect(() => {
    if (state.status !== "ready") return;
    const { monaco } = state;
    for (const side of ["original", "modified"] as const) {
      const collection = markDecorations.current[side];
      if (!collection) continue;
      collection.set(
        props.marks
          .filter((mark) => mark.side === side)
          .map((mark) => ({
            range: new monaco.Range(mark.startLine, 1, mark.endLine, 1),
            options: {
              isWholeLine: true,
              className: styles.commentedLine,
              glyphMarginClassName: styles.commentGlyph,
              glyphMarginHoverMessage: { value: mark.text },
            },
          })),
      );
    }
  }, [state, props.marks, props.original, props.modified]);

  // Bring a line into view, without taking focus from the button that asked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request (or the editor arriving) moves the view
  useEffect(() => {
    const created = diff.current;
    const reveal = props.reveal;
    if (!created || !reveal) return;
    const sideEditor =
      reveal.side === "original" ? created.getOriginalEditor() : created.getModifiedEditor();
    sideEditor.revealLineInCenterIfOutsideViewport(reveal.line);
    sideEditor.setPosition({ lineNumber: reveal.line, column: 1 });
  }, [state, props.reveal]);

  return (
    <div className={styles.host} ref={host}>
      <Placeholder state={state} />
    </div>
  );
}
