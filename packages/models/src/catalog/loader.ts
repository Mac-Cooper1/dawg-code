import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Catalog, CatalogSchema, describeIssues } from "./schema.ts";

/** The catalog shipped in this repo (`catalog/catalog.json` at the repo root). */
export const BUNDLED_CATALOG_PATH = fileURLToPath(
  new URL("../../../../catalog/catalog.json", import.meta.url),
);

export type CatalogSource = "remote" | "cache" | "bundled";

export interface LoadCatalogOptions {
  /** The bundled catalog, already parsed. Takes precedence over `bundledPath`. */
  bundled?: unknown;
  /** Where to read the bundled catalog from. Defaults to `BUNDLED_CATALOG_PATH`. */
  bundledPath?: string;
  /** Where a newer catalog is published. No fetch is made when omitted. */
  remoteUrl?: string;
  /** Where the last good fetched copy is kept. Nothing is cached when omitted. */
  cacheFile?: string;
  fetch?: typeof globalThis.fetch;
  /** Whole-request timeout for the remote fetch. Default 10 s. */
  timeoutMs?: number;
  /** Larger responses are rejected. Default 1 MiB. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface LoadedCatalog {
  catalog: Catalog;
  source: CatalogSource;
  /** Why a remote or cached copy was not used. For logs, never shown as an error. */
  problems: string[];
}

export class InvalidCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCatalogError";
  }
}

/** Validates a parsed catalog, throwing `InvalidCatalogError` with readable issues. */
export function parseCatalog(data: unknown, label = "catalog"): Catalog {
  const result = CatalogSchema.safeParse(data);
  if (!result.success) {
    throw new InvalidCatalogError(`${label} is invalid: ${describeIssues(result.error)}`);
  }
  return result.data;
}

type Attempt = { ok: true; catalog: Catalog; text: string } | { ok: false; problem: string };

function parseText(text: string, label: string): Attempt {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `${label} is not JSON: ${(error as Error).message}` };
  }
  try {
    return { ok: true, catalog: parseCatalog(data, label), text };
  } catch (error) {
    return { ok: false, problem: (error as Error).message };
  }
}

async function fetchRemote(url: string, options: LoadCatalogOptions): Promise<Attempt> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 10_000)];
  if (options.signal) signals.push(options.signal);
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.any(signals),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, problem: `remote catalog: HTTP ${response.status}` };
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await response.body?.cancel();
      return { ok: false, problem: `remote catalog: ${declared} bytes is over the limit` };
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      return { ok: false, problem: "remote catalog: response is over the size limit" };
    }
    return parseText(text, "remote catalog");
  } catch (error) {
    return { ok: false, problem: `remote catalog: ${(error as Error).message}` };
  }
}

async function readCache(path: string): Promise<Attempt> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, problem: `cached catalog: ${(error as Error).message}` };
  }
  return parseText(text, "cached catalog");
}

async function writeCache(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Loads the catalog: the bundled copy, replaced by a fetched one when it is valid and not
 * older, or else by the last good cached copy when that is newer than the bundled one.
 * Network and cache problems never throw; they are listed in `problems`. Only an invalid
 * bundled catalog throws, since that is a packaging bug.
 */
export async function loadCatalog(options: LoadCatalogOptions = {}): Promise<LoadedCatalog> {
  const bundledData =
    options.bundled !== undefined
      ? options.bundled
      : JSON.parse(await readFile(options.bundledPath ?? BUNDLED_CATALOG_PATH, "utf8"));
  const bundled = parseCatalog(bundledData, "bundled catalog");
  const problems: string[] = [];

  if (options.remoteUrl) {
    const remote = await fetchRemote(options.remoteUrl, options);
    if (remote.ok) {
      if (options.cacheFile) {
        try {
          await writeCache(options.cacheFile, remote.text);
        } catch (error) {
          problems.push(`could not cache the fetched catalog: ${(error as Error).message}`);
        }
      }
      if (remote.catalog.version >= bundled.version) {
        return { catalog: remote.catalog, source: "remote", problems };
      }
      problems.push(
        `remote catalog version ${remote.catalog.version} is older than the bundled ${bundled.version}`,
      );
      return { catalog: bundled, source: "bundled", problems };
    }
    problems.push(remote.problem);
  }

  if (options.cacheFile) {
    const cached = await readCache(options.cacheFile);
    if (cached.ok && cached.catalog.version > bundled.version) {
      return { catalog: cached.catalog, source: "cache", problems };
    }
    if (!cached.ok) problems.push(cached.problem);
  }

  return { catalog: bundled, source: "bundled", problems };
}
