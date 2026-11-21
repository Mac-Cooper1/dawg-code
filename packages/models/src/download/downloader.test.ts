import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { CatalogEntry } from "../types.ts";
import {
  cachePaths,
  DownloadError,
  type DownloadOptions,
  type DownloadProgress,
  type DownloadTarget,
  discardPartialDownload,
  downloadEntry,
  downloadFile,
  repoFolderName,
  resolveHubCacheDir,
  resolveHubUrl,
} from "./index.ts";

// ---------------------------------------------------------------------------
// A local stand-in for the Hugging Face hub: tree listing plus /resolve with Range support,
// and switches to misbehave the way real networks and servers do.
// ---------------------------------------------------------------------------

interface Behaviour {
  /** For successive /resolve requests: send this many body bytes, then drop the connection. */
  dropAfter: number[];
  /** For successive /resolve requests: send this many body bytes, then go silent. */
  hangAfter: number[];
  /** For successive /resolve requests: answer with this status instead. */
  statuses: number[];
  ignoreRange: boolean;
  corrupt: boolean;
  redirect: boolean;
}

interface LoggedRequest {
  path: string;
  range: string | undefined;
}

function pattern(size: number, seed: number): Buffer {
  const buffer = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    buffer[i] = x & 0xff;
  }
  return buffer;
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const REPO = "test-org/Test-Model-GGUF";
const REVISION = "0123456789abcdef0123456789abcdef01234567";

class FakeHub {
  server: Server;
  url = "";
  files = new Map<string, Buffer>();
  requests: LoggedRequest[] = [];
  behaviour: Behaviour = FakeHub.normal();
  hanging: ServerResponse[] = [];
  /** Resolves when a request starts hanging. */
  onHang: (() => void) | undefined;

  static normal(): Behaviour {
    return {
      dropAfter: [],
      hangAfter: [],
      statuses: [],
      ignoreRange: false,
      corrupt: false,
      redirect: false,
    };
  }

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.files.clear();
    this.requests = [];
    this.behaviour = FakeHub.normal();
    for (const res of this.hanging) res.destroy();
    this.hanging = [];
  }

  add(file: string, data: Buffer): DownloadTarget {
    this.files.set(file, data);
    return { repo: REPO, revision: REVISION, file, sha256: sha(data), sizeBytes: data.length };
  }

  resolveRequests(): LoggedRequest[] {
    return this.requests.filter((r) => !r.path.startsWith("/api/"));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
    this.requests.push({ path, range: req.headers.range });
    const treePrefix = `/api/models/${REPO}/tree/${REVISION}`;
    if (path === treePrefix || path.startsWith(`${treePrefix}/`)) {
      const dir = path.slice(treePrefix.length + 1);
      const listing = [...this.files.entries()]
        .filter(
          ([file]) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "") === dir,
        )
        .map(([file, data]) => ({
          type: "file",
          path: file,
          size: data.length,
          oid: "0".repeat(40),
          lfs: { oid: sha(data), size: data.length, pointerSize: 134 },
        }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(listing));
      return;
    }
    const resolvePrefix = `/${REPO}/resolve/${REVISION}/`;
    let file: string | undefined;
    if (path.startsWith(resolvePrefix)) {
      file = path.slice(resolvePrefix.length);
      if (this.behaviour.redirect) {
        res.statusCode = 302;
        res.setHeader("location", `/cdn/${encodeURIComponent(file)}?signature=abc`);
        res.end();
        return;
      }
    } else if (path.startsWith("/cdn/")) {
      file = path.slice("/cdn/".length);
    }
    const data = file === undefined ? undefined : this.files.get(file);
    if (!data) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const status = this.behaviour.statuses.shift();
    if (status !== undefined) {
      res.statusCode = status;
      if (status === 416) res.setHeader("content-range", `bytes */${data.length}`);
      res.end();
      return;
    }

    let body = data;
    if (this.behaviour.corrupt) {
      body = Buffer.from(data);
      const middle = Math.floor(body.length / 2);
      body[middle] = (body[middle] ?? 0) ^ 0xff;
    }
    let start = 0;
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (match && !this.behaviour.ignoreRange) {
      start = Number(match[1]);
      if (start >= body.length) {
        res.statusCode = 416;
        res.setHeader("content-range", `bytes */${body.length}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("content-range", `bytes ${start}-${body.length - 1}/${body.length}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-length", body.length - start);
    const slice = body.subarray(start);

    const drop = this.behaviour.dropAfter.shift();
    if (drop !== undefined) {
      res.flushHeaders();
      res.write(slice.subarray(0, drop), () => res.socket?.destroy());
      return;
    }
    const hang = this.behaviour.hangAfter.shift();
    if (hang !== undefined) {
      res.flushHeaders();
      res.write(slice.subarray(0, hang), () => this.onHang?.());
      this.hanging.push(res);
      return;
    }
    res.end(slice);
  }
}

// ---------------------------------------------------------------------------

const hub = new FakeHub();
let hubDir: string;
const plenty = async () => Number.MAX_SAFE_INTEGER;

function options(extra: Partial<DownloadOptions> = {}): DownloadOptions {
  return {
    hubDir,
    hubUrl: hub.url,
    freeSpace: plenty,
    backoffBaseMs: 1,
    backoffMaxMs: 5,
    maxRetries: 3,
    ...extra,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function paths(target: DownloadTarget) {
  return cachePaths(hubDir, target.repo, target.revision, target.file, target.sha256);
}

async function expectFinished(target: DownloadTarget): Promise<void> {
  const p = paths(target);
  expect(sha(await readFile(p.blobPath))).toBe(target.sha256);
  expect(sha(await readFile(p.snapshotPath))).toBe(target.sha256);
  expect(await exists(p.incompletePath)).toBe(false);
}

beforeAll(async () => {
  await hub.start();
});
afterAll(async () => {
  await hub.stop();
});
beforeEach(async () => {
  hub.reset();
  hubDir = await mkdtemp(join(tmpdir(), "dawg-hub-"));
});
afterEach(async () => {
  await rm(hubDir, { recursive: true, force: true });
});

describe("cache layout", () => {
  test("blob named by SHA-256, relative snapshot symlink, refs/main", async () => {
    const target = hub.add("model-Q4_K_M.gguf", pattern(300_000, 1));
    const result = await downloadFile(target, options());
    const repoDir = join(hubDir, "models--test-org--Test-Model-GGUF");
    expect(result).toEqual({
      file: target.file,
      path: join(repoDir, "snapshots", REVISION, "model-Q4_K_M.gguf"),
      blobPath: join(repoDir, "blobs", target.sha256),
      transferred: true,
    });
    expect(await readlink(result.path)).toBe(`../../blobs/${target.sha256}`);
    expect(await readFile(join(repoDir, "refs", "main"), "utf8")).toBe(REVISION);
    expect(await readdir(join(repoDir, "blobs"))).toEqual([target.sha256]);
    await expectFinished(target);
  });

  test("a file in a subfolder links back through the extra level", async () => {
    const target = hub.add("BF16/model-BF16-00001-of-00002.gguf", pattern(10_000, 2));
    const result = await downloadFile(target, options());
    expect(await readlink(result.path)).toBe(`../../../blobs/${target.sha256}`);
    await expectFinished(target);
  });

  test("an existing refs/main is left alone", async () => {
    const target = hub.add("a.gguf", pattern(1000, 3));
    const ref = join(hubDir, repoFolderName(REPO), "refs", "main");
    await mkdir(join(hubDir, repoFolderName(REPO), "refs"), { recursive: true });
    await writeFile(ref, "f".repeat(40));
    await downloadFile(target, options());
    expect(await readFile(ref, "utf8")).toBe("f".repeat(40));
  });

  test("HF_HUB_CACHE, HF_HOME and HF_ENDPOINT are honoured", () => {
    expect(resolveHubCacheDir({ HF_HUB_CACHE: "/x/hub", HF_HOME: "/y" }, "/home")).toBe("/x/hub");
    expect(resolveHubCacheDir({ HF_HOME: "/y" }, "/home")).toBe("/y/hub");
    expect(resolveHubCacheDir({ XDG_CACHE_HOME: "/xdg" }, "/home")).toBe("/xdg/huggingface/hub");
    expect(resolveHubCacheDir({}, "/home")).toBe("/home/.cache/huggingface/hub");
    expect(resolveHubUrl({ HF_ENDPOINT: "https://mirror.test/" })).toBe("https://mirror.test");
    expect(resolveHubUrl({})).toBe("https://huggingface.co");
  });
});

describe("transfer", () => {
  test("resumes from the partial file's length", async () => {
    const data = pattern(400_000, 4);
    const target = hub.add("m.gguf", data);
    const p = paths(target);
    await mkdir(join(hubDir, repoFolderName(REPO), "blobs"), { recursive: true });
    await writeFile(p.incompletePath, data.subarray(0, 123_456));
    await downloadFile(target, options());
    expect(hub.resolveRequests().map((r) => r.range)).toEqual(["bytes=123456-"]);
    await expectFinished(target);
  });

  test("a dropped connection continues from where it stopped", async () => {
    const target = hub.add("m.gguf", pattern(500_000, 5));
    hub.behaviour.dropAfter = [200_000, 100_000];
    await downloadFile(target, options());
    const ranges = hub.resolveRequests().map((r) => r.range);
    expect(ranges).toHaveLength(3);
    expect(ranges[0]).toBeUndefined();
    const second = Number(/bytes=(\d+)-/.exec(ranges[1] ?? "")?.[1]);
    const third = Number(/bytes=(\d+)-/.exec(ranges[2] ?? "")?.[1]);
    expect(second).toBeGreaterThan(0);
    expect(third).toBeGreaterThan(second);
    await expectFinished(target);
  });

  test("wrong bytes fail verification, are deleted and reported", async () => {
    const target = hub.add("m.gguf", pattern(200_000, 6));
    hub.behaviour.corrupt = true;
    const error = await downloadFile(target, options()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).code).toBe("hash-mismatch");
    const p = paths(target);
    expect(await exists(p.blobPath)).toBe(false);
    expect(await exists(p.incompletePath)).toBe(false);
    expect(await exists(p.snapshotPath)).toBe(false);
  });

  test("a server that ignores Range restarts cleanly from zero", async () => {
    const data = pattern(300_000, 7);
    const target = hub.add("m.gguf", data);
    const p = paths(target);
    await mkdir(join(hubDir, repoFolderName(REPO), "blobs"), { recursive: true });
    await writeFile(p.incompletePath, data.subarray(0, 100_000));
    hub.behaviour.ignoreRange = true;
    await downloadFile(target, options());
    expect(hub.resolveRequests()).toHaveLength(1);
    await expectFinished(target);
  });

  test("Range survives a redirect to another path", async () => {
    const data = pattern(300_000, 8);
    const target = hub.add("m.gguf", data);
    await mkdir(join(hubDir, repoFolderName(REPO), "blobs"), { recursive: true });
    await writeFile(paths(target).incompletePath, data.subarray(0, 50_000));
    hub.behaviour.redirect = true;
    await downloadFile(target, options());
    const cdn = hub.resolveRequests().filter((r) => r.path.startsWith("/cdn/"));
    expect(cdn.map((r) => r.range)).toEqual(["bytes=50000-"]);
    await expectFinished(target);
  });

  test("500s are retried with backoff", async () => {
    const target = hub.add("m.gguf", pattern(50_000, 9));
    hub.behaviour.statuses = [500, 503];
    const sleeps: number[] = [];
    await downloadFile(
      target,
      options({
        backoffBaseMs: 100,
        backoffMaxMs: 10_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    expect(sleeps).toHaveLength(2);
    // Exponential with jitter: [base/2, base] then [base, 2*base].
    expect(sleeps[0]).toBeGreaterThanOrEqual(50);
    expect(sleeps[0]).toBeLessThanOrEqual(100);
    expect(sleeps[1]).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]).toBeLessThanOrEqual(200);
    await expectFinished(target);
  });

  test("persistent 500s give up with the partial file kept", async () => {
    const data = pattern(300_000, 10);
    const target = hub.add("m.gguf", data);
    hub.behaviour.dropAfter = [100_000];
    // After the drop, every request fails: each backoff queues another 500.
    const error = await downloadFile(
      target,
      options({
        maxRetries: 2,
        sleep: async () => {
          hub.behaviour.statuses.push(500);
        },
      }),
    ).catch((e: unknown) => e);
    expect((error as DownloadError).code).toBe("network");
    const partial = await stat(paths(target).incompletePath);
    expect(partial.size).toBeGreaterThan(0);
    expect(await exists(paths(target).blobPath)).toBe(false);
  });

  test("a 416 on resume restarts from zero", async () => {
    const data = pattern(200_000, 11);
    const target = hub.add("m.gguf", data);
    await mkdir(join(hubDir, repoFolderName(REPO), "blobs"), { recursive: true });
    await writeFile(paths(target).incompletePath, data.subarray(0, 80_000));
    hub.behaviour.statuses = [416];
    await downloadFile(target, options());
    expect(hub.resolveRequests().map((r) => r.range)).toEqual(["bytes=80000-", undefined]);
    await expectFinished(target);
  });

  test("a partial longer than the file is discarded", async () => {
    const data = pattern(20_000, 12);
    const target = hub.add("m.gguf", data);
    await mkdir(join(hubDir, repoFolderName(REPO), "blobs"), { recursive: true });
    await writeFile(paths(target).incompletePath, pattern(30_000, 99));
    await downloadFile(target, options());
    expect(hub.resolveRequests().map((r) => r.range)).toEqual([undefined]);
    await expectFinished(target);
  });

  test("a complete partial is verified and committed without a transfer", async () => {
    const data = pattern(20_000, 13);
    const target = hub.add("m.gguf", data);
    await mkdir(join(hubDir, repoFolderName(REPO), "blobs"), { recursive: true });
    await writeFile(paths(target).incompletePath, data);
    await downloadFile(target, options());
    expect(hub.resolveRequests()).toEqual([]);
    await expectFinished(target);
  });

  test("a stalled connection is abandoned and resumed", async () => {
    const target = hub.add("m.gguf", pattern(300_000, 14));
    hub.behaviour.hangAfter = [100_000];
    await downloadFile(target, options({ stallTimeoutMs: 100 }));
    const ranges = hub.resolveRequests().map((r) => r.range);
    expect(ranges).toHaveLength(2);
    expect(ranges[1]).toMatch(/^bytes=[1-9]\d*-$/);
    await expectFinished(target);
  });

  test("404 is final and not retried", async () => {
    const target = hub.add("m.gguf", pattern(1000, 15));
    hub.behaviour.statuses = [404];
    const error = await downloadFile(target, options()).catch((e: unknown) => e);
    expect((error as DownloadError).code).toBe("not-found");
    expect(hub.resolveRequests()).toHaveLength(1);
  });
});

describe("checks before transferring", () => {
  test("a present, verified file is a no-op", async () => {
    const target = hub.add("m.gguf", pattern(10_000, 16));
    await downloadFile(target, options());
    hub.requests = [];
    const again = await downloadFile(target, options());
    expect(again.transferred).toBe(false);
    expect(hub.requests).toEqual([]);
    await expectFinished(target);
  });

  test("not enough disk for size + 10% fails before any transfer", async () => {
    const target = hub.add("m.gguf", pattern(100_000, 17));
    const error = await downloadFile(target, options({ freeSpace: async () => 105_000 })).catch(
      (e: unknown) => e,
    );
    expect((error as DownloadError).code).toBe("insufficient-space");
    expect(hub.resolveRequests()).toEqual([]);
    // Exactly size + 10% is enough.
    await downloadFile(target, options({ freeSpace: async () => 110_000 }));
  });

  test("a catalog hash that disagrees with the listing is refused", async () => {
    const target = hub.add("m.gguf", pattern(1000, 18));
    const error = await downloadFile({ ...target, sha256: "e".repeat(64) }, options()).catch(
      (e: unknown) => e,
    );
    expect((error as DownloadError).code).toBe("listing-mismatch");
    expect(hub.resolveRequests()).toEqual([]);
  });

  test("a file missing from the listing is not-found", async () => {
    const target = hub.add("m.gguf", pattern(1000, 19));
    const error = await downloadFile({ ...target, file: "other.gguf" }, options()).catch(
      (e: unknown) => e,
    );
    expect((error as DownloadError).code).toBe("not-found");
  });
});

describe("pause, resume, cancel", () => {
  test("aborting keeps the partial file; calling again resumes it", async () => {
    const target = hub.add("m.gguf", pattern(400_000, 20));
    hub.behaviour.hangAfter = [150_000];
    const controller = new AbortController();
    hub.onHang = () => setTimeout(() => controller.abort(), 50);
    const error = await downloadFile(target, options({ signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    hub.onHang = undefined;
    expect((error as DownloadError).code).toBe("aborted");
    const partial = (await stat(paths(target).incompletePath)).size;
    expect(partial).toBeGreaterThan(0);
    expect(await exists(paths(target).blobPath)).toBe(false);

    hub.requests = [];
    await downloadFile(target, options());
    expect(hub.resolveRequests().map((r) => r.range)).toEqual([`bytes=${partial}-`]);
    await expectFinished(target);
  });

  test("an already-aborted signal does nothing", async () => {
    const target = hub.add("m.gguf", pattern(1000, 21));
    const error = await downloadFile(target, options({ signal: AbortSignal.abort() })).catch(
      (e: unknown) => e,
    );
    expect((error as DownloadError).code).toBe("aborted");
    expect(hub.resolveRequests()).toEqual([]);
  });

  test("the same file cannot download twice at once", async () => {
    const target = hub.add("m.gguf", pattern(200_000, 22));
    hub.behaviour.hangAfter = [10_000];
    const controller = new AbortController();
    const first = downloadFile(target, options({ signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    await new Promise<void>((resolve) => {
      hub.onHang = resolve;
    });
    const second = await downloadFile(target, options()).catch((e: unknown) => e);
    expect((second as DownloadError).code).toBe("busy");
    controller.abort();
    expect(((await first) as DownloadError).code).toBe("aborted");
    hub.onHang = undefined;
  });
});

describe("downloadEntry", () => {
  function entryFor(model: DownloadTarget, projector?: DownloadTarget): CatalogEntry {
    return {
      id: "test",
      displayName: "Test",
      licence: { spdx: "Apache-2.0", url: "https://example.com" },
      source: model,
      ...(projector
        ? {
            projector: {
              file: projector.file,
              sha256: projector.sha256,
              sizeBytes: projector.sizeBytes,
            },
          }
        : {}),
      minMemoryBytes: 1,
      context: { default: 1, max: 1 },
      capabilities: { tools: true, vision: projector !== undefined, reasoning: true },
      profile: "test",
      rank: 1,
    };
  }

  test("downloads the model and the projector, with progress across both", async () => {
    const model = hub.add("m.gguf", pattern(9_000_000, 23));
    const projector = hub.add("mmproj-F16.gguf", pattern(1_000_000, 24));
    const events: DownloadProgress[] = [];
    let clock = 0;
    const result = await downloadEntry(
      entryFor(model, projector),
      options({ onProgress: (e) => events.push(e), now: () => (clock += 100) }),
    );
    expect(result.model.blobPath).toBe(paths(model).blobPath);
    expect(result.projector?.blobPath).toBe(paths(projector).blobPath);
    await expectFinished(model);
    await expectFinished(projector);

    const total = 10_000_000;
    expect(events.every((e) => e.bytesTotal === total)).toBe(true);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.bytesDone).toBeGreaterThanOrEqual(events[i - 1]?.bytesDone ?? 0);
    }
    const last = events[events.length - 1];
    expect(last).toMatchObject({ file: "mmproj-F16.gguf", phase: "done", bytesDone: total });
    expect(last?.etaSeconds).toBe(0);
    const moving = events.filter((e) => e.phase === "downloading" && e.bytesPerSecond > 0);
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.every((e) => e.etaSeconds !== null && e.etaSeconds >= 0)).toBe(true);
  });

  test("progress is throttled while transferring", async () => {
    const model = hub.add("m.gguf", pattern(20_000_000, 25));
    const events: DownloadProgress[] = [];
    await downloadEntry(
      entryFor(model),
      options({ onProgress: (e) => events.push(e), now: () => 0, progressIntervalMs: 250 }),
    );
    // With a frozen clock only phase changes are reported, never per-chunk updates.
    expect(events.map((e) => e.phase)).toEqual(["checking", "downloading", "verifying", "done"]);
  });

  test("the space check covers every missing file before starting", async () => {
    const model = hub.add("m.gguf", pattern(100_000, 26));
    const projector = hub.add("p.gguf", pattern(50_000, 27));
    const error = await downloadEntry(
      entryFor(model, projector),
      options({ freeSpace: async () => 120_000 }),
    ).catch((e: unknown) => e);
    expect((error as DownloadError).code).toBe("insufficient-space");
    expect(hub.resolveRequests()).toEqual([]);
  });

  test("discardPartialDownload removes partial data only", async () => {
    const model = hub.add("m.gguf", pattern(100_000, 28));
    const entry = entryFor(model);
    await mkdir(join(hubDir, repoFolderName(REPO), "blobs"), { recursive: true });
    await writeFile(paths(model).incompletePath, "partial");
    await discardPartialDownload(entry, { hubDir });
    expect(await exists(paths(model).incompletePath)).toBe(false);
  });
});
