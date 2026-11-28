/**
 * The open body of a call to an MCP server's tool, made by its own name (`mcp__server__tool`) or
 * through `CallMcpTool`: which server and tool, the arguments, and the result as the engine
 * reported it (`McpDisplay` in @dawg/protocol), with where a result too long for the conversation
 * was saved.
 */
import type { McpDisplay } from "@dawg/protocol";
import { useMemo } from "react";
import { displayPath } from "../lib/format.ts";
import { mcpArguments, mcpCallOf } from "../lib/tools.ts";
import type { ToolCallItem } from "../state/types.ts";
import type { TranscriptEnv } from "./env.ts";
import { OutputLines } from "./OutputLines.tsx";
import styles from "./ToolCard.module.css";
import { contentText } from "./toolInfo.ts";

export function McpToolBody({ item, env }: { item: ToolCallItem; env: TranscriptEnv }) {
  const display: McpDisplay | null = item.display?.kind === "mcp" ? item.display : null;
  const call = mcpCallOf(item.toolName, item.input, item.display);
  const args = useMemo(() => JSON.stringify(mcpArguments(item), null, 2), [item]);
  const text = display?.text ?? contentText(item.content);
  const failed = item.state !== "success" && item.state !== "running";
  return (
    <>
      {call !== null && (
        <div className={styles.footer}>
          <span>
            The <strong>{call.tool}</strong> tool of the <strong>{call.server}</strong> MCP server
          </span>
        </div>
      )}
      <div className={styles.section}>Arguments</div>
      <OutputLines text={args} label="Arguments" className={`${styles.output} ${styles.wrap}`} />
      <div className={styles.section}>Result</div>
      {item.state === "running" ? (
        <div className={styles.placeholder}>{item.statusLine ?? "Waiting for the server…"}</div>
      ) : text.trim() === "" ? (
        <div className={styles.placeholder}>{failed ? "No details." : "No result."}</div>
      ) : (
        <OutputLines
          text={text}
          label="Result"
          focusable
          className={`${styles.output} ${styles.wrap}${failed || display?.isError ? ` ${styles.errorText}` : ""}`}
        />
      )}
      {display !== null && (display.images > 0 || display.savedTo !== null) && (
        <div className={styles.footer}>
          {display.images > 0 && (
            <span>{display.images === 1 ? "1 image" : `${display.images} images`}</span>
          )}
          {display.savedTo !== null && (
            <span>
              The whole result ({display.chars.toLocaleString("en-US")} characters) is in{" "}
              <span className={styles.footerPath}>
                {displayPath(display.savedTo, env.cwd, env.homeDir)}
              </span>
            </span>
          )}
        </div>
      )}
    </>
  );
}
