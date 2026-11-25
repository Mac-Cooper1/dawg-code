/** The text `/help` and `/context` answer with, in Markdown. */
import { ErrorCodes, RpcError } from "@dawg/protocol";
import { COMMANDS, type MockSession } from "./session.ts";
import { contextBreakdown } from "./usage.ts";

const n = (value: number) => Math.round(value).toLocaleString("en-US");
const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";

function usageOf(name: string): string {
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) return `/${name}`;
  return `/${command.name}${command.argumentHint === null ? "" : ` ${command.argumentHint}`}`;
}

/** `/help`, or `/help <command>` for one command. */
export function helpText(args: string): string {
  const wanted = args.trim().replace(/^\//, "");
  if (wanted !== "") {
    const command = COMMANDS.find((c) => c.name === wanted);
    if (command === undefined) {
      throw new RpcError(
        ErrorCodes.InvalidParams,
        `There is no command /${wanted}. Type /help for the list.`,
      );
    }
    return `\`${usageOf(command.name)}\`\n\n${command.description}.`;
  }
  return [
    "| Command | What it does |",
    "| --- | --- |",
    ...COMMANDS.map((c) => `| \`${usageOf(c.name)}\` | ${c.description} |`),
    "",
    "Anything that does not start with a slash is sent to the model.",
  ].join("\n");
}

/** `/context`: where the context window is going, from the session's latest usage. */
export function contextText(session: MockSession): string {
  const usage = session.state.usage;
  const window = session.modelInfo?.contextWindow ?? usage?.contextWindow ?? 0;
  if (usage === null) {
    return `No model request yet in this session, so nothing is counted. The context window is ${n(window)} tokens.`;
  }
  const used = usage.contextUsed;
  const free = Math.max(0, window - used);
  const parts = usage.breakdown ?? contextBreakdown(used);
  const row = (label: string, tokens: number) =>
    `| ${label} | ${n(tokens)} | ${percent(tokens, window)} |`;
  const lines = [
    `Context: **${n(used)} of ${n(window)} tokens** (${percent(used, window)}), as counted at the last request.`,
    "",
    "| Part | Tokens | Share |",
    "| --- | ---: | ---: |",
    row("System prompt", parts.systemPrompt),
    row("Instructions", parts.instructions),
    row("Tools", parts.tools),
    row("Messages", parts.messages),
    row("Free", free),
    "",
  ];
  if (usage.compactAt !== null) {
    lines.push(
      `Compacts on its own above ${n(usage.compactAt)} tokens (${percent(usage.compactAt, window)}).`,
      "",
    );
  }
  const last = usage.last;
  if (last.promptTokens !== null) {
    const cached = last.cachedTokens ?? 0;
    const read =
      last.promptTokensPerSecond === null ? "" : ` at ${n(last.promptTokensPerSecond)} tokens/s`;
    const wrote =
      last.completionTokens === null
        ? ""
        : `, wrote ${n(last.completionTokens)}${last.completionTokensPerSecond === null ? "" : ` at ${n(last.completionTokensPerSecond)} tokens/s`}`;
    lines.push(
      `Last request: read ${n(last.promptTokens)} prompt tokens (${percent(cached, last.promptTokens)} from cache)${read}${wrote}.`,
    );
  }
  const t = usage.totals;
  lines.push(
    `This session: ${n(t.requests)} ${t.requests === 1 ? "request" : "requests"}, ${n(t.promptTokens)} prompt and ${n(t.completionTokens)} completion tokens.`,
  );
  if (used > window && window > 0)
    lines.push("", "The conversation no longer fits: run /compact or /clear.");
  return lines.join("\n");
}
