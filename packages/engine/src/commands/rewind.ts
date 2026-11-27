/**
 * `/rewind`: the checkpoints a conversation can go back to (Phase 4 spec, "Checkpoints and
 * rewind"). The app opens its rewind dialog and `dawg` asks which point and what to restore,
 * both through `session.checkpoints` and `session.rewind`; a client without either (a headless
 * run) gets this list.
 */
import { displayPath } from "./memory.ts";
import { CommandError, type SlashCommand } from "./types.ts";

/** Changes made by shell commands are not tracked, as in Claude Code. */
export const SHELL_CAVEAT =
  "Only changes made by dawg's file tools (Write, Edit) are tracked. Changes made by shell commands are not; git shows every change.";

function when(time: number): string {
  return new Date(time).toISOString().replace("T", " ").slice(0, 16);
}

export const rewindCommand: SlashCommand = {
  name: "rewind",
  description: "Go back to an earlier point: restore files, the conversation, or both",
  argumentHint: null,
  async run(ctx) {
    if (ctx.args !== "") throw new CommandError(ctx.name, "/rewind takes no arguments.");
    const s = ctx.session;
    const { checkpoints } = await s.checkpoints();
    if (checkpoints.length === 0) {
      return { kind: "output", text: "Nothing to rewind to yet: no prompts in this conversation." };
    }
    const lines = ["Checkpoints, newest first:"];
    checkpoints
      .slice()
      .reverse()
      .forEach((c, i) => {
        const prompt = c.prompt.replace(/\s+/g, " ").trim();
        const short = prompt.length > 70 ? `${prompt.slice(0, 69)}…` : prompt;
        lines.push(`  ${i + 1}. ${when(c.time)}  ${short === "" ? "(no text)" : short}`);
        for (const file of c.files) {
          const by =
            file.agents.length === 0
              ? ""
              : ` (by ${file.agents.map((a) => `${a.agentId}, ${a.agentType}`).join("; ")})`;
          lines.push(
            `       ${file.change === "created" ? "created" : "changed"} ${displayPath(file.path, s.cwd, ctx.homeDir)}${by}`,
          );
        }
      });
    lines.push(
      "",
      "Choose one with the rewind dialog in the app (Esc twice), or /rewind in dawg's interactive mode.",
      SHELL_CAVEAT,
    );
    return { kind: "output", text: lines.join("\n") };
  },
};
