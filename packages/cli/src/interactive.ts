/**
 * `dawg` without `-p`: a minimal line-based session for development before the app exists.
 * Streams the reply, prints one line per tool call and a compact diff for edits, asks permission,
 * questions and plan approval on the terminal, and runs slash commands. Plain text only, so it
 * behaves the same when input and output are pipes; lines are read in order, so a script can
 * answer prompts by writing the answers after the message that causes them.
 *
 * Ctrl+C interrupts a running turn; a second one, or one at the prompt, quits. `/exit` and the
 * end of input quit too.
 */
import path from "node:path";
import { createInterface } from "node:readline";
import { parseSlashCommand } from "@dawg/engine";
import {
  type Client,
  type EngineEvent,
  type EventPayload,
  type PermissionResponse,
  type PlanResponse,
  type QuestionAnswer,
  type QuestionResponse,
  RpcError,
  type SessionSnapshot,
} from "@dawg/protocol";
import type { CliOptions } from "./args.ts";
import { cliVersion } from "./engine.ts";
import { EXIT } from "./exit-codes.ts";
import type { Io } from "./io.ts";
import { diffLines, permissionLines, toolLine } from "./render.ts";
import { openSession, runErrorFrom } from "./session.ts";
import { type Running, start } from "./start.ts";

type RequestEvent = Extract<
  EngineEvent,
  { event: "permission.requested" | "question.asked" | "plan.proposed" }
>;

/** Lines from the input, in order; `next` resolves null at the end of input. */
class LineQueue {
  #lines: string[] = [];
  #waiters: ((line: string | null) => void)[] = [];
  #closed = false;

  push(line: string): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(line);
    else this.#lines.push(line);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }

  /** The next line; with `signal`, gives up when it aborts and leaves the line for later. */
  next(signal?: AbortSignal): Promise<string | null> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const waiter = (value: string | null) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new RequestClosed());
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }
}

/** The request being answered was closed (the turn was interrupted or ended). */
class RequestClosed extends Error {
  override name = "RequestClosed";
}

export async function runInteractive(options: CliOptions, io: Io): Promise<number> {
  const err = (line: string) => io.stderr.write(`${line}\n`);
  const out = (text: string) => io.stdout.write(text);
  const verbose = options.verbose ? err : () => {};
  const tty = io.stdin.isTTY === true && io.stdout.isTTY === true;

  const lines = new LineQueue();
  const rl = createInterface({
    input: io.stdin,
    ...(tty ? { output: io.stdout } : {}),
    terminal: tty,
    prompt: "> ",
  });
  rl.on("line", (line) => lines.push(line));
  rl.on("close", () => lines.close());

  let running: Running | null = null;
  let current: SessionSnapshot | null = null;
  /** The turn being followed, if any. */
  let active: { sessionId: string; turnId: string } | null = null;
  let interrupting = false;
  let quitting = false;

  const interrupt = () => {
    if (active === null || running === null) {
      // At the prompt (or still starting): Ctrl+C quits.
      if (running === null) io.exitNow(EXIT.interrupted);
      quitting = true;
      lines.close();
      return;
    }
    if (interrupting) io.exitNow(EXIT.interrupted);
    interrupting = true;
    err("\nInterrupting... (Ctrl+C again to quit)");
    void running.client
      .request("session.interrupt", { sessionId: active.sessionId })
      .catch(() => io.exitNow(EXIT.interrupted));
  };
  rl.on("SIGINT", interrupt);
  const stopSignals = io.onSignal(interrupt);

  try {
    running = await start(options, io, {
      capabilities: { permissionPrompts: true, questions: true, planApproval: true },
      generateTitles: true,
      log: err,
      verbose,
    });
    const { client } = running;
    const cwd = path.resolve(io.cwd, options.cwd ?? ".");
    current = await openSession(client, options, cwd, err);
    err(
      `dawg ${cliVersion()}: ${current.modelInfo?.id ?? "model"} in ${current.session.cwd}, ` +
        `session ${current.session.id}, ${current.session.mode} mode.`,
    );
    err("Type /help for commands, /exit to quit. Ctrl+C interrupts a turn.");

    const view = new View(io, () => current?.session.cwd ?? cwd);
    const requests: RequestEvent[] = [];
    /** Aborted when a request closes without our answer, so its prompt stops waiting. */
    const closers = new Map<string, AbortController>();
    const finished = new Set<string>();
    let wake = () => {};
    client.onEvent((event) => {
      if (event.payload.sessionId !== current?.session.id) return;
      view.render(event);
      if (
        event.event === "permission.requested" ||
        event.event === "question.asked" ||
        event.event === "plan.proposed"
      ) {
        requests.push(event);
        closers.set(requestIdOf(event), new AbortController());
      }
      if (event.event === "request.resolved") {
        const id = event.payload.requestId;
        closers.get(id)?.abort();
        closers.delete(id);
        const waiting = requests.findIndex((r) => requestIdOf(r) === id);
        if (waiting >= 0) requests.splice(waiting, 1);
      }
      if (event.event === "turn.finished") {
        finished.add(`${event.payload.sessionId}/${event.payload.turnId}`);
      }
      if (event.event === "compaction.finished")
        finished.add(`${event.payload.sessionId}/compaction`);
      wake();
    });

    const follow = async (sessionId: string, turnId: string) => {
      active = { sessionId, turnId };
      interrupting = false;
      const key = `${sessionId}/${turnId}`;
      while (!finished.has(key)) {
        const request = requests.shift();
        if (request !== undefined) {
          const closer = closers.get(requestIdOf(request)) ?? new AbortController();
          await answer(client, request, lines, view, err, closer.signal);
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
      active = null;
      view.endLine();
    };

    const send = async (line: string) => {
      const session = current as SessionSnapshot;
      const sessionId = session.session.id;
      const command = parseSlashCommand(line);
      if (command !== null && (command.name === "exit" || command.name === "quit")) {
        quitting = true;
        return;
      }
      try {
        if (command !== null) {
          const compacting = command.name === "compact";
          finished.delete(`${sessionId}/compaction`);
          const result = await client.request("session.command", {
            sessionId,
            name: command.name,
            args: command.args,
          });
          if (result.output !== null) out(`${result.output}\n`);
          if (result.openedSession !== null) {
            current = result.openedSession;
            err(`Session ${current.session.id} in ${current.session.cwd}.`);
          }
          if (result.turnId !== null) await follow(sessionId, result.turnId);
          else if (compacting) await follow(sessionId, "compaction");
          return;
        }
        const { turnId } = await client.request("session.prompt", {
          sessionId,
          prompt: { content: [{ type: "text", text: line }] },
        });
        await follow(sessionId, turnId);
      } catch (error) {
        active = null;
        err(error instanceof RpcError ? error.message : runErrorFrom(error).message);
      }
    };

    if (options.prompt !== null && options.prompt.trim() !== "") await send(options.prompt);
    while (!quitting) {
      if (tty) rl.prompt();
      const line = await lines.next();
      if (line === null) break;
      if (line.trim() === "") continue;
      await send(line);
    }
    return EXIT.ok;
  } catch (error) {
    const failure = runErrorFrom(error);
    err(`Error: ${failure.message}`);
    return failure.exitCode;
  } finally {
    stopSignals();
    rl.close();
    await running?.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Showing events
// ---------------------------------------------------------------------------------------------

class View {
  readonly #io: Io;
  readonly #cwd: () => string;
  /** True when the last thing written to standard output did not end a line. */
  #midLine = false;
  readonly #streamed = new Set<string>();
  readonly #started = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  #mode: string | null = null;

  constructor(io: Io, cwd: () => string) {
    this.#io = io;
    this.#cwd = cwd;
  }

  cwd(): string {
    return this.#cwd();
  }

  write(text: string): void {
    if (text === "") return;
    this.#io.stdout.write(text);
    this.#midLine = !text.endsWith("\n");
  }

  line(text: string): void {
    this.endLine();
    this.write(`${text}\n`);
  }

  endLine(): void {
    if (this.#midLine) this.write("\n");
  }

  render(event: EngineEvent): void {
    const cwd = this.#cwd();
    switch (event.event) {
      case "message.delta":
        this.#streamed.add(event.payload.messageId);
        this.write(event.payload.text);
        break;
      case "message.finished":
        if (!this.#streamed.has(event.payload.messageId)) this.write(event.payload.text);
        this.endLine();
        break;
      case "tool.started":
        this.#started.set(event.payload.toolCallId, event.payload);
        break;
      case "tool.finished": {
        this.line(toolLine(this.#started.get(event.payload.toolCallId), event.payload, cwd));
        if (event.payload.display?.kind === "diff" && event.payload.outcome === "success") {
          for (const l of diffLines(event.payload.display, cwd)) this.line(l);
        }
        break;
      }
      case "tasks.updated":
        this.line("Tasks:");
        for (const task of event.payload.tasks) {
          const mark =
            task.status === "completed" ? "x" : task.status === "in_progress" ? ">" : " ";
          this.line(`  [${mark}] ${task.content}`);
        }
        break;
      case "compaction.started":
        this.line("(compacting the conversation)");
        break;
      case "compaction.finished":
        this.line(
          event.payload.outcome === "completed"
            ? `(compacted: ${event.payload.contextBefore} -> ${event.payload.contextAfter ?? "?"} tokens)`
            : `(compaction ${event.payload.outcome}${event.payload.error ? `: ${event.payload.error.message}` : ""})`,
        );
        break;
      case "session.updated":
        if (this.#mode !== null && event.payload.mode !== this.#mode) {
          this.line(`(mode: ${event.payload.mode})`);
        }
        this.#mode = event.payload.mode;
        break;
      case "error":
        this.endLine();
        this.#io.stderr.write(`Error: ${event.payload.error.message}\n`);
        break;
      case "turn.finished":
        this.endLine();
        if (event.payload.stopReason === "interrupted") this.line("(interrupted)");
        if (event.payload.stopReason === "turn_limit") this.line("(stopped: turn limit reached)");
        if (event.payload.stopReason === "error" && event.payload.error !== null) {
          this.#io.stderr.write(`Error: ${event.payload.error.message}\n`);
        }
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Answering requests
// ---------------------------------------------------------------------------------------------

function requestIdOf(event: RequestEvent): string {
  return event.event === "permission.requested"
    ? event.payload.request.requestId
    : event.payload.requestId;
}

async function ask(
  lines: LineQueue,
  view: View,
  question: string,
  signal: AbortSignal,
): Promise<string | null> {
  view.write(question);
  try {
    return await lines.next(signal);
  } finally {
    view.endLine();
  }
}

async function answer(
  client: Client,
  request: RequestEvent,
  lines: LineQueue,
  view: View,
  err: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const sessionId = request.payload.sessionId;
  try {
    switch (request.event) {
      case "permission.requested": {
        const response = await answerPermission(request.payload, lines, view, signal);
        await client.request("permission.respond", {
          sessionId,
          requestId: request.payload.request.requestId,
          response,
        });
        return;
      }
      case "question.asked": {
        const response = await answerQuestion(request.payload, lines, view, signal);
        await client.request("question.respond", {
          sessionId,
          requestId: request.payload.requestId,
          response,
        });
        return;
      }
      case "plan.proposed": {
        const response = await answerPlan(request.payload, lines, view, signal);
        await client.request("plan.respond", {
          sessionId,
          requestId: request.payload.requestId,
          response,
        });
        return;
      }
    }
  } catch (error) {
    if (error instanceof RequestClosed) {
      view.line("(the request was closed)");
      return;
    }
    // Most often the turn ended (an interrupt) before the answer came; nothing waits on it now.
    err(error instanceof Error ? error.message : String(error));
  }
}

async function answerPermission(
  payload: EventPayload<"permission.requested">,
  lines: LineQueue,
  view: View,
  signal: AbortSignal,
): Promise<PermissionResponse> {
  view.endLine();
  for (const l of permissionLines(payload.request, view.cwd())) view.line(l);
  for (;;) {
    const line = await ask(
      lines,
      view,
      "Allow? y = once, a = always, n = deny (n <reason> to say why): ",
      signal,
    );
    if (line === null) return { behavior: "deny", message: "No answer: the input ended." };
    const text = line.trim();
    if (/^y(es)?$/i.test(text)) return { behavior: "allow", scope: "once" };
    if (/^a(lways)?$/i.test(text)) return { behavior: "allow", scope: "always" };
    const deny = /^n(o)?(?:\s+(.*))?$/is.exec(text);
    if (deny !== null) {
      const message = deny[2]?.trim();
      return message ? { behavior: "deny", message } : { behavior: "deny" };
    }
  }
}

async function answerQuestion(
  payload: EventPayload<"question.asked">,
  lines: LineQueue,
  view: View,
  signal: AbortSignal,
): Promise<QuestionResponse> {
  const answers: QuestionAnswer[] = [];
  for (const q of payload.questions) {
    view.line(`Question${q.header ? ` (${q.header})` : ""}: ${q.question}`);
    q.options.forEach((option, i) => {
      view.line(
        `  ${i + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}`,
      );
    });
    const hint = q.multiSelect ? "numbers separated by commas" : "a number";
    const line = await ask(
      lines,
      view,
      `Answer with ${hint}, or type your own (empty to skip): `,
      signal,
    );
    if (line === null || line.trim() === "") {
      return { outcome: "dismissed", message: "The person did not answer." };
    }
    const picks = line
      .split(/[\s,]+/)
      .filter((w) => w !== "")
      .map((w) => Number(w));
    const valid =
      picks.length > 0 &&
      picks.every((p) => Number.isInteger(p) && p >= 1 && p <= q.options.length) &&
      (q.multiSelect || picks.length === 1);
    answers.push(
      valid
        ? { question: q.question, selected: picks.map((p) => q.options[p - 1]?.label ?? "") }
        : { question: q.question, selected: [], text: line.trim() },
    );
  }
  return { outcome: "answered", answers };
}

async function answerPlan(
  payload: EventPayload<"plan.proposed">,
  lines: LineQueue,
  view: View,
  signal: AbortSignal,
): Promise<PlanResponse> {
  view.line("Proposed plan:");
  for (const l of payload.plan.split("\n")) view.line(`  ${l}`);
  const back = payload.modeBeforePlan;
  const yes = back === null ? "y = yes" : `y = yes (then ${back} mode)`;
  for (;;) {
    const line = await ask(
      lines,
      view,
      `Approve? ${yes}, e = yes and accept edits, n = keep planning (n <feedback>): `,
      signal,
    );
    if (line === null) return { decision: "reject", message: "No answer: the input ended." };
    const text = line.trim();
    if (/^y(es)?$/i.test(text)) return { decision: "approve" };
    if (/^e$/i.test(text)) return { decision: "approve", mode: "acceptEdits" };
    const reject = /^n(o)?(?:\s+(.*))?$/is.exec(text);
    if (reject !== null) {
      const message = reject[2]?.trim();
      return message ? { decision: "reject", message } : { decision: "reject" };
    }
  }
}
