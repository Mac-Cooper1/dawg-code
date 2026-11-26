/**
 * The engine: opens, lists and manages sessions, and holds what they share. A protocol server and
 * the command-line tool both sit on this API. See README.md in this folder.
 */
import { randomUUID } from "node:crypto";
import { open as openFile, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { loadInstructions, type Settings } from "@dawg/compat";
import type {
  ClientCapabilities,
  ForkPoint,
  SessionSummary as ProtocolSummary,
} from "@dawg/protocol";
import { DEFAULT_TOOL_LIMITS } from "../contracts/tools.ts";
import { DEFAULT_LOOP_LIMITS, type IdKind } from "../loop/types.ts";
import { type SlotPool, SlotScheduler } from "../model/slots.ts";
import { createPermissionEngine } from "../permissions/index.ts";
import {
  type SessionRecord,
  SessionStore,
  SessionStoreError,
  type SessionWriter,
  type SessionSummary as StoredSummary,
} from "../session/index.ts";
import { CORE_TOOLS } from "../tools/index.ts";
import { INTERACTIVE_TOOLS } from "../tools/interactive/index.ts";
import type { EngineContext } from "./context.ts";
import { gatherEnvironment } from "./environment.ts";
import { RuntimeError } from "./errors.ts";
import { EventLog, type LoggedEvent, type ReplayPage } from "./event-log.ts";
import { SessionRuntime } from "./session.ts";
import { loadSessionSettings } from "./settings-reload.ts";
import { readSidecar, type Sidecar, writeSidecar } from "./sidecar.ts";
import { eventsFromRecords, promptSeqOf, promptSeqs } from "./transcript.ts";
import {
  DEFAULT_RUNTIME_LIMITS,
  type EngineOptions,
  type ForkSessionOptions,
  type ListSessionsOptions,
  type NewSessionOptions,
  type OpenSessionOptions,
} from "./types.ts";

const EVENTS_FILE = "events.jsonl";

function defaultNewId(kind: IdKind): string {
  return `${kind}-${randomUUID()}`;
}

export class Engine {
  readonly store: SessionStore;
  readonly #ctx: EngineContext;
  readonly #open = new Map<string, SessionRuntime>();
  readonly #listeners = new Set<(event: LoggedEvent) => void>();
  /** Sessions `deleteSession` is deleting right now; nothing may open them meanwhile. */
  readonly #deleting = new Set<string>();
  /** One scheduler per pool of model slots, so sessions on one server share its slots. */
  readonly #schedulers = new WeakMap<SlotPool, SlotScheduler>();

  constructor(options: EngineOptions) {
    const clock = options.clock ?? Date.now;
    const tools = options.tools ?? [...CORE_TOOLS, ...INTERACTIVE_TOOLS];
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    if (toolMap.size !== tools.length) throw new Error("Two tools share a name.");
    const profile = options.profile;
    this.store = new SessionStore({
      root: options.storeRoot,
      now: () => new Date(clock()),
      ...(options.durability === undefined ? {} : { durability: options.durability }),
    });
    this.#ctx = {
      store: this.store,
      storeRoot: options.storeRoot,
      homeDir: options.homeDir,
      models: options.models,
      assembler: options.assembler,
      compactor: options.compactor,
      estimator: options.estimator,
      profileFor: typeof profile === "function" ? profile : () => profile,
      permissions: options.permissions ?? createPermissionEngine(),
      tools,
      toolMap,
      toolLimits: { ...DEFAULT_TOOL_LIMITS, ...options.toolLimits },
      limits: { ...DEFAULT_LOOP_LIMITS, ...DEFAULT_RUNTIME_LIMITS, ...options.limits },
      capabilities: {
        permissionPrompts: true,
        questions: true,
        planApproval: true,
        ...options.capabilities,
      },
      settingsFlags: options.settingsFlags,
      externalImports: options.externalImports ?? "block",
      ripgrepPath: options.ripgrepPath ?? null,
      generateTitles: options.generateTitles ?? true,
      clock,
      newId: options.newId ?? defaultNewId,
      environment: options.environment ?? gatherEnvironment,
      slots: (pool) => {
        let scheduler = this.#schedulers.get(pool);
        if (scheduler === undefined) {
          scheduler = new SlotScheduler(pool.slots);
          this.#schedulers.set(pool, scheduler);
        }
        return scheduler;
      },
      publish: (event) => {
        for (const listener of this.#listeners) {
          try {
            listener(event);
          } catch {
            // One failing listener must not affect the others.
          }
        }
      },
      onClosed: (runtime) => {
        if (this.#open.get(runtime.id) === runtime) this.#open.delete(runtime.id);
      },
    };
  }

  /** Events of every session open in this engine. Returns a function that stops them. */
  subscribe(listener: (event: LoggedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** An open session, or undefined. */
  get(sessionId: string): SessionRuntime | undefined {
    return this.#open.get(sessionId);
  }

  openSessions(): SessionRuntime[] {
    return [...this.#open.values()];
  }

  /** Creates a session in a directory and opens it. */
  async createSession(options: NewSessionOptions): Promise<SessionRuntime> {
    const ctx = this.#ctx;
    const cwd = path.resolve(options.cwd);
    await assertDirectory(cwd);
    // A worktree session belongs to its main project: personal settings come from there.
    const projectDir = options.projectDir === undefined ? cwd : path.resolve(options.projectDir);
    if (projectDir !== cwd) await assertDirectory(projectDir);
    const { settings, stamp: settingsStamp } = await loadSessionSettings({
      projectDir: cwd,
      localDir: projectDir,
      homeDir: ctx.homeDir,
      ...(ctx.settingsFlags === undefined ? {} : { flags: ctx.settingsFlags }),
    });
    const mode = options.mode ?? settings.permissions.defaultMode ?? "default";
    if (mode === "bypassPermissions" && settings.permissions.bypassDisabled) {
      throw new RuntimeError(
        "InvalidState",
        "bypassPermissions mode is turned off by permissions.disableBypassPermissionsMode.",
      );
    }
    const directories = unique(
      [
        ...settings.permissions.additionalDirectories,
        ...(options.additionalDirectories ?? []).map((d) => path.resolve(cwd, d)),
      ].filter((d) => d !== cwd),
    );
    const connection = await ctx.models.connect(options.model ?? null);
    const levels = connection.client.endpoint.template?.reasoningEffortLevels ?? [];
    const effort =
      options.effort !== undefined && levels.includes(options.effort) ? options.effort : null;
    const instructions = await loadInstructions({
      cwd,
      homeDir: ctx.homeDir,
      projectDir: cwd,
      externalImports: ctx.externalImports,
    });
    const environment = await ctx.environment({
      cwd,
      additionalDirectories: directories,
      now: ctx.clock(),
    });
    const contextMessage = ctx.assembler.sessionContext(environment);
    const writer = await this.store.create({
      cwd,
      title: options.title ?? null,
      initialState: {
        mode,
        model: options.model ?? null,
        effort,
        additionalDirectories: directories,
      },
      // Written as a note, never as a prompt: it must not start a turn.
      initialMessages: [{ ...contextMessage, kind: "note" }],
    });
    return this.#start(writer, cwd, {
      settings,
      settingsStamp,
      instructions,
      connection,
      capabilities: options.capabilities,
      sidecar: {
        v: 1,
        lastSeq: 0,
        projectDir,
        mode,
        model: options.model ?? null,
        effort,
        lastTurnFailed: false,
        forkPoint: null,
      },
    });
  }

  /** Opens a stored session. An already open one is returned as it is. */
  async resumeSession(
    sessionId: string,
    options: OpenSessionOptions = {},
  ): Promise<SessionRuntime> {
    this.#assertNotDeleting(sessionId);
    const live = this.#open.get(sessionId);
    if (live !== undefined) {
      if (options.capabilities !== undefined) live.setCapabilities(options.capabilities);
      return live;
    }
    const cwd = await this.#locate(sessionId);
    return this.#openStored(cwd, sessionId, options, null);
  }

  /**
   * Copies a session up to a point into a new session and opens it. The parent may be open and
   * even mid-turn: "end" then stops before the running turn.
   */
  async forkSession(sessionId: string, options: ForkSessionOptions = {}): Promise<SessionRuntime> {
    this.#assertNotDeleting(sessionId);
    const cwd = await this.#locate(sessionId);
    if (options.cwd !== undefined && path.resolve(options.cwd) !== cwd) {
      throw new RuntimeError(
        "InvalidState",
        "A fork runs in its parent's working directory; a different one is not supported yet.",
      );
    }
    const parent = await this.store.read(cwd, sessionId);
    const point: ForkPoint = options.point ?? { position: "end" };
    const live = this.#open.get(sessionId);
    const atSeq = forkSeq(parent.records, point, live?.activePromptSeq ?? null);
    const parentTitle = parent.snapshot.state.title;
    const title = options.title ?? (parentTitle === null ? null : `${parentTitle} (fork)`);
    const id = await this.store.fork(cwd, sessionId, { atSeq, title });
    // A fork belongs to its parent's project.
    const parentProject =
      live?.projectDir ??
      (await readSidecar((await this.store.paths(cwd, sessionId)).dir))?.projectDir ??
      cwd;
    return this.#openStored(cwd, id, options, point, parentProject);
  }

  /** Stored sessions, newest activity first. */
  async listSessions(
    options: ListSessionsOptions = {},
  ): Promise<{ sessions: ProtocolSummary[]; nextCursor: string | null }> {
    const projects =
      options.projectDir === undefined
        ? await this.#projects()
        : [path.resolve(options.projectDir)];
    const all: ProtocolSummary[] = [];
    for (const project of projects) {
      const stored = await this.store
        .list(project, { includeArchived: options.includeArchived ?? false })
        .catch(() => [] as StoredSummary[]);
      for (const s of stored) {
        const summary = await this.#summaryOf(project, s);
        if (summary !== null) all.push(summary);
      }
    }
    const query = options.query?.trim().toLowerCase() ?? "";
    const matching =
      query === "" ? all : all.filter((s) => (s.title ?? "").toLowerCase().includes(query));
    matching.sort((a, b) =>
      a.lastActivityAt === b.lastActivityAt
        ? b.id.localeCompare(a.id)
        : b.lastActivityAt - a.lastActivityAt,
    );
    const start = options.cursor === undefined ? 0 : Math.max(0, Number(options.cursor) || 0);
    const limit = options.limit ?? matching.length;
    const page = matching.slice(start, start + limit);
    const next = start + page.length;
    return { sessions: page, nextCursor: next < matching.length ? String(next) : null };
  }

  async renameSession(sessionId: string, title: string): Promise<ProtocolSummary> {
    this.#assertNotDeleting(sessionId);
    const live = this.#open.get(sessionId);
    if (live !== undefined) return live.rename(title);
    const cwd = await this.#locate(sessionId);
    await this.#withStoreErrors(() => this.store.rename(cwd, sessionId, title));
    return this.#storedSummary(cwd, sessionId);
  }

  async archiveSession(sessionId: string, archived = true): Promise<ProtocolSummary> {
    this.#assertNotDeleting(sessionId);
    const live = this.#open.get(sessionId);
    if (live !== undefined) return live.setArchived(archived);
    const cwd = await this.#locate(sessionId);
    await this.#withStoreErrors(() => this.store.archive(cwd, sessionId, archived));
    return this.#storedSummary(cwd, sessionId);
  }

  /**
   * Deletes a stored session for good, open or not. An open one is closed first: a running turn
   * or compaction is interrupted (its `turn.finished` comes first), then `session.deleted` goes
   * out as its last event. Forks of it keep working. Refused while another process has it open.
   * Meanwhile nothing may open, fork, rename or archive it, so no other window can reopen it
   * half-way; a delete that fails leaves it as it was.
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.#assertNotDeleting(sessionId);
    this.#deleting.add(sessionId);
    try {
      await this.#delete(sessionId);
    } finally {
      this.#deleting.delete(sessionId);
    }
  }

  async #delete(sessionId: string): Promise<void> {
    const cwd = await this.#locate(sessionId);
    await this.#open.get(sessionId)?.closeDeleted();
    try {
      await this.store.delete(cwd, sessionId);
    } catch (error) {
      if (error instanceof SessionStoreError && error.code === "not-found") {
        throw new RuntimeError("SessionNotFound", `No session ${sessionId}.`, { cause: error });
      }
      if (error instanceof SessionStoreError && error.code === "locked") {
        throw new RuntimeError(
          "InvalidState",
          "The session is open in another process, such as dawg in a terminal; close it there before deleting it.",
          { cause: error },
        );
      }
      throw error;
    }
    // Plans are saved as <storeRoot>/plans/<session id>-<request id>.md. Forks never name them.
    const plans = path.join(this.#ctx.storeRoot, "plans");
    const names = await readdir(plans).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((name) => name.startsWith(`${sessionId}-`) && name.endsWith(".md"))
        .map((name) => rm(path.join(plans, name), { force: true }).catch(() => {})),
    );
  }

  /** Stored events after a sequence number, whether or not the session is open. */
  async replay(sessionId: string, afterSeq: number, limit?: number): Promise<ReplayPage> {
    const live = this.#open.get(sessionId);
    if (live !== undefined) return live.eventsAfter(afterSeq, limit);
    const cwd = await this.#locate(sessionId);
    const paths = await this.store.paths(cwd, sessionId);
    const file = path.join(paths.dir, EVENTS_FILE);
    if (EventLog.hasEvents(file)) return EventLog.read(file, afterSeq, limit);
    // No log yet: describe the transcript, numbered as opening the session would number it.
    const { records } = await this.store.read(cwd, sessionId);
    const events = eventsFromRecords(records).map((e, i) => ({
      event: e.event,
      payload: { sessionId, seq: i + 1, time: e.time, ...(e.fields as Record<string, unknown>) },
    })) as ReplayPage["events"];
    const after = events.filter((e) => e.payload.seq > afterSeq);
    const cut = limit !== undefined && after.length > limit;
    return {
      events: cut ? after.slice(0, limit) : after,
      lastSeq: events.length,
      hasMore: cut,
    };
  }

  /**
   * `/clear`: closes the session and opens a new one in the same directory with the same mode,
   * model, effort and directories. The old session stays stored and resumable.
   */
  async clearSession(sessionId: string): Promise<SessionRuntime> {
    const old = this.#open.get(sessionId);
    if (old === undefined)
      throw new RuntimeError("InvalidState", `Session ${sessionId} is not open.`);
    if (old.busy) throw new RuntimeError("SessionBusy", "A turn is running.");
    const model = old.modelSetting;
    const effort = old.effort;
    const options: NewSessionOptions = {
      cwd: old.cwd,
      projectDir: old.projectDir,
      mode: old.mode,
      additionalDirectories: old.additionalDirectories,
      capabilities: old.capabilities,
      ...(model === null ? {} : { model }),
      ...(effort === null ? {} : { effort }),
    };
    await old.close();
    return this.createSession(options);
  }

  /** Closes every open session. */
  async close(): Promise<void> {
    await Promise.all([...this.#open.values()].map((s) => s.close()));
  }

  // -------------------------------------------------------------------------------------------

  async #openStored(
    cwd: string,
    sessionId: string,
    options: OpenSessionOptions,
    forkPoint: ForkPoint | null,
    /** The project when the session's side folder does not say (a new fork). */
    projectFallback: string = cwd,
  ): Promise<SessionRuntime> {
    this.#assertNotDeleting(sessionId);
    const ctx = this.#ctx;
    const writer = await this.#withStoreErrors(() => this.store.open(cwd, sessionId));
    try {
      const paths = await this.store.paths(cwd, sessionId);
      const stored = await readSidecar(paths.dir);
      const projectDir = stored?.projectDir ?? projectFallback;
      const { settings, stamp: settingsStamp } = await loadSessionSettings({
        projectDir: cwd,
        localDir: projectDir,
        homeDir: ctx.homeDir,
        ...(ctx.settingsFlags === undefined ? {} : { flags: ctx.settingsFlags }),
      });
      const instructions = await loadInstructions({
        cwd,
        homeDir: ctx.homeDir,
        projectDir: cwd,
        externalImports: ctx.externalImports,
      });
      const connection = await ctx.models.connect(writer.snapshot.state.model);
      const state = writer.snapshot.state;
      const sidecar: Sidecar = {
        v: 1,
        lastSeq: stored?.lastSeq ?? 0,
        projectDir,
        mode: state.mode,
        model: state.model,
        effort: state.effort,
        lastTurnFailed: stored?.lastTurnFailed ?? false,
        forkPoint: forkPoint ?? stored?.forkPoint ?? null,
      };
      return await this.#start(writer, cwd, {
        settings,
        settingsStamp,
        instructions,
        connection,
        capabilities: options.capabilities,
        sidecar,
      });
    } catch (error) {
      if (!writer.closed) await writer.close().catch(() => {});
      throw error;
    }
  }

  async #start(
    writer: SessionWriter,
    cwd: string,
    init: {
      settings: Settings;
      settingsStamp: string;
      instructions: Awaited<ReturnType<typeof loadInstructions>>;
      connection: Awaited<ReturnType<EngineContext["models"]["connect"]>>;
      capabilities: Partial<ClientCapabilities> | undefined;
      sidecar: Sidecar;
    },
  ): Promise<SessionRuntime> {
    const ctx = this.#ctx;
    const sessionId = writer.sessionId;
    let log: EventLog | null = null;
    try {
      const { records } = await this.store.read(cwd, sessionId);
      const paths = await this.store.paths(cwd, sessionId);
      log = EventLog.open(path.join(paths.dir, EVENTS_FILE), sessionId, ctx.clock);
      if (log.lastSeq === 0 && records.length > 1) {
        // A fork, or a session written without events: describe its transcript once.
        for (const e of eventsFromRecords(records)) log.emit(e.event, e.fields as never, e.time);
      }
      await writeSidecar(paths.dir, init.sidecar);
      const runtime = await SessionRuntime.start({
        ctx,
        writer,
        records,
        log,
        settings: init.settings,
        settingsStamp: init.settingsStamp,
        instructions: init.instructions,
        connection: init.connection,
        capabilities: { ...ctx.capabilities, ...init.capabilities },
        sessionDir: paths.dir,
        sidecar: init.sidecar,
      });
      this.#open.set(sessionId, runtime);
      return runtime;
    } catch (error) {
      log?.close();
      await writer.close().catch(() => {});
      throw error;
    }
  }

  #assertNotDeleting(sessionId: string): void {
    if (this.#deleting.has(sessionId)) {
      throw new RuntimeError("InvalidState", "This session is being deleted.");
    }
  }

  /** The working directory a stored session is filed under. */
  async #locate(sessionId: string): Promise<string> {
    const live = this.#open.get(sessionId);
    if (live !== undefined) return live.cwd;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
      throw new RuntimeError("SessionNotFound", `No session ${sessionId}.`);
    }
    const root = path.join(this.#ctx.storeRoot, "projects");
    const folders = await readdir(root).catch(() => [] as string[]);
    for (const folder of folders) {
      const file = path.join(root, folder, "sessions", `${sessionId}.jsonl`);
      const cwd = await readMetaCwd(file);
      if (cwd !== null) return cwd;
    }
    throw new RuntimeError("SessionNotFound", `No session ${sessionId}.`);
  }

  /** Every project path that has a session folder. */
  async #projects(): Promise<string[]> {
    const root = path.join(this.#ctx.storeRoot, "projects");
    const folders = await readdir(root).catch(() => [] as string[]);
    const out: string[] = [];
    for (const folder of folders) {
      try {
        const claim = JSON.parse(await readFile(path.join(root, folder, "project.json"), "utf8"));
        if (typeof claim?.path === "string") out.push(claim.path);
      } catch {
        // An unclaimed or damaged folder holds no sessions we can list.
      }
    }
    return out;
  }

  async #summaryOf(project: string, s: StoredSummary): Promise<ProtocolSummary | null> {
    const live = this.#open.get(s.id);
    if (live !== undefined) return live.summary();
    if (s.cwd === null || s.damaged !== null) return null;
    const paths = await this.store.paths(project, s.id);
    const sidecar = await readSidecar(paths.dir);
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      projectDir: sidecar?.projectDir ?? s.cwd,
      createdAt: Date.parse(s.createdAt),
      lastActivityAt: Date.parse(s.lastActivity),
      status: sidecar?.lastTurnFailed || s.status === "error" ? "error" : "idle",
      queuePosition: null,
      mode: sidecar?.mode ?? "default",
      model: sidecar?.model ?? null,
      effort: sidecar?.effort ?? null,
      archived: s.archived,
      forkedFrom:
        s.forkedFrom === null
          ? null
          : { sessionId: s.forkedFrom.sessionId, point: sidecar?.forkPoint ?? { position: "end" } },
      lastSeq: sidecar?.lastSeq ?? 0,
    };
  }

  async #storedSummary(cwd: string, sessionId: string): Promise<ProtocolSummary> {
    const { snapshot } = await this.store.read(cwd, sessionId);
    const paths = await this.store.paths(cwd, sessionId);
    const sidecar = await readSidecar(paths.dir);
    return {
      id: sessionId,
      title: snapshot.state.title,
      cwd: snapshot.meta.cwd,
      projectDir: sidecar?.projectDir ?? snapshot.meta.cwd,
      createdAt: Date.parse(snapshot.meta.time),
      lastActivityAt: Date.parse(snapshot.lastTime),
      status: sidecar?.lastTurnFailed ? "error" : "idle",
      queuePosition: null,
      mode: snapshot.state.mode ?? "default",
      model: snapshot.state.model,
      effort: snapshot.state.effort,
      archived: snapshot.state.archived,
      forkedFrom:
        snapshot.meta.forkedFrom === null
          ? null
          : {
              sessionId: snapshot.meta.forkedFrom.sessionId,
              point: sidecar?.forkPoint ?? { position: "end" },
            },
      lastSeq: sidecar?.lastSeq ?? 0,
    };
  }

  async #withStoreErrors<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SessionStoreError) {
        if (error.code === "not-found") {
          throw new RuntimeError("SessionNotFound", error.message, { cause: error });
        }
        if (error.code === "locked") {
          throw new RuntimeError("InvalidState", error.message, { cause: error });
        }
      }
      throw error;
    }
  }
}

/** The last parent record a fork copies. */
function forkSeq(
  records: readonly SessionRecord[],
  point: ForkPoint,
  activePromptSeq: number | null,
): number {
  const last = records[records.length - 1]?.seq ?? 0;
  const prompts = promptSeqs(records);
  if (point.position === "end") return activePromptSeq === null ? last : activePromptSeq - 1;
  const seq = promptSeqOf(point.turnId);
  if (seq === null || !prompts.includes(seq)) {
    throw new RuntimeError("InvalidState", `The session has no turn ${point.turnId}.`);
  }
  if (point.position === "beforeTurn") return seq - 1;
  if (seq === activePromptSeq) {
    throw new RuntimeError("InvalidState", `Turn ${point.turnId} is still running.`);
  }
  const next = prompts.find((p) => p > seq);
  return next === undefined ? last : next - 1;
}

async function assertDirectory(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new RuntimeError("InvalidState", `${dir} is not a directory.`);
  }
}

/** The working directory in a transcript's first record, or null when it is not one. */
async function readMetaCwd(file: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  try {
    handle = await openFile(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const line = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    const meta = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    return meta.type === "meta" && typeof meta.cwd === "string" ? meta.cwd : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
