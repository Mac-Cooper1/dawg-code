/**
 * MCP resources in the composer's `@` menu, beside files: what a session's servers offer
 * (`mcp.session`), matched against what is typed after "@". Choosing one writes
 * `@server:uri`, which the engine reads from the server when the message is sent (Claude Code's
 * `@server:protocol://resource/path`); it is never a file mention.
 */
import type { McpResourceInfo } from "@dawg/protocol";
import type { FileMatch } from "../../shared/bridge.ts";

/** A menu entry for a resource: shaped like a file's, so the menu lists both alike. */
export interface ResourceMatch extends FileMatch {
  resource: McpResourceInfo;
}

export function isResourceMatch(match: FileMatch): match is ResourceMatch {
  return "resource" in match;
}

/** The resources whose mention, name or description holds the query (any case). */
export function resourceMatches(
  resources: readonly McpResourceInfo[],
  query: string,
): ResourceMatch[] {
  const wanted = query.toLowerCase();
  const out: ResourceMatch[] = [];
  for (const resource of resources) {
    const relativePath = resource.mention.slice(1);
    const at = relativePath.toLowerCase().indexOf(wanted);
    const inWords = `${resource.name} ${resource.description}`.toLowerCase().includes(wanted);
    if (wanted !== "" && at < 0 && !inWords) continue;
    out.push({
      path: resource.mention,
      relativePath,
      kind: "file",
      highlights: at < 0 || wanted === "" ? [] : Array.from(wanted, (_, i) => at + i),
      resource,
    });
  }
  return out;
}
