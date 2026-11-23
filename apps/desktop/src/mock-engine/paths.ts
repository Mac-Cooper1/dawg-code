/**
 * Fixtures write paths under the home directory as "~/...", so they stay portable; the engine
 * expands them to absolute paths, as the protocol requires.
 */

/**
 * "~/" expands where a path can begin: at the start of a string, after whitespace or an opening
 * bracket or quote, or after "file://". That covers whole paths ("~/code/tally") and paths inside
 * tool output and messages ("Edited ~/code/tally/money.py.") without touching a "~/" in the
 * middle of a word.
 */
const HOME_PATH = /(^|[\s([{"'`=]|file:\/\/)~\//g;

export function expandHomeText(text: string, homeDir: string): string {
  if (!text.includes("~/")) return text;
  const home = homeDir.replace(/\/+$/, "");
  return text.replace(HOME_PATH, (_match, before: string) => `${before}${home}/`);
}

/** Expands "~/" in every string of a JSON-like value. Returns a new value; the input is kept. */
export function expandHome<T>(value: T, homeDir: string): T {
  return walk(value, homeDir) as T;
}

function walk(value: unknown, homeDir: string): unknown {
  if (typeof value === "string") return expandHomeText(value, homeDir);
  if (Array.isArray(value)) return value.map((item) => walk(item, homeDir));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, homeDir);
    return out;
  }
  return value;
}
