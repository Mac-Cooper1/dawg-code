import { noopAdapter, referenceAdapter } from "./builtin.ts";
import {
  claudeCodeAdapter,
  commandAdapter,
  dawgAdapter,
  opencodeAdapter,
  piAdapter,
} from "./external.ts";
import type { AgentAdapter } from "./types.ts";

export const ADAPTER_IDS = [
  "reference",
  "noop",
  "command",
  "opencode",
  "pi",
  "claude-code",
  "dawg",
] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export interface AdapterOptions {
  /** Command template, required for `command`. */
  agentCmd?: string;
  /** Executable override for opencode / pi / claude-code / dawg. */
  agentBin?: string;
  /** Extra features to claim. */
  features?: readonly string[];
  /** Reasoning effort; only the dawg adapter takes it. */
  effort?: string;
}

export function createAdapter(id: string, opts: AdapterOptions = {}): AgentAdapter {
  if (opts.effort !== undefined && id !== "dawg") {
    throw new Error(
      `--effort is only passed to --agent dawg. For ${id}, set the effort on the model server ` +
        "instead (llama-server: --reasoning-effort <level>), so every agent runs with the same one.",
    );
  }
  const ext = { bin: opts.agentBin, features: opts.features, effort: opts.effort };
  switch (id) {
    case "reference":
      return referenceAdapter();
    case "noop":
      return noopAdapter();
    case "command":
      if (!opts.agentCmd) throw new Error("--agent command needs --agent-cmd '<template>'");
      return commandAdapter(opts.agentCmd, { features: opts.features });
    case "opencode":
      return opencodeAdapter(ext);
    case "pi":
      return piAdapter(ext);
    case "claude-code":
      return claudeCodeAdapter(ext);
    case "dawg":
      return dawgAdapter(ext);
    default:
      throw new Error(`unknown agent "${id}" (known: ${ADAPTER_IDS.join(", ")})`);
  }
}

export * from "./builtin.ts";
export * from "./external.ts";
export * from "./launch.ts";
export * from "./types.ts";
