/**
 * Shared JSON files in the data root. `settings.json` and `state.json` are read by other parts of
 * dawg too (the engine reads settings.json), so the app owns only its own keys: every write is a
 * read-modify-write that keeps every other key, done atomically (temp file, then rename) so a
 * reader never sees half a file, and never over a file that could not be parsed, so a typo made
 * by hand is not silently replaced by defaults.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type JsonObject = Record<string, unknown>;

export type ReadResult =
  | { kind: "missing" }
  | { kind: "ok"; value: JsonObject }
  | { kind: "unreadable"; reason: string };

export type Logger = (message: string) => void;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a file holding one JSON object. A missing or blank file is "missing" (nothing to keep);
 * anything that is not a JSON object, or cannot be read at all, is "unreadable".
 */
export async function readJsonObject(file: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: messageOf(error) };
  }
  if (text.trim() === "") return { kind: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: "unreadable", reason: `Invalid JSON: ${messageOf(error)}` };
  }
  if (!isJsonObject(value)) return { kind: "unreadable", reason: "The file is not a JSON object" };
  return { kind: "ok", value };
}

/** Writes JSON to a temp file next to `file`, then renames it over `file`. Creates the folder. */
export async function writeJsonAtomic(file: string, value: JsonObject): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export interface JsonFile {
  readonly path: string;
  read(): Promise<ReadResult>;
  /**
   * Reads the file, applies `change` to its object (an empty one when the file is missing) and
   * writes the result. Writes are queued, so two updates never interleave. Resolves to false,
   * without writing, when the file exists but could not be parsed.
   */
  update(change: (current: JsonObject) => JsonObject): Promise<boolean>;
}

export function createJsonFile(file: string, log: Logger): JsonFile {
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  return {
    path: file,
    read: () => readJsonObject(file),
    update(change) {
      return serialize(async () => {
        const current = await readJsonObject(file);
        if (current.kind === "unreadable") {
          log(`Not saving ${file}: it could not be read (${current.reason}). Fix or remove it.`);
          return false;
        }
        const next = change(current.kind === "ok" ? current.value : {});
        await writeJsonAtomic(file, next);
        return true;
      });
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
