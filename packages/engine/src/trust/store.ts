/**
 * The trust store: the person's consent for the code a setup supplies, and their on/off switch
 * for single hooks, kept in the engine's data root (`<storeRoot>/trust.json`), never in a
 * `.claude` folder or a file a project commits.
 *
 *   {
 *     "version": 1,
 *     "user":     { "approved": ["sha256:…"], "off": ["sha256:…"] },
 *     "projects": { "/abs/project": { "approved": [...], "off": [...] } }
 *   }
 *
 * Consent is per definition (definitions.ts): Claude Code's user hooks are approved once for
 * every project, a project's hooks and MCP servers for that project. A setup counts as approved
 * when every definition in it is; removing one changes nothing, adding or changing one asks again.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodeApproval, CompatSource } from "@dawg/protocol";
import {
  approvalHash,
  collectDefinitions,
  definitionsIn,
  needsConsent,
  type TrustDefinition,
} from "./definitions.ts";
import type { CodeTrust, HookSwitches } from "./index.ts";

export const TRUST_FILE = "trust.json";

interface Scope {
  approved: string[];
  off: string[];
}

interface TrustFile {
  version: 1;
  user: Scope;
  projects: Record<string, Scope>;
}

export interface TrustStoreOptions {
  /** The engine's data root (`~/.dawg`), absolute. */
  storeRoot: string;
  /** The person's home, absolute: `~/.claude/settings.json` and `~/.dawg/settings.json`. */
  homeDir: string;
}

export class TrustError extends Error {
  override name = "TrustError";
}

function emptyScope(): Scope {
  return { approved: [], off: [] };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function readScope(value: unknown): Scope {
  if (value === null || typeof value !== "object") return emptyScope();
  const v = value as Record<string, unknown>;
  return { approved: strings(v.approved), off: strings(v.off) };
}

/** A store that keeps its file in `storeRoot`. Writes are atomic and made one at a time. */
export class TrustStore implements CodeTrust {
  readonly file: string;
  readonly #homeDir: string;
  /** Read-modify-write steps run one after another, so two decisions never lose one. */
  #queue: Promise<unknown> = Promise.resolve();

  readonly switches: HookSwitches;

  constructor(options: TrustStoreOptions) {
    this.file = path.join(path.resolve(options.storeRoot), TRUST_FILE);
    this.#homeDir = path.resolve(options.homeDir);
    this.switches = {
      off: async (projectDir) => {
        const data = await this.#read();
        const project = projectDir === null ? null : data.projects[path.resolve(projectDir)];
        return new Set([...data.user.off, ...(project?.off ?? [])]);
      },
      set: async ({ projectDir, id, scope, enabled }) => {
        await this.#update((data) => {
          const target =
            scope === "user" || projectDir === null ? data.user : projectScope(data, projectDir);
          const off = new Set(target.off);
          if (enabled) off.delete(id);
          else off.add(id);
          target.off = [...off].sort();
        });
      },
    };
  }

  async approval(projectDir: string | null): Promise<CodeApproval | null> {
    const dir = projectDir === null ? null : path.resolve(projectDir);
    const definitions = await collectDefinitions({ projectDir: dir, homeDir: this.#homeDir });
    if (definitions.length === 0) return null;
    const data = await this.#read();
    const approvedSet = approvedFor(data, dir);
    const items = definitions.map((d) => ({
      ...d.item,
      status: approvedSet(d) ? ("loaded" as const) : ("needs-approval" as const),
    }));
    return {
      hash: approvalHash(definitions),
      approved: definitions.every(approvedSet),
      items,
    };
  }

  async decide(projectDir: string, hash: string, approved: boolean): Promise<boolean> {
    const dir = path.resolve(projectDir);
    const definitions = await collectDefinitions({ projectDir: dir, homeDir: this.#homeDir });
    if (definitions.length === 0) {
      throw new TrustError("Nothing in this project needs approval any more.");
    }
    if (approvalHash(definitions) !== hash) {
      throw new TrustError(
        "The project's hooks or MCP servers changed since they were shown, so nothing was approved. Review them again.",
      );
    }
    await this.#update((data) => {
      const project = projectScope(data, dir);
      for (const [scope, defs] of [
        [data.user, definitions.filter((d) => d.scope === "user")],
        [project, definitions.filter((d) => d.scope === "project")],
      ] as const) {
        const set = new Set(scope.approved);
        for (const d of defs) {
          if (approved) set.add(d.hash);
          else set.delete(d.hash);
        }
        scope.approved = [...set].sort();
      }
      // The project's list holds only what it defines now: an old definition is not approved
      // again by reverting to it unseen.
      if (approved)
        project.approved = definitions
          .filter((d) => d.scope === "project")
          .map((d) => d.hash)
          .sort();
    });
    return approved;
  }

  async allows(source: CompatSource, projectDir: string | null): Promise<boolean> {
    if (!needsConsent(source)) return true;
    const dir = projectDir === null ? null : path.resolve(projectDir);
    const [inFile, data] = await Promise.all([definitionsIn(source), this.#read()]);
    const scope = source.scope === "user" ? data.user : dir === null ? null : data.projects[dir];
    if (scope === undefined || scope === null) return inFile.size === 0;
    const approved = new Set(scope.approved);
    for (const hash of inFile) if (!approved.has(hash)) return false;
    return true;
  }

  async #read(): Promise<TrustFile> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      // Missing, or damaged: nothing is approved, which is the safe reading.
      return { version: 1, user: emptyScope(), projects: {} };
    }
    const value = (raw ?? {}) as Record<string, unknown>;
    const projects: Record<string, Scope> = {};
    if (value.projects !== null && typeof value.projects === "object") {
      for (const [dir, scope] of Object.entries(value.projects as Record<string, unknown>)) {
        projects[dir] = readScope(scope);
      }
    }
    return { version: 1, user: readScope(value.user), projects };
  }

  #update(change: (data: TrustFile) => void): Promise<void> {
    const step = this.#queue.then(async () => {
      const data = await this.#read();
      change(data);
      for (const [dir, scope] of Object.entries(data.projects)) {
        if (scope.approved.length === 0 && scope.off.length === 0) delete data.projects[dir];
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, this.file);
    });
    this.#queue = step.catch(() => {});
    return step;
  }
}

function projectScope(data: TrustFile, projectDir: string): Scope {
  const dir = path.resolve(projectDir);
  data.projects[dir] ??= emptyScope();
  return data.projects[dir];
}

/** Whether one definition has consent, for a setup in `projectDir`. */
function approvedFor(data: TrustFile, projectDir: string | null) {
  const user = new Set(data.user.approved);
  const project = new Set(projectDir === null ? [] : (data.projects[projectDir]?.approved ?? []));
  return (d: TrustDefinition) => (d.scope === "user" ? user : project).has(d.hash);
}

/** The trust store an engine uses for real: consent in `<storeRoot>/trust.json`. */
export function createTrustStore(options: TrustStoreOptions): TrustStore {
  return new TrustStore(options);
}
