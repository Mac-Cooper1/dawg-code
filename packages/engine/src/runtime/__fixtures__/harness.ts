/**
 * A whole engine against the scripted mock model, in a temporary directory: a project folder, a
 * home folder and a store root that are all removed by `close()`. Every event is checked against
 * the protocol schema and for `seq` continuity as it is emitted.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type MockModel, type MockModelOptions, type Script, type ScriptReply, startMockModel } from "@dawg/mock-model";
import { parseEvent } from "@dawg/protocol";
import type { Message } from "../../contracts/index.ts";
import { createModelClient } from "../../model/index.ts";
import { Engine } from "../engine.ts";
import type { LoggedEvent } from "../event-log.ts";
import { localDate } from "../known.ts";
import type { EngineOptions, ModelConnection } from "../types.ts";
import { fakeAssembler, fakeCompactor, fakeEstimator, fakeProfile } from "./fakes.ts";

export interface HarnessOptions {
  script?: Script | ScriptReply[];
  mock?: Omit<MockModelOptions, "script">;
  engine?: Partial<EngineOptions>;
  /** Files to create in the project folder, by relative path. */
  files?: Record<string, string>;
  /** Slots the model provider hands out. */
  slots?: { main: number; utility: number };
  /**
   * Slot pools the model provider hands out, the same objects to every session, as on the bundled
   * runtime: conversation requests then wait for a free slot. Takes the place of `slots`.
   */
  pools?: { conversation: readonly number[]; utility?: readonly number[] };
}

export interface Harness {
  root: string;
  project: string;
  home: string;
  storeRoot: string;
  mock: MockModel;
  engine: Engine;
  events: LoggedEvent[];
  /** Problems found in emitted events (schema or numbering). Empty when all is well. */
  problems: string[];
  /** Names of a session's events, streaming ones left out unless asked for. */
  names(sessionId: string, options?: { streaming?: boolean }): string[];
  ofType<E extends LoggedEvent["event"]>(sessionId: string, event: E): LoggedEvent[];
  /** Resolves with the first event (already emitted or still to come) that matches. */
  waitFor(match: (e: LoggedEvent) => boolean, timeoutMs?: number): Promise<LoggedEvent>;
  /** A further engine on the same store, home and mock (as after a restart). */
  newEngine(overrides?: Partial<EngineOptions>): Engine;
  /** Moves the engines' clock forward. */
  advanceClock(ms: number): void;
  close(): Promise<void>;
}

const STREAMING = new Set(["message.delta", "reasoning.delta", "tool.progress", "prompt.progress"]);

export const BASE_TIME = new Date(2026, 10, 20, 9, 0, 0).getTime();

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-runtime-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const storeRoot = path.join(root, "store");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const file = path.join(project, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const mock = await startMockModel({ ...options.mock, script: options.script ?? [] });
  const started = Date.now();
  let offset = 0;
  const clock = () => BASE_TIME + (Date.now() - started) + offset;
  let idCounter = 0;
  const events: LoggedEvent[] = [];
  const problems: string[] = [];
  const lastSeq = new Map<string, number>();
  const engines: Engine[] = [];
  const pools =
    options.pools === undefined
      ? null
      : {
          conversation: { slots: options.pools.conversation },
          utility:
            options.pools.utility === undefined ? null : { slots: options.pools.utility },
        };

  const makeEngine = (overrides: Partial<EngineOptions> = {}): Engine => {
    const client = createModelClient(mock.endpoint);
    const connection: ModelConnection =
      pools !== null
        ? {
            client,
            pool: pools.conversation,
            ...(pools.utility === null ? {} : { utility: { client, pool: pools.utility } }),
          }
        : options.slots === undefined
          ? { client }
          : { client, slot: options.slots.main, utility: { client, slot: options.slots.utility } };
    const engine = new Engine({
      storeRoot,
      homeDir: home,
      models: { connect: async () => connection },
      assembler: fakeAssembler,
      compactor: fakeCompactor(),
      estimator: fakeEstimator,
      profile: fakeProfile,
      generateTitles: false,
      durability: "none",
      clock,
      newId: (kind) => {
        idCounter += 1;
        return `${kind}-${idCounter}`;
      },
      environment: async (input) => ({
        cwd: input.cwd,
        additionalDirectories: [...input.additionalDirectories],
        platform: "darwin",
        osVersion: "macOS test",
        shell: "bash",
        date: localDate(input.now),
        git: null,
      }),
      // Subagents' tools change every prefix; tests that use them ask for them.
      subagents: false,
      ...options.engine,
      ...overrides,
      limits: { retryDelayMs: 0, ...options.engine?.limits, ...overrides.limits },
    });
    engine.subscribe((event) => {
      events.push(event);
      const parsed = parseEvent(event.event, JSON.parse(JSON.stringify(event.payload)));
      if (!parsed.ok) {
        problems.push(
          `${event.event} #${event.payload.seq} does not match the protocol: ${
            parsed.reason === "invalid" ? parsed.error.message : "unknown event"
          }`,
        );
      }
      const id = event.payload.sessionId;
      const previous = lastSeq.get(id);
      if (previous !== undefined && event.payload.seq !== previous + 1) {
        problems.push(`${id}: seq ${event.payload.seq} after ${previous}`);
      }
      lastSeq.set(id, event.payload.seq);
    });
    engines.push(engine);
    return engine;
  };

  const engine = makeEngine();
  const ofSession = (sessionId: string) =>
    events.filter((e) => e.payload.sessionId === sessionId);

  return {
    root,
    project,
    home,
    storeRoot,
    mock,
    engine,
    events,
    problems,
    names: (sessionId, opts = {}) =>
      ofSession(sessionId)
        .filter((e) => opts.streaming === true || !STREAMING.has(e.event))
        .map((e) => e.event),
    ofType: (sessionId, event) => ofSession(sessionId).filter((e) => e.event === event),
    waitFor: (match, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const found = events.find(match);
        if (found !== undefined) {
          resolve(found);
          return;
        }
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("timed out waiting for an event"));
        }, timeoutMs);
        const poll = setInterval(() => {
          const hit = events.find(match);
          if (hit !== undefined) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve(hit);
          }
        }, 5);
      }),
    newEngine: makeEngine,
    advanceClock: (ms) => {
      offset += ms;
    },
    close: async () => {
      for (const e of engines) await e.close().catch(() => {});
      await mock.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Every tool call has exactly one result, after it and before the next assistant message. */
export function historyProblems(view: readonly Message[]): string[] {
  const problems: string[] = [];
  let open = new Set<string>();
  for (const m of view) {
    if (m.role === "assistant") {
      if (open.size > 0) problems.push(`calls without results: ${[...open].join(", ")}`);
      open = new Set(m.toolCalls.map((c) => c.id));
    } else if (m.role === "tool") {
      if (!open.has(m.toolCallId)) problems.push(`result without its call: ${m.toolCallId}`);
      open.delete(m.toolCallId);
    } else if (open.size > 0) {
      problems.push(`a ${m.role} message between calls and their results`);
    }
  }
  if (open.size > 0) problems.push(`calls without results: ${[...open].join(", ")}`);
  return problems;
}

/** The text of a message's text parts. */
export function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  if (message.role === "system" || message.role === "assistant") return message.content;
  return message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}
