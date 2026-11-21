/**
 * An engine against the scripted mock model, served by `createEngineHost` over memory
 * transports, in a temporary directory removed by `close()`. Every event a client receives is
 * checked against the protocol schema (the client drops and reports invalid ones) and for `seq`
 * continuity per session.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type MockModel,
  type MockModelOptions,
  type Script,
  type ScriptReply,
  startMockModel,
} from "@dawg/mock-model";
import {
  type Client,
  type ClientCapabilities,
  createClient,
  createMemoryTransportPair,
  type EngineEvent,
} from "@dawg/protocol";
import { createModelClient } from "../../model/index.ts";
import {
  fakeAssembler,
  fakeCompactor,
  fakeEstimator,
  fakeProfile,
} from "../../runtime/__fixtures__/fakes.ts";
import { Engine } from "../../runtime/engine.ts";
import { localDate } from "../../runtime/known.ts";
import type { EngineOptions } from "../../runtime/types.ts";
import { createEngineHost, type EngineHost, type EngineHostOptions } from "../host.ts";

export interface Connection {
  client: Client;
  host: EngineHost;
  events: EngineEvent[];
  /** Problems the client reported: events that failed the schema, and the like. */
  problems: string[];
  /** Resolves with the first event (received or still to come) that matches. */
  waitFor(match: (e: EngineEvent) => boolean, timeoutMs?: number): Promise<EngineEvent>;
  /** Events of one session, by name, streaming ones left out. */
  names(sessionId: string): string[];
}

export interface Setup {
  root: string;
  project: string;
  home: string;
  storeRoot: string;
  mock: MockModel;
  engine: Engine;
  /** Opens a connection to the engine and initialises it. */
  connect(options?: {
    capabilities?: Partial<ClientCapabilities>;
    host?: EngineHostOptions;
  }): Promise<Connection>;
  close(): Promise<void>;
}

const STREAMING = new Set(["message.delta", "reasoning.delta", "tool.progress", "prompt.progress"]);

export async function setup(
  options: {
    script?: Script | ScriptReply[];
    mock?: Omit<MockModelOptions, "script">;
    engine?: Partial<EngineOptions>;
    files?: Record<string, string>;
  } = {},
): Promise<Setup> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-host-"));
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
  const client = createModelClient(mock.endpoint);
  let ids = 0;
  const engine = new Engine({
    storeRoot,
    homeDir: home,
    models: { connect: async () => ({ client }) },
    assembler: fakeAssembler,
    compactor: fakeCompactor(),
    estimator: fakeEstimator,
    profile: fakeProfile,
    generateTitles: false,
    durability: "none",
    newId: (kind) => {
      ids += 1;
      return `${kind}-${ids}`;
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
    ...options.engine,
    limits: { retryDelayMs: 0, ...options.engine?.limits },
  });
  const connections: Connection[] = [];

  async function connect(
    opts: { capabilities?: Partial<ClientCapabilities>; host?: EngineHostOptions } = {},
  ): Promise<Connection> {
    const [clientEnd, engineEnd] = createMemoryTransportPair();
    const host = createEngineHost(engine, engineEnd, {
      homeDir: home,
      detachGraceMs: 0,
      ...opts.host,
    });
    const events: EngineEvent[] = [];
    const problems: string[] = [];
    const lastSeq = new Map<string, number>();
    const rpc = createClient(clientEnd, {
      timeoutMs: 10_000,
      onProblem: (p) => problems.push(`${p.kind}: ${p.message}`),
    });
    rpc.onEvent((event) => {
      const id = event.payload.sessionId;
      const previous = lastSeq.get(id);
      if (previous !== undefined && event.payload.seq !== previous + 1) {
        problems.push(`${id}: seq ${event.payload.seq} after ${previous}`);
      }
      lastSeq.set(id, event.payload.seq);
      events.push(event);
    });
    await rpc.initialize({
      client: { name: "test", version: "1.0.0" },
      capabilities: { permissionPrompts: true, questions: true, planApproval: true, ...opts.capabilities },
    });
    const connection: Connection = {
      client: rpc,
      host,
      events,
      problems,
      names: (sessionId) =>
        events
          .filter((e) => e.payload.sessionId === sessionId && !STREAMING.has(e.event))
          .map((e) => e.event),
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
    };
    connections.push(connection);
    return connection;
  }

  return {
    root,
    project,
    home,
    storeRoot,
    mock,
    engine,
    connect,
    close: async () => {
      for (const c of connections) c.client.close();
      await Promise.all(connections.map((c) => c.host.done));
      await engine.close().catch(() => {});
      await mock.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export const ask = (text: string) => ({ content: [{ type: "text" as const, text }] });
