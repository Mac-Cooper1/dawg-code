/**
 * Opens a subagent's session runtime: creates its transcript under the parent's `subagents/`
 * folder (or opens the one it has, for another task), loads the settings and instruction files
 * of the folder it works in, and starts an ordinary runtime with the agent's role.
 *
 * The agent's event log starts with its own work: a fork's copied history is in its transcript
 * (the model sees it) but not described as events, so its transcript view shows what it did.
 */
import path from "node:path";
import { loadInstructions } from "@dawg/compat";
import type { ClientCapabilities, PermissionMode } from "@dawg/protocol";
import type { Message } from "../contracts/messages.ts";
import type { EngineContext } from "../runtime/context.ts";
import { EventLog } from "../runtime/event-log.ts";
import type { RuntimeInit, SessionRuntime } from "../runtime/session.ts";
import { loadSessionSettings } from "../runtime/settings-reload.ts";
import { type Sidecar, writeSidecar } from "../runtime/sidecar.ts";
import type { ModelConnection } from "../runtime/types.ts";
import { readSessionFile } from "../session/file.ts";
import type { SessionWriter } from "../session/writer.ts";
import type { SubagentRole } from "./role.ts";
import { createChild, openChild } from "./store.ts";

export interface OpenChildRuntimeInput {
  ctx: EngineContext;
  /** `SessionRuntime.start`, passed in so this module does not import the runtime. */
  start: (init: RuntimeInit) => Promise<SessionRuntime>;
  parent: {
    sessionId: string;
    sessionDir: string;
    projectDir: string;
    model: string | null;
    effort: string | null;
    additionalDirectories: readonly string[];
  };
  connection: ModelConnection;
  capabilities: ClientCapabilities;
  childId: string;
  cwd: string;
  create: { title: string; mode: PermissionMode; initialMessages: Message[] } | null;
  role: SubagentRole;
}

export async function openChildRuntime(input: OpenChildRuntimeInput): Promise<SessionRuntime> {
  const { ctx, parent, childId } = input;
  const writerOptions = { now: () => new Date(ctx.clock()), durability: "batched" as const };
  let writer: SessionWriter;
  let dir: string;
  let file: string;
  if (input.create !== null) {
    const created = await createChild({
      parentSessionDir: parent.sessionDir,
      childId,
      cwd: input.cwd,
      title: input.create.title,
      forkedFrom: input.role.fork === null ? null : { sessionId: parent.sessionId, seq: 0 },
      initialState: {
        mode: input.create.mode,
        model: parent.model,
        effort: parent.effort,
        additionalDirectories: [...parent.additionalDirectories],
      },
      initialMessages: input.create.initialMessages,
      options: writerOptions,
    });
    writer = created.writer;
    dir = created.paths.dir;
    file = created.paths.file;
  } else {
    const opened = await openChild(parent.sessionDir, childId, writerOptions);
    writer = opened.writer;
    dir = opened.paths.dir;
    file = opened.paths.file;
  }
  let log: EventLog | null = null;
  try {
    await writer.flush();
    const { records } = await readSessionFile(file);
    log = EventLog.open(path.join(dir, "events.jsonl"), childId, ctx.clock);
    const cwd = writer.snapshot.meta.cwd;
    const { settings, stamp } = await loadSessionSettings({
      projectDir: cwd,
      localDir: parent.projectDir,
      homeDir: ctx.homeDir,
      ...(ctx.settingsFlags === undefined ? {} : { flags: ctx.settingsFlags }),
    });
    const instructions = await loadInstructions({
      cwd,
      homeDir: ctx.homeDir,
      projectDir: cwd,
      externalImports: ctx.externalImports,
    });
    const state = writer.snapshot.state;
    const sidecar: Sidecar = {
      v: 1,
      lastSeq: log.lastSeq,
      projectDir: parent.projectDir,
      mode: state.mode,
      model: state.model,
      effort: state.effort,
      lastTurnFailed: false,
      forkPoint: null,
    };
    await writeSidecar(dir, sidecar);
    return await input.start({
      ctx,
      writer,
      records,
      log,
      settings,
      settingsStamp: stamp,
      instructions,
      connection: input.connection,
      capabilities: input.capabilities,
      sessionDir: dir,
      sidecar,
      startSource: input.create === null ? "resume" : "startup",
      memory: null,
      subagent: input.role,
    });
  } catch (error) {
    log?.close();
    await writer.close().catch(() => {});
    throw error;
  }
}
