/**
 * A rehype plugin that puts the streaming caret at the end of the rendered text: inside the last
 * paragraph, list item or heading, so it sits right after the last word, and after a code block,
 * table or link rather than inside it.
 */
import type { HastRoot } from "./highlight.ts";

type HastNode = HastRoot["children"][number];
type HastElement = Extract<HastNode, { type: "element" }>;
type HastParent = HastRoot | HastElement;

/** Elements the caret goes after, not into. */
const AFTER = new Set(["pre", "code", "table", "hr", "a", "img", "input", "br"]);

function lastMeaningfulChild(parent: HastParent): HastNode | undefined {
  for (let i = parent.children.length - 1; i >= 0; i--) {
    const child = parent.children[i] as HastNode;
    // react-markdown keeps the newlines between blocks as text nodes.
    if (child.type === "text" && child.value.trim() === "") continue;
    return child;
  }
  return undefined;
}

export function rehypeCaret(className: string | undefined) {
  return () => (tree: HastRoot) => {
    const caret: HastElement = {
      type: "element",
      tagName: "span",
      properties: { className: className ? [className] : [], ariaHidden: "true", dataCaret: "" },
      children: [],
    };
    let parent: HastParent = tree;
    for (;;) {
      const last = lastMeaningfulChild(parent);
      if (last === undefined || last.type !== "element" || AFTER.has(last.tagName)) break;
      parent = last;
    }
    parent.children.push(caret);
  };
}
