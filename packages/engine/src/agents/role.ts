/**
 * What makes a session runtime a subagent: the seam between ../runtime/session.ts and this
 * folder. A subagent runs in an ordinary session runtime (its own transcript, events, history
 * and turn loop); the role changes only what differs: its prompt and tools, whose permissions
 * it is judged by, where its questions for the person go, and what happens when it stops.
 */
import type {
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  SubagentLabel,
} from "@dawg/protocol";
import type { PermissionState } from "../contracts/permissions.ts";
import type { PromptPrefix } from "../contracts/prompt.ts";
import type { AnyTool } from "../contracts/tools.ts";

export interface SubagentRole {
  label: SubagentLabel;
  /**
   * The text that takes the place of the core instructions in its system message (the subagent
   * core and its role), or null for a fork, which keeps its parent's.
   */
  systemText: string | null;
  /** A fork's start: its parent's prefix and tools exactly, so its first request reuses the cache. */
  fork: {
    prefix: PromptPrefix;
    tools: readonly AnyTool[];
    toolMap: ReadonlyMap<string, AnyTool>;
  } | null;
  /** The tools it gets, from those a session would offer (ignored for a fork). */
  tools(offered: readonly AnyTool[]): readonly AnyTool[];
  /** The mode its calls are judged in now (the parent's may change while it works). */
  mode(): PermissionMode;
  /** The rules its calls are judged by now: the parent's, with the agent's own grants. */
  rules(): PermissionState["rules"];
  /** Whether anyone can answer its permission prompts (the parent's client). */
  canAskPermission(): boolean;
  /** Raises its permission request in the parent session, labelled with it. */
  askPermission(
    request: PermissionRequest,
    turnId: string,
    signal: AbortSignal,
  ): Promise<PermissionResponse>;
  /** "Allow always" rules, saved and applied for the parent (and so for every agent of it). */
  allowAlways(rules: readonly string[]): Promise<void>;
  /** Model requests per task before it stops, or null for the engine's limit. */
  maxTurns: number | null;
  /**
   * SubagentStop hooks, when it ends a reply without tool calls: the note that keeps it going,
   * or null to let it finish.
   */
  onStop(turn: {
    turnId: string;
    lastText: string | null;
    signal: AbortSignal;
  }): Promise<string | null>;
  /** The owner whose slot its first request prefers (a fork's parent), or null. */
  preferSlotOf: string | null;
  /**
   * Where its file changes are saved for rewinding (../checkpoints): the parent's checkpoint for
   * the turn that started it, marked with it, so rewinding the parent puts its files back too.
   * Absent: its own file history.
   */
  fileChanges?: {
    before(paths: readonly string[]): Promise<void>;
    after(paths: readonly string[]): Promise<void>;
  };
}
