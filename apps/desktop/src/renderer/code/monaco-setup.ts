/**
 * Monaco, set up once and loaded only when a pane first shows code (see `monaco.ts`), so it never
 * slows the window's start.
 *
 * - Editing features: a curated set (find, folding, multiple cursors, comments, line moves…), and
 *   syntax colouring for every language Monaco knows. No language services: they would report
 *   errors without the project's settings, so files show no squiggles.
 * - One web worker (diffs and word ranges), bundled as its own file and created with `new Worker`
 *   from the page's own origin. The page's Content-Security-Policy allows scripts from 'self'
 *   only, so Monaco's default blob-URL workers would be refused, and nothing here uses eval.
 * - Colours from the design tokens, rebuilt whenever `<html data-theme>` changes.
 */
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/features/bracketMatching/register.js";
import "monaco-editor/features/caretOperations/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/codicon/register.js";
import "monaco-editor/features/comment/register.js";
import "monaco-editor/features/contextmenu/register.js";
import "monaco-editor/features/cursorUndo/register.js";
import "monaco-editor/features/diffEditor/register.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/gotoLine/register.js";
import "monaco-editor/features/indentation/register.js";
import "monaco-editor/features/inPlaceReplace/register.js";
import "monaco-editor/features/lineSelection/register.js";
import "monaco-editor/features/linesOperations/register.js";
import "monaco-editor/features/multicursor/register.js";
import "monaco-editor/features/readOnlyMessage/register.js";
import "monaco-editor/features/smartSelect/register.js";
import "monaco-editor/features/toggleTabFocusMode/register.js";
import "monaco-editor/features/unicodeHighlighter/register.js";
import "monaco-editor/features/wordHighlighter/register.js";
import "monaco-editor/features/wordOperations/register.js";
import "monaco-editor/features/wordPartOperations/register.js";
import "monaco-editor/languages/definitions/register.all.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { documentTokens, MONACO_THEME, themeFromTokens } from "./theme.ts";

globalThis.MonacoEnvironment = {
  getWorker: () => new EditorWorker({ name: "monaco-editor" }),
};

function applyTheme(): void {
  const dark = document.documentElement.dataset.theme !== "light";
  monaco.editor.defineTheme(MONACO_THEME, themeFromTokens(documentTokens(), dark));
  monaco.editor.setTheme(MONACO_THEME);
}

applyTheme();
new MutationObserver(applyTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

export { monaco };
