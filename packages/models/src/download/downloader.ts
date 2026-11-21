import { createHash, type Hash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultFreeSpace, type FreeSpaceReader } from "../hardware/probe.ts";
import type { CatalogEntry } from "../types.ts";
import { HubHttpError, listRepoFiles } from "./hf-api.ts";
import {
  type CachePaths,
  cachePaths,
  resolveHubCacheDir,
  resolveHubUrl,
  resolveUrl,
} from "./paths.ts";

export type DownloadErrorCode =
  /** Not enough free disk for the file plus 10%. */
  | "insufficient-space"
  /** The finished file's SHA-256 is not the catalog's. The partial file was deleted. */
  | "hash-mismatch"
  /** The server or the listing disagrees with the catalog about the file's size or hash. */
  | "listing-mismatch"
  /** The file is not in the repo at that revision, or the hub refused it (4xx). */
  | "not-found"
  /** Gave up after repeated network or server failures. The partial file is kept for resume. */
  | "network"
  /** The signal was aborted (pause or cancel). The partial file is kept for resume. */
  | "aborted"
  /** This file is already being downloaded by this process. */
  | "busy"
  /** A local file system failure. */
  | "io";

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly file: string;
  constructor(code: DownloadErrorCode, file: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DownloadError";
    this.code = code;
    this.file = file;
  }
}

export interface DownloadTarget {
  repo: string;
  revision: string;
  file: string;
  sha256: string;
  sizeBytes: number;
}

export type DownloadPhase = "checking" | "downloading" | "verifying" | "done";

export interface DownloadProgress {
  /** Repo path of the file being worked on. */
  file: string;
  phase: DownloadPhase;
  /** Bytes on disk so far, across every file of the request. */
  bytesDone: number;
  bytesTotal: number;
  /** Recent transfer speed; 0 until there is enough data. */
  bytesPerSecond: number;
  /** Seconds left at the recent speed, or null when unknown. */
  etaSeconds: number | null;
}

export interface DownloadOptions {
  /** Hugging Face hub cache. Defaults to `HF_HUB_CACHE` / `HF_HOME` / `~/.cache/huggingface/hub`. */
  hubDir?: string;
  /** Hub base URL. Defaults to `HF_ENDPOINT` or https://huggingface.co. */
  hubUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Abort to pause or cancel. The partial file stays; call again to resume. */
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  /** Minimum time between progress events while transferring. Default 250 ms. */
  progressIntervalMs?: number;
  /** Consecutive failed attempts (without any progress) before giving up. Default 8. */
  maxRetries?: number;
  /** First backoff delay; doubles each consecutive failure. Default 1 s. */
  backoffBaseMs?: number;
  /** Backoff ceiling. Default 60 s. */
  backoffMaxMs?: number;
  /** An attempt with no data for this long is abandoned and retried. Default 60 s. */
  stallTimeoutMs?: number;
  freeSpace?: FreeSpaceReader;
  /** Extra request headers. */
  headers?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface DownloadedFile {
  file: string;
  /** `snapshots/<revision>/<file>`: the path to hand to the runtime. */
  path: string;
  blobPath: string;
  /** False when the verified blob was already there and nothing was transferred. */
  transferred: boolean;
}

export interface DownloadedEntry {
  model: DownloadedFile;
  projector?: DownloadedFile;
}

interface Context {
  hubDir: string;
  hubUrl: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal | undefined;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  stallTimeoutMs: number;
  freeSpace: FreeSpaceReader;
  headers: Record<string, string>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  meter: ProgressMeter;
}

const WRITE_CHUNK_BYTES = 4 * 1024 * 1024;
const SPEED_WINDOW_MS = 5000;
/** Downloads in flight in this process, by blob path. */
const active = new Set<string>();

class ProgressMeter {
  private done = 0;
  private samples: Array<[number, number]> = [];
  private lastEmit = Number.NEGATIVE_INFINITY;
  private file = "";
  private phase: DownloadPhase = "checking";
  private readonly total: number;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly emit: ((progress: DownloadProgress) => void) | undefined;

  constructor(
    total: number,
    now: () => number,
    intervalMs: number,
    emit: ((progress: DownloadProgress) => void) | undefined,
  ) {
    this.total = total;
    this.now = now;
    this.intervalMs = intervalMs;
    this.emit = emit;
  }

  setFile(file: string, phase: DownloadPhase): void {
    this.file = file;
    this.phase = phase;
    this.report(true);
  }

  /** Bytes that count as done without being transferred now (already present, resumed). */
  credit(bytes: number): void {
    this.done += bytes;
    this.samples = [];
  }

  add(bytes: number): void {
    this.done += bytes;
    this.report(false);
  }

  rewind(bytes: number): void {
    this.done -= bytes;
    this.samples = [];
  }

  report(force: boolean): void {
    const t = this.now();
    this.samples.push([t, this.done]);
    while (this.samples.length > 2 && (this.samples[0]?.[0] ?? t) < t - SPEED_WINDOW_MS) {
      this.samples.shift();
    }
    if (!this.emit || (!force && t - this.lastEmit < this.intervalMs)) return;
    this.lastEmit = t;
    const first = this.samples[0];
    let speed = 0;
    if (first && t > first[0]) speed = ((this.done - first[1]) * 1000) / (t - first[0]);
    const left = Math.max(0, this.total - this.done);
    this.emit({
      file: this.file,
      phase: this.phase,
      bytesDone: this.done,
      bytesTotal: this.total,
      bytesPerSecond: Math.max(0, speed),
      etaSeconds: left === 0 ? 0 : speed > 0 ? left / speed : null,
    });
  }
}

/** Thrown inside an attempt for failures worth retrying. */
class RetryableError extends Error {}

function isAbort(ctx: Context): boolean {
  return ctx.signal?.aborted === true;
}

function abortedError(file: string, ctx: Context): DownloadError {
  return new DownloadError("aborted", file, `download of ${file} was stopped`, {
    cause: ctx.signal?.reason,
  });
}

function makeContext(options: DownloadOptions, totalBytes: number): Context {
  const env = process.env;
  return {
    hubDir: options.hubDir ?? resolveHubCacheDir(env),
    hubUrl: (options.hubUrl ?? resolveHubUrl(env)).replace(/\/+$/, ""),
    fetch: options.fetch ?? globalThis.fetch,
    signal: options.signal,
    maxRetries: options.maxRetries ?? 8,
    backoffBaseMs: options.backoffBaseMs ?? 1000,
    backoffMaxMs: options.backoffMaxMs ?? 60_000,
    stallTimeoutMs: options.stallTimeoutMs ?? 60_000,
    freeSpace: options.freeSpace ?? defaultFreeSpace,
    headers: options.headers ?? {},
    sleep: options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal })),
    meter: new ProgressMeter(
      totalBytes,
      options.now ?? Date.now,
      options.progressIntervalMs ?? 250,
      options.onProgress,
    ),
  };
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Points `snapshots/<revision>/<file>` at the blob, and writes `refs/main` if absent. */
async function linkSnapshot(paths: CachePaths, revision: string): Promise<void> {
  await mkdir(dirname(paths.snapshotPath), { recursive: true });
  let current: string | null = null;
  try {
    current = await readlink(paths.snapshotPath);
  } catch {
    current = null;
  }
  if (current !== paths.snapshotTarget) {
    const temp = `${paths.snapshotPath}.${randomBytes(6).toString("hex")}.tmp`;
    await symlink(paths.snapshotTarget, temp);
    try {
      await rename(temp, paths.snapshotPath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
  await mkdir(dirname(paths.mainRefPath), { recursive: true });
  try {
    // Only when absent: if another tool recorded a newer `main`, leave it alone.
    await writeFile(paths.mainRefPath, revision, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function hashPrefix(path: string, length: number, hash: Hash, ctx: Context): Promise<void> {
  const stream = createReadStream(path, { start: 0, end: length - 1, highWaterMark: 1 << 22 });
  const onAbort = () => stream.destroy();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}

function backoffMs(failures: number, ctx: Context): number {
  const base = Math.min(ctx.backoffMaxMs, ctx.backoffBaseMs * 2 ** Math.max(0, failures - 1));
  return base / 2 + (Math.random() * base) / 2;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Runs `fn` with retries for network errors and retryable statuses. */
async function withRetries<T>(file: string, ctx: Context, fn: () => Promise<T>): Promise<T> {
  let failures = 0;
  for (;;) {
    if (isAbort(ctx)) throw abortedError(file, ctx);
    try {
      return await fn();
    } catch (error) {
      if (isAbort(ctx)) throw abortedError(file, ctx);
      if (error instanceof HubHttpError && !isRetryableStatus(error.status)) {
        throw new DownloadError("not-found", file, error.message, { cause: error });
      }
      if (error instanceof DownloadError) throw error;
      failures += 1;
      if (failures > ctx.maxRetries) {
        throw new DownloadError(
          "network",
          file,
          `gave up on ${file}: ${(error as Error).message}`,
          {
            cause: error,
          },
        );
      }
      try {
        await ctx.sleep(backoffMs(failures, ctx), ctx.signal);
      } catch {
        throw abortedError(file, ctx);
      }
    }
  }
}

async function checkListing(target: DownloadTarget, ctx: Context): Promise<void> {
  const dir = posix.dirname(target.file);
  const files = await withRetries(target.file, ctx, () =>
    listRepoFiles(target.repo, target.revision, dir === "." ? "" : dir, {
      hubUrl: ctx.hubUrl,
      fetch: ctx.fetch,
      signal: ctx.signal,
      headers: ctx.headers,
    }),
  );
  const listed = files.find((f) => f.path === target.file);
  if (!listed) {
    throw new DownloadError(
      "not-found",
      target.file,
      `${target.file} is not in ${target.repo} at ${target.revision}`,
    );
  }
  if (listed.sizeBytes !== target.sizeBytes || listed.sha256 !== target.sha256) {
    throw new DownloadError(
      "listing-mismatch",
      target.file,
      `${target.file}: the hub lists ${listed.sizeBytes} bytes / ${listed.sha256 ?? "no sha256"}, the catalog says ${target.sizeBytes} / ${target.sha256}`,
    );
  }
}

/** Mutable state of the partial file during one call. */
interface PartialFile {
  handle: FileHandle;
  hash: Hash;
  offset: number;
}

async function restartFromZero(state: PartialFile, ctx: Context): Promise<void> {
  await state.handle.truncate(0);
  ctx.meter.rewind(state.offset);
  state.offset = 0;
  state.hash = createHash("sha256");
}

function parseContentRange(header: string | null): { start: number; total: number | null } | null {
  const match = header ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim()) : null;
  if (!match) return null;
  return { start: Number(match[1]), total: match[3] === "*" ? null : Number(match[3]) };
}

/**
 * One HTTP attempt: continues the partial file from `state.offset`. Returns normally when the
 * file is complete; throws RetryableError for anything worth another attempt.
 */
async function transferOnce(
  target: DownloadTarget,
  state: PartialFile,
  ctx: Context,
): Promise<void> {
  const url = resolveUrl(ctx.hubUrl, target.repo, target.revision, target.file);
  const attempt = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, attempt.signal]) : attempt.signal;
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => attempt.abort(new Error("stalled: no data received")),
      ctx.stallTimeoutMs,
    );
  };

  try {
    armStall();
    let response: Response;
    try {
      response = await ctx.fetch(url, {
        signal,
        redirect: "follow",
        headers: {
          ...ctx.headers,
          ...(state.offset > 0 ? { range: `bytes=${state.offset}-` } : {}),
          "accept-encoding": "identity",
        },
      });
    } catch (error) {
      throw new RetryableError(`request failed: ${(error as Error).message}`, { cause: error });
    }

    if (response.status === 416) {
      await response.body?.cancel();
      const range = /\*\/(\d+)/.exec(response.headers.get("content-range") ?? "");
      const serverSize = range ? Number(range[1]) : null;
      if (
        state.offset === target.sizeBytes &&
        (serverSize === null || serverSize === state.offset)
      ) {
        return; // Already have every byte; verification decides.
      }
      const at = state.offset;
      await restartFromZero(state, ctx);
      throw new RetryableError(`416 at offset ${at}; restarting from zero`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (isRetryableStatus(response.status)) {
        throw new RetryableError(`HTTP ${response.status}`);
      }
      throw new DownloadError("not-found", target.file, `HTTP ${response.status} for ${url}`);
    }

    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || range.start !== state.offset) {
        await response.body?.cancel();
        await restartFromZero(state, ctx);
        throw new RetryableError("server answered a different range; restarting from zero");
      }
      if (range.total !== null && range.total !== target.sizeBytes) {
        await response.body?.cancel();
        throw new DownloadError(
          "listing-mismatch",
          target.file,
          `server reports ${range.total} bytes, the catalog says ${target.sizeBytes}`,
        );
      }
    } else {
      // 200: the whole file. If we asked for a range, the server ignored it.
      if (state.offset > 0) await restartFromZero(state, ctx);
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== target.sizeBytes) {
        await response.body?.cancel();
        throw new DownloadError(
          "listing-mismatch",
          target.file,
          `server sends ${length} bytes, the catalog says ${target.sizeBytes}`,
        );
      }
    }
    if (!response.body) throw new RetryableError("response has no body");

    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const data = pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      try {
        await state.handle.write(data);
      } catch (error) {
        throw new DownloadError("io", target.file, `writing ${target.file} failed`, {
          cause: error,
        });
      }
      state.hash.update(data);
      state.offset += data.length;
      ctx.meter.add(data.length);
    };

    try {
      for await (const chunk of response.body) {
        armStall();
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (state.offset + pendingBytes + buffer.length > target.sizeBytes) {
          await restartFromZero(state, ctx);
          pending = [];
          pendingBytes = 0;
          throw new DownloadError(
            "listing-mismatch",
            target.file,
            `server sent more than the expected ${target.sizeBytes} bytes`,
          );
        }
        pending.push(buffer);
        pendingBytes += buffer.length;
        if (pendingBytes >= WRITE_CHUNK_BYTES) await flush();
      }
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      // Everything received before the failure is a valid prefix: keep it.
      await flush();
      throw new RetryableError(`connection lost: ${(error as Error).message}`, { cause: error });
    }
    await flush();
    if (state.offset < target.sizeBytes) {
      throw new RetryableError(`connection closed at ${state.offset} of ${target.sizeBytes} bytes`);
    }
  } finally {
    clearTimeout(stallTimer);
  }
}

async function transfer(target: DownloadTarget, state: PartialFile, ctx: Context): Promise<void> {
  let failures = 0;
  for (;;) {
    if (state.offset >= target.sizeBytes) return;
    if (isAbort(ctx)) throw abortedError(target.file, ctx);
    const before = state.offset;
    try {
      await transferOnce(target, state, ctx);
      return;
    } catch (error) {
      if (isAbort(ctx)) throw abortedError(target.file, ctx);
      if (!(error instanceof RetryableError)) throw error;
      failures = state.offset > before ? 1 : failures + 1;
      if (failures > ctx.maxRetries) {
        throw new DownloadError("network", target.file, `gave up: ${error.message}`, {
          cause: error,
        });
      }
      try {
        await ctx.sleep(backoffMs(failures, ctx), ctx.signal);
      } catch {
        throw abortedError(target.file, ctx);
      }
    }
  }
}

async function checkSpace(target: DownloadTarget, needBytes: number, ctx: Context): Promise<void> {
  if (needBytes <= 0) return;
  const free = await ctx.freeSpace(ctx.hubDir);
  if (free < needBytes) {
    throw new DownloadError(
      "insufficient-space",
      target.file,
      `${target.file} needs ${needBytes} bytes free (size plus 10%), only ${free} available`,
    );
  }
}

/** Bytes still to fetch for a target: 0 when its blob is already complete. */
async function remaining(target: DownloadTarget, hubDir: string): Promise<number> {
  const paths = cachePaths(hubDir, target.repo, target.revision, target.file, target.sha256);
  if ((await fileSize(paths.blobPath)) === target.sizeBytes) return 0;
  const partial = (await fileSize(paths.incompletePath)) ?? 0;
  return partial > target.sizeBytes ? target.sizeBytes : target.sizeBytes - partial;
}

function spaceNeeded(target: DownloadTarget, left: number): number {
  return left === 0 ? 0 : left + Math.ceil(target.sizeBytes * 0.1);
}

async function downloadOne(
  target: DownloadTarget,
  ctx: Context,
  skipSpaceCheck: boolean,
): Promise<DownloadedFile> {
  const paths = cachePaths(ctx.hubDir, target.repo, target.revision, target.file, target.sha256);
  if (active.has(paths.blobPath)) {
    throw new DownloadError("busy", target.file, `${target.file} is already downloading`);
  }
  active.add(paths.blobPath);
  try {
    ctx.meter.setFile(target.file, "checking");
    if ((await fileSize(paths.blobPath)) === target.sizeBytes) {
      await linkSnapshot(paths, target.revision);
      ctx.meter.credit(target.sizeBytes);
      ctx.meter.setFile(target.file, "done");
      return {
        file: target.file,
        path: paths.snapshotPath,
        blobPath: paths.blobPath,
        transferred: false,
      };
    }

    await checkListing(target, ctx);
    await mkdir(dirname(paths.incompletePath), { recursive: true });
    if (!skipSpaceCheck) {
      await checkSpace(target, spaceNeeded(target, await remaining(target, ctx.hubDir)), ctx);
    }

    const handle = await open(paths.incompletePath, "a");
    const state: PartialFile = { handle, hash: createHash("sha256"), offset: 0 };
    try {
      const existing = (await handle.stat()).size;
      if (existing > target.sizeBytes) {
        await handle.truncate(0);
      } else if (existing > 0) {
        await hashPrefix(paths.incompletePath, existing, state.hash, ctx);
        state.offset = existing;
        ctx.meter.credit(existing);
      }
      ctx.meter.setFile(target.file, "downloading");
      await transfer(target, state, ctx);
      await handle.sync();
    } finally {
      await handle.close();
    }

    ctx.meter.setFile(target.file, "verifying");
    const digest = state.hash.digest("hex");
    if (digest !== target.sha256) {
      await rm(paths.incompletePath, { force: true });
      ctx.meter.rewind(state.offset);
      throw new DownloadError(
        "hash-mismatch",
        target.file,
        `${target.file} has SHA-256 ${digest}, expected ${target.sha256}; the download was deleted`,
      );
    }
    await rename(paths.incompletePath, paths.blobPath);
    await linkSnapshot(paths, target.revision);
    ctx.meter.setFile(target.file, "done");
    return {
      file: target.file,
      path: paths.snapshotPath,
      blobPath: paths.blobPath,
      transferred: true,
    };
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (isAbort(ctx)) throw abortedError(target.file, ctx);
    throw new DownloadError("io", target.file, `${target.file}: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    active.delete(paths.blobPath);
  }
}

/**
 * Downloads one file into the Hugging Face cache, resuming any partial data, and verifies
 * it against `target.sha256`. Present and complete already: returns without a transfer.
 */
export async function downloadFile(
  target: DownloadTarget,
  options: DownloadOptions = {},
): Promise<DownloadedFile> {
  const ctx = makeContext(options, target.sizeBytes);
  return downloadOne(target, ctx, false);
}

/** The files an entry needs: the model, then its projector when it has one. */
export function entryTargets(entry: CatalogEntry): DownloadTarget[] {
  const { repo, revision } = entry.source;
  const targets: DownloadTarget[] = [
    {
      repo,
      revision,
      file: entry.source.file,
      sha256: entry.source.sha256,
      sizeBytes: entry.source.sizeBytes,
    },
  ];
  if (entry.projector) targets.push({ repo, revision, ...entry.projector });
  return targets;
}

/**
 * Downloads a catalog entry's model file and, when it has one, its projector. Free space for
 * everything still missing (plus 10% of each file) is checked before any transfer starts.
 * Progress counts bytes across both files.
 */
export async function downloadEntry(
  entry: CatalogEntry,
  options: DownloadOptions = {},
): Promise<DownloadedEntry> {
  const targets = entryTargets(entry);
  const ctx = makeContext(
    options,
    targets.reduce((sum, t) => sum + t.sizeBytes, 0),
  );
  let need = 0;
  for (const target of targets) need += spaceNeeded(target, await remaining(target, ctx.hubDir));
  const first = targets[0] as DownloadTarget;
  await checkSpace(first, need, ctx);

  const model = await downloadOne(first, ctx, true);
  const projectorTarget = targets[1];
  if (!projectorTarget) return { model };
  return { model, projector: await downloadOne(projectorTarget, ctx, true) };
}

/** Deletes partial data for an entry (the "cancel" half of pause / cancel). Finished blobs stay. */
export async function discardPartialDownload(
  entry: CatalogEntry,
  options: Pick<DownloadOptions, "hubDir"> = {},
): Promise<void> {
  const hubDir = options.hubDir ?? resolveHubCacheDir();
  for (const target of entryTargets(entry)) {
    const paths = cachePaths(hubDir, target.repo, target.revision, target.file, target.sha256);
    if (active.has(paths.blobPath)) {
      throw new DownloadError("busy", target.file, `${target.file} is still downloading`);
    }
    await rm(paths.incompletePath, { force: true });
  }
}
