/**
 * The Glob tool: file paths matching a pattern, newest first.
 *
 * As documented for Claude Code, matches include hidden files and files that .gitignore
 * excludes. Version-control metadata directories (.git and friends) are skipped unless the
 * pattern names one, since their contents are never what a search for project files wants.
 */
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SearchDisplay } from "@dawg/protocol";
import picomatch from "picomatch";
import type { PermissionSubject } from "../../contracts/permissions.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolOutput,
  ToolProbeContext,
} from "../../contracts/tools.ts";

export interface GlobInput {
  pattern: string;
  path?: string;
}

const VCS_DIRS = new Set([".git", ".hg", ".svn", ".jj", ".bzr", "_darcs"]);
const WALK_CONCURRENCY = 16;

const DESCRIPTION = `Find files by name using a glob pattern. Returns absolute paths, most recently modified first.

- Patterns are matched against paths relative to the search directory: "**/*.ts" finds TypeScript files at any depth, "src/**/*.test.js" finds test files under src, and "*.{json,yaml}" finds JSON and YAML files in the search directory itself.
- Hidden files and files ignored by .gitignore are included. Version-control folders such as .git are skipped unless the pattern names them.
- Only files are listed, not directories. Results are capped; when the list is cut, narrow the pattern or the path.
- To search inside files, use Grep instead.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: 'The glob pattern to match, for example "**/*.py" or "src/components/*.tsx".',
    },
    path: {
      type: "string",
      description:
        "The directory to search in. Defaults to the working directory. Omit it rather than passing an empty value.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

interface GlobPlan {
  /** The directory the walk starts from (absolute). */
  root: string;
  /** The part of the pattern matched below `root`; empty for a literal path. */
  glob: string;
  /** Set when the pattern has no wildcards: the one path it names. */
  literal: string | null;
}

/** Splits the pattern into the fixed directory it starts from and the wildcard part. */
export function planGlob(input: GlobInput, cwd: string): GlobPlan {
  const searchRoot = path.resolve(cwd, input.path?.trim() ? input.path : ".");
  const pattern = input.pattern.trim();
  const scan = picomatch.scan(pattern);
  if (!scan.isGlob) {
    return { root: searchRoot, glob: "", literal: path.resolve(searchRoot, pattern) };
  }
  // The fixed leading directories narrow the walk, and may leave the search root
  // (an absolute pattern, or one starting with "..").
  const root = scan.base ? path.resolve(searchRoot, scan.base) : searchRoot;
  return { root, glob: scan.glob, literal: null };
}

interface Match {
  path: string;
  mtimeMs: number;
}

export const globTool: ToolDefinition<GlobInput> = {
  name: "Glob",
  description: DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  readOnly: true,

  permission(input: GlobInput, ctx: ToolProbeContext): PermissionSubject {
    const plan = planGlob(input, ctx.cwd);
    return { kind: "read", paths: [plan.literal ?? plan.root] };
  },

  async execute(input: GlobInput, ctx: ToolContext): Promise<ToolOutput> {
    if (input.pattern.includes("\0") || input.path?.includes("\0")) {
      return errorOutput(
        "The pattern and path must not contain a null byte. Remove it and try again.",
      );
    }
    if (!input.pattern.trim()) return errorOutput("The pattern is empty.");
    const plan = planGlob(input, ctx.cwd);
    const searchRoot = path.resolve(ctx.cwd, input.path?.trim() ? input.path : ".");
    const rootInfo = await stat(searchRoot).catch(() => null);
    if (!rootInfo) return errorOutput(`The directory ${searchRoot} does not exist.`);
    if (!rootInfo.isDirectory()) return errorOutput(`${searchRoot} is not a directory.`);

    const display = (count: number, truncated: boolean): SearchDisplay => ({
      kind: "search",
      pattern: input.pattern,
      resultCount: count,
      truncated,
    });

    // Files a deny rule forbids reading are left out silently, as if they did not exist.
    const denied = ctx.readDenied;
    if (plan.literal !== null) {
      const info = await stat(plan.literal).catch(() => null);
      if (!info?.isFile() || denied?.(plan.literal)) {
        return {
          content: [{ type: "text", text: `No files found matching ${input.pattern}.` }],
          display: display(0, false),
        };
      }
      return { content: [{ type: "text", text: plan.literal }], display: display(1, false) };
    }

    const limit = Math.max(1, ctx.limits.globMaxResults);
    const timeLimitMs = ctx.limits.searchTimeoutMs;
    const result = await walk(plan, {
      limit,
      signal: ctx.signal,
      timeLimitMs,
      denied,
      status: (message) => ctx.progress({ kind: "status", message }),
    });
    if (result.total === 0) {
      const text = result.timedOut
        ? `No files found matching ${input.pattern} before the search stopped after ${seconds(timeLimitMs)}. Narrow the path or pattern.`
        : `No files found matching ${input.pattern}.`;
      return { content: [{ type: "text", text }], display: display(0, result.timedOut) };
    }

    const lines = result.top.map((m) => m.path);
    const notes: string[] = [];
    const truncated = result.total > lines.length;
    if (truncated) {
      notes.push(
        `Showing the ${lines.length} most recently modified of ${result.total} matching files. Narrow the pattern or path to see the others.`,
      );
    }
    if (result.timedOut) {
      notes.push(
        `The search stopped after ${seconds(timeLimitMs)}, so these results may be incomplete. Narrow the path or pattern.`,
      );
    }
    const text = notes.length > 0 ? `${lines.join("\n")}\n\n${notes.join("\n")}` : lines.join("\n");
    return {
      content: [{ type: "text", text }],
      display: display(result.total, truncated || result.timedOut),
    };
  },
};

interface WalkResult {
  top: Match[];
  total: number;
  timedOut: boolean;
}

async function walk(
  plan: GlobPlan,
  options: {
    limit: number;
    signal: AbortSignal;
    timeLimitMs: number;
    denied: ((absolutePath: string) => boolean) | undefined;
    status: (message: string) => void;
  },
): Promise<WalkResult> {
  const { limit, signal, timeLimitMs, denied, status } = options;
  const matcher = picomatch(plan.glob, { dot: true });
  const segments = plan.glob.split("/");
  // Without "**" a pattern can only match at a fixed depth, so the walk need not go deeper.
  const maxDepth = segments.some((s) => s.includes("**"))
    ? Number.POSITIVE_INFINITY
    : segments.length;
  const namedVcs = new Set(segments.filter((s) => VCS_DIRS.has(s)));
  const deadline = Date.now() + timeLimitMs;

  let top: Match[] = [];
  let total = 0;
  let timedOut = false;
  let scanned = 0;
  let lastStatus = Date.now();
  const queue: { dir: string; rel: string; depth: number }[] = [
    { dir: plan.root, rel: "", depth: 1 },
  ];

  const consider = (match: Match) => {
    total += 1;
    top.push(match);
    if (top.length >= limit * 4) top = sortMatches(top).slice(0, limit);
  };

  const visit = async (item: { dir: string; rel: string; depth: number }) => {
    let entries: Dirent[];
    try {
      entries = await readdir(item.dir, { withFileTypes: true });
    } catch {
      return; // Unreadable or vanished directories are skipped.
    }
    scanned += 1;
    for (const entry of entries) {
      const rel = item.rel ? `${item.rel}/${entry.name}` : entry.name;
      const full = path.join(item.dir, entry.name);
      if (entry.isDirectory()) {
        if (item.depth >= maxDepth) continue;
        if (VCS_DIRS.has(entry.name) && !namedVcs.has(entry.name)) continue;
        queue.push({ dir: full, rel, depth: item.depth + 1 });
        continue;
      }
      if (!matcher(rel) || denied?.(full)) continue;
      let info: Stats | null = null;
      if (entry.isSymbolicLink()) {
        info = await stat(full).catch(() => null);
        if (info?.isDirectory()) continue;
        info ??= await lstat(full).catch(() => null);
      } else {
        info = await lstat(full).catch(() => null);
      }
      if (info) consider({ path: full, mtimeMs: info.mtimeMs });
    }
  };

  const active = new Set<Promise<void>>();
  while (queue.length > 0 || active.size > 0) {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    while (queue.length > 0 && active.size < WALK_CONCURRENCY) {
      const item = queue.shift();
      if (!item) break;
      const job = visit(item).finally(() => active.delete(job));
      active.add(job);
    }
    if (active.size > 0) await Promise.race(active);
    if (Date.now() - lastStatus > 1000) {
      lastStatus = Date.now();
      status(`Searched ${scanned} directories`);
    }
  }
  if (timedOut) await Promise.allSettled(active);
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return { top: sortMatches(top).slice(0, limit), total, timedOut };
}

/** Newest first; ties broken by path so the order is stable. */
function sortMatches(matches: Match[]): Match[] {
  return matches.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

function errorOutput(message: string): ToolOutput {
  return { content: [{ type: "text", text: message }], isError: true };
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} seconds`;
}
