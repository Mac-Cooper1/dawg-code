/**
 * Small readers the report's providers share: where a setup's folders are, JSON and Markdown
 * files read without ever throwing, and names for people. Everything here only reads.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { CompatSource } from "@dawg/protocol";
import { parse as parseYaml } from "yaml";
import { splitFrontMatter } from "../instructions/markdown.ts";
import { compareCodeUnits, isWithin } from "../internal/paths.ts";
import type { ReportContext } from "./types.ts";

/** Largest file a provider reads, so a stray multi-gigabyte file cannot stall the report. */
export const MAX_REPORT_FILE_BYTES = 64 * 1024 * 1024;

/** One folder of configuration: `~/.claude`, `~/.dawg`, a project's `.claude` or `.dawg`. */
export interface ConfigRoot {
  dir: string;
  origin: CompatSource["origin"];
  scope: "user" | "project";
}

/**
 * The folders a setup keeps its files in, Claude Code's before dawg's within each scope, the
 * person's before the project's. When the project is the home folder, its folders are the
 * person's and are listed once.
 */
export function configRoots(context: ReportContext): ConfigRoot[] {
  const home = resolve(context.homeDir);
  const roots: ConfigRoot[] = [
    { dir: join(home, ".claude"), origin: "claude", scope: "user" },
    { dir: join(home, ".dawg"), origin: "dawg", scope: "user" },
  ];
  if (context.projectDir === null) return roots;
  const project = resolve(context.projectDir);
  if (project === home) return roots;
  roots.push(
    { dir: join(project, ".claude"), origin: "claude", scope: "project" },
    { dir: join(project, ".dawg"), origin: "dawg", scope: "project" },
  );
  return roots;
}

/**
 * How much one definition outranks another of the same name: the project's over the person's,
 * and within one scope dawg's own `.dawg` over Claude Code's `.claude` (spec, principle 1).
 */
export function rootRank(source: Pick<CompatSource, "origin" | "scope">): number {
  const scope = { flags: 4, local: 3, nested: 2, project: 2, user: 1 }[source.scope];
  return scope * 2 + (source.origin === "dawg" ? 1 : 0);
}

export type JsonRead =
  | { kind: "missing" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; data: unknown };

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0]?.trim() ?? text;
}

/** A sentence, with a full stop. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export type TextRead =
  | { kind: "missing" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; text: string };

/** Reads a text file. Missing (or a folder) is not a problem; anything else is a sentence. */
export async function readText(path: string): Promise<TextRead> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { kind: "missing" };
    if (info.size > MAX_REPORT_FILE_BYTES) {
      return {
        kind: "invalid",
        message: `The file is ${info.size} bytes, over the ${MAX_REPORT_FILE_BYTES}-byte limit, so it was not read.`,
      };
    }
    const raw = await readFile(path, "utf8");
    return { kind: "ok", text: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return {
      kind: "invalid",
      message: sentence(`Could not read the file: ${describeError(error)}`),
    };
  }
}

/** Reads a JSON file. An empty file reads as an empty object, as an unfinished file is. */
export async function readJson(path: string): Promise<JsonRead> {
  const read = await readText(path);
  if (read.kind !== "ok") return read;
  if (read.text.trim() === "") return { kind: "ok", data: {} };
  try {
    return { kind: "ok", data: JSON.parse(read.text) };
  } catch (error) {
    return { kind: "invalid", message: sentence(`Not valid JSON: ${describeError(error)}`) };
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `path` is an existing folder. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every file under `dir` whose name ends in `extension`, sorted byte-wise by relative path, so
 * the result never depends on the order the filesystem lists entries in. Follows symbolic links
 * once each. With `recursive` false only the folder itself is read.
 */
export async function listFiles(
  dir: string,
  extension: string,
  options: { recursive: boolean; limit?: number } = { recursive: true },
): Promise<string[]> {
  const limit = options.limit ?? 2000;
  const found: { rel: string; abs: string }[] = [];
  const visited = new Set<string>();

  async function walk(current: string, rel: string): Promise<void> {
    if (found.length >= limit) return;
    let real: string;
    try {
      real = await realpath(current);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names.sort(compareCodeUnits)) {
      if (found.length >= limit) return;
      const abs = join(current, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(abs);
      } catch {
        continue; // A dangling link.
      }
      if (info.isDirectory()) {
        if (options.recursive && !name.startsWith(".")) await walk(abs, childRel);
      } else if (info.isFile() && name.endsWith(extension)) {
        found.push({ rel: childRel, abs });
      }
    }
  }

  await walk(dir, "");
  return found.sort((a, b) => compareCodeUnits(a.rel, b.rel)).map((file) => file.abs);
}

export type FrontMatterRead =
  | { kind: "missing" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; fields: Record<string, unknown> | null; body: string };

/**
 * Reads a Markdown file and its YAML front matter. `fields` is null when the file has none;
 * front matter that is not a YAML mapping is invalid.
 */
export async function readFrontMatter(path: string): Promise<FrontMatterRead> {
  const read = await readText(path);
  if (read.kind !== "ok") return read;
  const text = read.text.replace(/\r\n?/g, "\n");
  const { yaml, body } = splitFrontMatter(text);
  if (yaml === null) return { kind: "ok", fields: null, body };
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (error) {
    return {
      kind: "invalid",
      message: sentence(`The front matter is not valid YAML: ${describeError(error)}`),
    };
  }
  if (data === null || data === undefined) return { kind: "ok", fields: {}, body };
  if (!isPlainObject(data)) {
    return { kind: "invalid", message: "The front matter is not a list of fields." };
  }
  return { kind: "ok", fields: data, body };
}

/** A front-matter field as a non-empty string, or null. */
export function stringField(fields: Record<string, unknown> | null, key: string): string | null {
  const value = fields?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * How a path is named in the report: relative to the project when inside it ("CLAUDE.md",
 * ".claude/agents/review.md"), else from the home folder ("~/.claude/CLAUDE.md"), else in full.
 */
export function displayPath(path: string, context: ReportContext): string {
  const abs = resolve(path);
  const home = resolve(context.homeDir);
  if (context.projectDir !== null) {
    const project = resolve(context.projectDir);
    if (project !== home && isWithin(abs, project) && abs !== project) {
      return relative(project, abs).split(sep).join("/");
    }
  }
  if (isWithin(abs, home)) {
    const rel = relative(home, abs);
    return rel === "" ? "~" : `~/${rel.split(sep).join("/")}`;
  }
  return abs;
}

/** A file's name without its extension: "code-reviewer" for "code-reviewer.md". */
export function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * For definitions where one name means one thing (subagents, MCP servers, output styles): the
 * note on each one another definition of the same name replaces. Returns the notes by index.
 */
export function overriddenNotes(
  entries: readonly { name: string; source: CompatSource }[],
  context: ReportContext,
): Map<number, string> {
  const winners = new Map<string, number>();
  entries.forEach((entry, index) => {
    const best = winners.get(entry.name);
    const bestEntry = best === undefined ? undefined : entries[best];
    if (bestEntry === undefined || rootRank(entry.source) > rootRank(bestEntry.source)) {
      winners.set(entry.name, index);
    }
  });
  const notes = new Map<number, string>();
  entries.forEach((entry, index) => {
    const winner = winners.get(entry.name);
    if (winner === undefined || winner === index) return;
    const by = entries[winner];
    if (by === undefined) return;
    notes.set(
      index,
      `Not used: ${displayPath(by.source.path, context)} defines “${entry.name}” too and takes its place.`,
    );
  });
  return notes;
}
