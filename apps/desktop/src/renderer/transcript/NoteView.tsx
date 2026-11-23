import { memo } from "react";
import type { NoteItem } from "../state/types.ts";
import { Divider } from "./Divider.tsx";

/** "Interrupted by you · the transcript keeps every finished call", as a divider. */
export const NoteView = memo(function NoteView({ item }: { item: NoteItem }) {
  return <Divider text={item.text} tone={item.tone} />;
});
