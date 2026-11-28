/**
 * `dawg -p`: one turn with nobody to answer, then exit. Permission requests are denied unless a
 * rule or the mode allows them; questions and plans get the "nobody can answer" result. Standard
 * output holds the result in the chosen format and nothing else; diagnostics go to standard error.
 */
import path from "node:path";
import { parseSlashCommand } from "@dawg/engine";
import type { EngineEvent, EventPayload, SessionStatus, Usage } from "@dawg/protocol";
import type { CliOptions } from "./args.ts";
import { EXIT } from "./exit-codes.ts";
import { type Io, readAll } from "./io.ts";
import { agentLine, sandboxLine, toolLine } from "./render.ts";
import { openSession, RunError, runErrorFrom } from "./session.ts";
import { type Running, start } from "./start.ts";
import { approveProjectCode, hookLine, skippedLine } from "./trust.ts";

type TurnFinished = EventPayload<"turn.finished">;

const NOBODY = {
  permissionPrompts: false,
  questions: false,
  planApproval: false,
  elicitation: false,
};

async function promptText(options: CliOptions, io: Io): Promise<string> {
  if (options.prompt !== null && options.prompt.trim() !== "") return options.prompt;
  if (io.stdin.isTTY) {
    throw new RunError(EXIT.usage, "No prompt: give one after -p, or pipe it on standard input.");
  }
  let text: string;
  try {
    text = await readAll(io.stdin);
  } catch (error) {
    throw new RunError(EXIT.usage, error instanceof Error ? error.message : String(error));
  }
  if (text.trim() === "") {
    throw new RunError(EXIT.usage, "No prompt: standard input was empty.");
  }
  return text;
}

function exitFor(stopReason: TurnFinished["stopReason"]): number {
  switch (stopReason) {
    case "completed":
      return EXIT.ok;
    case "turn_limit":
      return EXIT.turnLimit;
    case "interrupted":
      return EXIT.interrupted;
    case "error":
      return EXIT.error;
  }
}

export async function runHeadless(options: CliOptions, io: Io): Promise<number> {
  const log = (line: string) => io.stderr.write(`${line}\n`);
  const verbose = options.verbose ? log : () => {};
  let running: Running | null = null;
  let turn: { sessionId: string; turnId: string } | null = null;
  let terminated = false;
  let signals = 0;
  const stopSignals = io.onSignal((signal) => {
    signals += 1;
    terminated ||= signal === "SIGTERM";
    const code = terminated ? EXIT.terminated : EXIT.interrupted;
    // Before a turn runs there is nothing to stop cleanly; a second signal never waits.
    if (signals > 1 || turn === null || running === null) io.exitNow(code);
    log("Interrupting... (press Ctrl+C again to quit at once)");
    void running.client
      .request("session.interrupt", { sessionId: turn.sessionId })
      .catch(() => io.exitNow(code));
  });

  try {
    const text = await promptText(options, io);
    running = await start(options, io, {
      capabilities: NOBODY,
      // A title costs a model request after the turn; a one-shot run would only abort it.
      generateTitles: false,
      log,
      verbose,
    });
    const { client } = running;
    const cwd = path.resolve(io.cwd, options.cwd ?? ".");
    // Events that come while the session opens (a resumed session's mode or model being set)
    // are held until its id is known.
    const early: EngineEvent[] = [];
    let handle = (event: EngineEvent) => {
      early.push(event);
    };
    client.onEvent((event) => handle(event));
    // Unapproved project code never runs here; the flag approves it before the session opens,
    // so its SessionStart hooks run too.
    if (options.approveProjectCode && options.resume === null) {
      await approveProjectCode(client, cwd, log);
    }
    const snapshot = await openSession(client, options, cwd, log, io.cwd);
    if (options.approveProjectCode && options.resume !== null) {
      await approveProjectCode(client, snapshot.session.projectDir, log);
    }
    let sessionId = snapshot.session.id;
    const startRequests = snapshot.usage?.totals.requests ?? 0;
    let usage: Usage | null = snapshot.usage;
    let status: SessionStatus = snapshot.session.status;
    const finished = new Map<string, TurnFinished>();
    /** The latest turn to end, and the subagents still queued or running. */
    let latest: TurnFinished | null = null;
    let turnsStarted = 0;
    const working = new Set<string>();
    let wake = () => {};
    const started = new Map<string, { toolName: string; input: Record<string, unknown> }>();

    handle = (event: EngineEvent) => {
      if (event.payload.sessionId !== sessionId) return;
      if (options.outputFormat === "stream-json") io.stdout.write(`${JSON.stringify(event)}\n`);
      switch (event.event) {
        case "usage.updated":
          usage = event.payload.usage;
          break;
        case "session.status":
          status = event.payload.status;
          wake();
          break;
        case "turn.started":
          turnsStarted += 1;
          wake();
          break;
        case "turn.finished":
          finished.set(event.payload.turnId, event.payload);
          latest = event.payload;
          wake();
          break;
        case "subagent.updated": {
          const agent = event.payload.agent;
          if (agent.status === "queued" || agent.status === "running") working.add(agent.agentId);
          else working.delete(agent.agentId);
          if (agent.status !== "running" || agent.toolUses === 0) verbose(agentLine(agent));
          wake();
          break;
        }
        case "error":
          log(`Error: ${event.payload.error.message}`);
          break;
        case "tool.started":
          started.set(event.payload.toolCallId, event.payload);
          break;
        case "tool.finished": {
          verbose(toolLine(started.get(event.payload.toolCallId), event.payload, cwd));
          // What the sandbox stopped is worth a line even without --verbose.
          const blocked = sandboxLine(event.payload.display);
          if (blocked !== null) log(blocked.trim());
          break;
        }
        case "hook.ran":
          verbose(hookLine(event.payload));
          break;
        case "hook.skipped":
          log(skippedLine(event.payload, true));
          break;
      }
    };
    for (const event of early.splice(0)) handle(event);
    const until = async (done: () => boolean) => {
      while (!done()) await new Promise<void>((resolve) => (wake = resolve));
    };

    // A known slash command at the start of the prompt runs as a command, as typed in a session.
    const command = parseSlashCommand(text);
    let output: string | null = null;
    let turnId: string | null = null;
    if (command !== null && snapshot.commands.some((c) => c.name === command.name)) {
      const result = await client.request("session.command", {
        sessionId,
        name: command.name,
        args: command.args,
      });
      if (result.openedSession !== null) sessionId = result.openedSession.session.id;
      output = result.output;
      turnId = result.turnId;
    } else {
      turnId = (
        await client.request("session.prompt", {
          sessionId,
          prompt: { content: [{ type: "text", text }] },
        })
      ).turnId;
    }

    let end: TurnFinished | null = null;
    if (turnId !== null) {
      turn = { sessionId, turnId };
      const id = turnId;
      await until(() => finished.has(id));
      end = finished.get(id) ?? null;
      // Background agents: the session wakes itself with a turn when one ends, so the run ends
      // once none is left working and no turn of its own follows.
      while (working.size > 0 && !terminated) {
        const before = turnsStarted;
        await until(() => working.size === 0 || terminated);
        await until(() => status !== "working" || terminated);
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        if (turnsStarted !== before) await until(() => status !== "working" || terminated);
        end = latest ?? end;
      }
    } else {
      // A command that answered at once may still have work running (`/compact`).
      await until(() => status !== "working");
    }

    const stopReason = end?.stopReason ?? "completed";
    const result = end === null ? (output ?? "") : (end.finalText ?? "");
    const code = terminated ? EXIT.terminated : exitFor(stopReason);
    if (end?.error)
      log(
        `Error: ${end.error.message}${end.error.detail ? ` (${end.error.detail.split("\n")[0]})` : ""}`,
      );
    if (stopReason === "turn_limit") {
      log(`Stopped: the turn reached its limit of ${options.maxTurns ?? "200"} model requests.`);
    }
    if (stopReason === "interrupted") log("Interrupted.");
    // A run never starts a sign-in: say which servers it went without, and where to sign in.
    const unsigned = await client
      .request("mcp.list", { projectDir: snapshot.session.projectDir, sessionId })
      .then((listed) => listed.servers.filter((s) => s.state === "needs-sign-in"))
      .catch(() => []);
    for (const server of unsigned) {
      log(
        `The MCP server ${server.name} needs sign-in, so this run went without it. Sign in with /mcp login ${server.name} in dawg, or in Settings → MCP servers.`,
      );
    }

    if (options.outputFormat === "text") {
      if (result !== "") io.stdout.write(result.endsWith("\n") ? result : `${result}\n`);
    } else if (options.outputFormat === "json") {
      const finalUsage: Usage | null = usage;
      const requests = (finalUsage?.totals.requests ?? startRequests) - startRequests;
      io.stdout.write(
        `${JSON.stringify({
          type: "result",
          result,
          stopReason,
          isError: stopReason !== "completed",
          error: end?.error ?? null,
          sessionId,
          turnId,
          numRequests: requests,
          durationMs: end?.durationMs ?? 0,
          usage: finalUsage,
        })}\n`,
      );
    }
    return code;
  } catch (error) {
    const failure = runErrorFrom(error);
    log(`Error: ${failure.message}`);
    return failure.exitCode;
  } finally {
    turn = null;
    await running?.close();
    stopSignals();
  }
}
