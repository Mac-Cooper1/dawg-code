/** What a web call's card header says, from its display alone. Pure, so it is tested without rendering. */
import type { WebFetchDisplay, WebSearchDisplay } from "@dawg/protocol";
import { formatBytes } from "../lib/format.ts";

/** The card header's meta for a web call: "14 KB", "14 KB, cached", "moved", "8 results". */
export function webMetaText(display: WebFetchDisplay | WebSearchDisplay): string {
  if (display.kind === "web-search") {
    const n = display.results.length;
    return n === 0
      ? "no results"
      : `${n.toLocaleString("en-US")} ${n === 1 ? "result" : "results"}`;
  }
  if (display.redirectUrl !== null) return "moved to another host";
  return `${formatBytes(display.bytes)}${display.cached ? ", cached" : ""}`;
}
