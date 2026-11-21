import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { expandHome, isWithin } from "../internal/paths.ts";
import { findImports, importableLines, normaliseText, stripBlockComments } from "./markdown.ts";
import type { InstructionProblem } from "./types.ts";

/**
 * Claude Code skips an instruction file over 4 MiB entirely rather than loading part of it. We do
 * the same and report it, so nothing is cut silently.
 */
export const MAX_INSTRUCTION_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The documented limit is four hops of `@path` imports below the file being loaded: five files
 * deep counting that file.
 */
export const MAX_IMPORT_HOPS = 4;

/** Shared state for reading the files of one instruction set. */
export interface ReadContext {
  homeDir: string;
  /** Real paths of the roots inside which an import is internal. */
  internalRoots: readonly string[];
  allowExternal: boolean;
  problems: InstructionProblem[];
  externalFiles: Set<string>;
}

export type ReadOutcome =
  | { ok: true; text: string; real: string }
  | { ok: false; reason: "missing" | "unreadable" | "too-large"; detail: string };

/** Reads one file as normalised text, refusing directories and files over the size limit. */
export async function readTextFile(path: string): Promise<ReadOutcome> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { ok: false, reason: "missing", detail: "not found" };
  }
  try {
    const info = await stat(real);
    if (!info.isFile()) return { ok: false, reason: "missing", detail: "not a regular file" };
    if (info.size > MAX_INSTRUCTION_FILE_BYTES) {
      return {
        ok: false,
        reason: "too-large",
        detail: `${info.size} bytes is over the ${MAX_INSTRUCTION_FILE_BYTES}-byte limit; skipped`,
      };
    }
    return { ok: true, text: normaliseText(await readFile(real, "utf8")), real };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "unreadable", detail };
  }
}

export function isInternal(real: string, ctx: ReadContext): boolean {
  return ctx.internalRoots.some((root) => isWithin(real, root));
}

/** Escapes a value for an attribute in the markers we write around imported text. */
export function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Strips punctuation that often follows a reference in prose, as in "see @README." */
function withoutTrailingPunctuation(p: string): string | null {
  const trimmed = p.replace(/[.,;:!?)\]]+$/, "");
  return trimmed !== p && trimmed !== "" ? trimmed : null;
}

interface ExpandState {
  /** Real paths of the files on the current import chain, for cycle detection. */
  chain: string[];
  /** Real paths already expanded somewhere in this top-level file. */
  done: Set<string>;
  imports: string[];
  /** Whether this file tree belongs to the user (may import anything). */
  trusted: boolean;
  /** The top-level file, named in problems. */
  root: string;
}

async function resolveImport(
  written: string,
  fromDir: string,
  ctx: ReadContext,
): Promise<{ abs: string; outcome: ReadOutcome }> {
  const candidates = [written];
  const alt = withoutTrailingPunctuation(written);
  if (alt) candidates.push(alt);
  let first: { abs: string; outcome: ReadOutcome } | null = null;
  for (const candidate of candidates) {
    const expanded = expandHome(candidate, ctx.homeDir);
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(fromDir, expanded);
    const outcome = await readTextFile(abs);
    if (outcome.ok || outcome.reason !== "missing") return { abs, outcome };
    first ??= { abs, outcome };
  }
  // `first` is always set: there is at least one candidate.
  return first as { abs: string; outcome: ReadOutcome };
}

async function expand(
  text: string,
  fileDir: string,
  hops: number,
  ctx: ReadContext,
  state: ExpandState,
): Promise<string> {
  const stripped = stripBlockComments(text);
  const { lines, fenced } = importableLines(stripped);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    out.push(line);
    if (fenced[i]) continue;
    for (const token of findImports(line)) {
      const { abs, outcome } = await resolveImport(token.path, fileDir, ctx);
      if (!outcome.ok) {
        // A reference to something that is not a file (a package name, a handle) is common in
        // prose, so a missing target is noted but never shown to the model.
        ctx.problems.push({
          kind: outcome.reason === "missing" ? "missing-import" : outcome.reason,
          path: state.root,
          target: abs,
          message: `Import @${token.path} skipped: ${outcome.detail}.`,
        });
        continue;
      }
      const real = outcome.real;
      if (state.chain.includes(real)) {
        ctx.problems.push({
          kind: "import-cycle",
          path: state.root,
          target: abs,
          message: `Import @${token.path} skipped: it would import itself.`,
        });
        continue;
      }
      if (state.done.has(real)) continue;
      if (hops + 1 > MAX_IMPORT_HOPS) {
        ctx.problems.push({
          kind: "import-too-deep",
          path: state.root,
          target: abs,
          message: `Import @${token.path} skipped: more than ${MAX_IMPORT_HOPS} levels of imports.`,
        });
        continue;
      }
      if (!state.trusted && !isInternal(real, ctx) && !ctx.allowExternal) {
        ctx.externalFiles.add(real);
        ctx.problems.push({
          kind: "external-import",
          path: state.root,
          target: real,
          message: `Import @${token.path} skipped: it is outside the project and external imports are not approved.`,
        });
        continue;
      }
      state.done.add(real);
      state.imports.push(abs);
      state.chain.push(real);
      const body = await expand(outcome.text, dirname(abs), hops + 1, ctx, state);
      state.chain.pop();
      out.push(`<import source="${attr(abs)}">`, body.replace(/\n+$/, ""), "</import>");
    }
  }
  return out.join("\n");
}

/**
 * Expands `@path` imports in the text of one top-level instruction file. Each imported file is
 * placed right after the line that names it, wrapped in `<import>` markers, so the reference keeps
 * its place in the prose and the model can tell where the imported text came from.
 */
export async function expandImports(
  text: string,
  file: { path: string; real: string; trusted: boolean },
  ctx: ReadContext,
): Promise<{ content: string; imports: string[] }> {
  const state: ExpandState = {
    chain: [file.real],
    done: new Set([file.real]),
    imports: [],
    trusted: file.trusted,
    root: file.path,
  };
  const content = await expand(text, dirname(file.path), 0, ctx, state);
  return { content, imports: state.imports };
}
