/**
 * Ids and the words Settings → Models shows: labels, context sizes, memory and disk sizes, and
 * the sentences for errors. Plain functions, so they are tested on their own.
 */
import { createHash } from "node:crypto";
import path from "node:path";

/** A model file added by hand: "file:<sha256 of its absolute path>". */
export function fileModelId(filePath: string): string {
  return `file:${sha256(path.resolve(filePath))}`;
}

/** A remote server: "remote:<first 6 hex of the sha256 of its root URL>". */
export function remoteServerId(baseUrl: string): string {
  return `remote:${sha256(baseUrl).slice(0, 6)}`;
}

/** A server's model: "<server id>/<the server's name for it>". */
export function serverModelId(serverId: string, model: string): string {
  return `${serverId}/${model}`;
}

/** Splits "<server id>/<model>" when the prefix is one of `serverIds`. */
export function splitServerModelId(
  modelId: string,
  serverIds: Iterable<string>,
): { serverId: string; model: string } | null {
  for (const serverId of serverIds) {
    const prefix = `${serverId}/`;
    if (modelId.startsWith(prefix) && modelId.length > prefix.length) {
      return { serverId, model: modelId.slice(prefix.length) };
    }
  }
  return null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** "Qwen3.8 27B (8-bit)" → "Qwen3.8 27B · 8-bit". */
export function shortLabelFor(displayName: string): string {
  const match = /^(.*\S)\s*\(([^)]+)\)\s*$/.exec(displayName);
  return match ? `${match[1]} · ${match[2]}` : displayName;
}

/** A model file's name without its folder and `.gguf`. */
export function fileLabel(filePath: string): string {
  return path.basename(filePath).replace(/\.gguf$/i, "");
}

/** 131072 → "128K", 204800 → "200K", 40000 → "39.1K", 900 → "900". */
export function formatContext(tokens: number): string {
  if (tokens < 1024) return String(tokens);
  const k = tokens / 1024;
  return `${Number.isInteger(k) ? k : Number(k.toFixed(1))}K`;
}

/** Memory sizes the way macOS shows them: 68719476736 → "64 GB". */
export function formatMemory(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb >= 10 ? Math.round(gb) : Number(gb.toFixed(1))} GB`;
}

/** Disk sizes the way Finder shows them (powers of 1000): 29_600_000_000 → "29.6 GB". */
export function formatDisk(bytes: number): string {
  if (bytes < 1e9) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${Number((bytes / 1e9).toFixed(1))} GB`;
}

/** For display: a URL without credentials, query or `/v1`: "http://localhost:11434". */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/v1\/?$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "(invalid address)";
  }
}

/** "localhost:11434", for one-line descriptions. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
