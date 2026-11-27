/**
 * The compatibility report with consent applied, for `project.inspect`: an item that would run
 * but waits for the person's approval is listed as "needs-approval", with why. Items dawg does not
 * run anyway (MCP servers this round, unsupported hooks) keep their status; the approval's own
 * list still offers them, so consent given now covers them later.
 */
import type { CodeApproval, CompatItem } from "@dawg/protocol";

const key = (item: Pick<CompatItem, "kind" | "name" | "source">) =>
  `${item.kind}\n${item.source.path}\n${item.name}`;

export function withApproval(
  items: readonly CompatItem[],
  approval: CodeApproval | null,
): CompatItem[] {
  if (approval === null || approval.approved) return [...items];
  const waiting = new Map<string, CompatItem>();
  for (const item of approval.items) {
    if (item.status === "needs-approval") waiting.set(key(item), item);
  }
  return items.map((item) => {
    const pending = waiting.get(key(item));
    if (pending === undefined) return item;
    if (item.status !== "loaded" && item.status !== "partly-supported") return item;
    const why = pending.notes[0];
    return {
      ...item,
      status: "needs-approval",
      notes: [
        why === undefined
          ? "Waits for your approval."
          : `${why.replace(/\.$/, "")}, so it waits for your approval.`,
        ...item.notes,
      ],
    };
  });
}
