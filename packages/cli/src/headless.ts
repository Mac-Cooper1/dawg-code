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
import { toolLine } from "./render.ts";
import { openSession, RunError, runErrorFrom } from "./session.ts";
import { type Running, start } from "./start.ts";

type TurnFinished = EventPayload<"turn.finished">;

const NOBODY = { permissionPrompts: false, questions: false, planApproval: false };

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
    const snapshot = await openSession(client, options, cwd, log);
    let sessionId = snapshot.session.id;
    const startRequests = snapshot.usage?.totals.requests ?? 0;
    let usage: Usage | null = snapshot.usage;
    let status: SessionStatus = snapshot.session.status;
    const finished = new Map<string, TurnFinished>();
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
        case "turn.finished":
          finished.set(event.payload.turnId, event.payload);
          wake();
          break;
        case "error":
          log(`Error: ${event.payload.error.message}`);
          break;
        case "tool.started":
          started.set(event.payload.toolCallId, event.payload);
          break;
        case "tool.finished":
          verbose(toolLine(started.get(event.payload.toolCallId), event.payload, cwd));
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
