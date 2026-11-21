import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { RuntimeArch } from "./arch.ts";
import { ChecksumMismatchError, RuntimeError } from "./errors.ts";
import type { RuntimeLock, TestModelPin } from "./lock.ts";
import { repoRoot } from "./lock.ts";
import { bundledLibraryName, cpuTypeForArch, isSystemLibrary, readMachO } from "./macho.ts";

const execFileAsync = promisify(execFile);

export const BINARY_NAME = "llama-server";
export const MANIFEST_NAME = "runtime-manifest.json";
export const LICENSE_NAME = "LICENSE";

/** Where the fetch script puts runtimes in a checkout: `apps/desktop/resources/runtime`. */
export const defaultRuntimeDir = join(repoRoot, "apps", "desktop", "resources", "runtime");
/** Where the opt-in integration test keeps its model: `.cache/test-models`. */
export const defaultTestModelDir = join(repoRoot, ".cache", "test-models");

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number | undefined) => void;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Downloads `url` to `dest`, hashing while writing. The file only appears at `dest` once its
 * size and SHA-256 match; on mismatch the partial file is deleted and the error says so.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expected: { sha256: string; sizeBytes?: number },
  options: DownloadOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const partial = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  const response = await fetchImpl(url, { redirect: "follow", signal: options.signal });
  if (!response.ok || !response.body) {
    throw new RuntimeError("install-failed", `Download failed: HTTP ${response.status} for ${url}`);
  }
  const lengthHeader = response.headers.get("content-length");
  const total = expected.sizeBytes ?? (lengthHeader ? Number(lengthHeader) : undefined);
  const hash = createHash("sha256");
  const out = createWriteStream(partial, { mode: 0o644 });
  let bytes = 0;
  try {
    await pipeline(
      response.body,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          bytes += chunk.length;
          options.onProgress?.(bytes, total);
          yield chunk;
        }
      },
      out,
    );
  } catch (error) {
    await rm(partial, { force: true });
    throw new RuntimeError("install-failed", `Download failed for ${url}`, { cause: error });
  }
  const actual = hash.digest("hex");
  if (actual !== expected.sha256) {
    await rm(partial, { force: true });
    throw new ChecksumMismatchError(basename(dest), expected.sha256, actual);
  }
  if (expected.sizeBytes !== undefined && bytes !== expected.sizeBytes) {
    await rm(partial, { force: true });
    throw new RuntimeError(
      "install-failed",
      `Size mismatch for ${basename(dest)}: expected ${expected.sizeBytes} bytes, got ${bytes}`,
    );
  }
  await rename(partial, dest);
}

const manifestSchema = z.object({
  tag: z.string(),
  arch: z.enum(["arm64", "x64"]),
  archive: z.object({ name: z.string(), sha256: z.string() }),
  files: z.record(
    z.string(),
    z.union([
      z.object({ sha256: z.string(), sizeBytes: z.number() }),
      z.object({ symlink: z.string() }),
    ]),
  ),
});
export type RuntimeManifest = z.infer<typeof manifestSchema>;

export interface InstallRuntimeOptions extends DownloadOptions {
  arch: RuntimeArch;
  lock: RuntimeLock;
  /** Parent of the per-arch directories. Defaults to `apps/desktop/resources/runtime`. */
  runtimeDir?: string;
  /** Scratch space for the archive and its extraction. Defaults to the OS temp directory. */
  tmpDir?: string;
  log?: (message: string) => void;
}

export interface InstallRuntimeResult {
  arch: RuntimeArch;
  dir: string;
  binary: string;
  action: "installed" | "already-present";
  files: string[];
}

/**
 * Makes `<runtimeDir>/<arch>/` hold the pinned `llama-server`, every library it loads, and
 * llama.cpp's licence. A no-op when the directory already matches the lock file and every file
 * still hashes to what the manifest recorded.
 */
export async function installRuntime(
  options: InstallRuntimeOptions,
): Promise<InstallRuntimeResult> {
  const { arch, lock } = options;
  const log = options.log ?? (() => {});
  const runtimeDir = options.runtimeDir ?? defaultRuntimeDir;
  const archive = lock.llamaCpp.archives[arch];
  const dir = join(runtimeDir, arch);

  const existing = await verifyInstalledRuntime(dir, { tag: lock.llamaCpp.tag, arch, archive });
  if (existing.ok) {
    log(`${arch}: ${lock.llamaCpp.tag} already present and verified in ${dir}`);
    return {
      arch,
      dir,
      binary: join(dir, BINARY_NAME),
      action: "already-present",
      files: Object.keys(existing.manifest.files),
    };
  }
  if (existing.reason !== "missing") log(`${arch}: reinstalling (${existing.reason})`);

  const work = await mkdtemp(join(options.tmpDir ?? tmpdir(), "dawg-runtime-"));
  const staging = join(runtimeDir, `.${arch}.staging-${process.pid}`);
  try {
    const archivePath = join(work, archive.name);
    log(`${arch}: downloading ${archive.url}`);
    await downloadVerified(archive.url, archivePath, archive, options);
    log(`${arch}: SHA-256 verified (${archive.sha256})`);

    const extractDir = join(work, "extract");
    await mkdir(extractDir);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir]);
    const binDir = await findBinaryDir(extractDir);
    const plan = await planRuntimeFiles(binDir, arch);

    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const manifest: RuntimeManifest = {
      tag: lock.llamaCpp.tag,
      arch,
      archive: { name: archive.name, sha256: archive.sha256 },
      files: {},
    };
    for (const entry of plan) {
      const target = join(staging, entry.name);
      if (entry.symlink !== undefined) {
        await symlink(entry.symlink, target);
        manifest.files[entry.name] = { symlink: entry.symlink };
      } else {
        await copyFile(join(binDir, entry.name), target);
        await chmod(target, entry.name === LICENSE_NAME ? 0o644 : 0o755);
        const info = await stat(target);
        manifest.files[entry.name] = { sha256: await sha256File(target), sizeBytes: info.size };
      }
    }
    await writeFile(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

    const old = join(runtimeDir, `.${arch}.old-${process.pid}`);
    await rm(old, { recursive: true, force: true });
    const hadExisting = await exists(dir);
    if (hadExisting) await rename(dir, old);
    await rename(staging, dir);
    if (hadExisting) await rm(old, { recursive: true, force: true });
    log(`${arch}: installed ${plan.length} files into ${dir}`);
    return {
      arch,
      dir,
      binary: join(dir, BINARY_NAME),
      action: "installed",
      files: Object.keys(manifest.files),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

export type VerifyResult = { ok: true; manifest: RuntimeManifest } | { ok: false; reason: string };

/** Checks an installed runtime directory against the lock entry and its own manifest. */
export async function verifyInstalledRuntime(
  dir: string,
  expected: { tag: string; arch: RuntimeArch; archive: { name: string; sha256: string } },
): Promise<VerifyResult> {
  let manifest: RuntimeManifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(await readFile(join(dir, MANIFEST_NAME), "utf8")));
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (
    manifest.tag !== expected.tag ||
    manifest.arch !== expected.arch ||
    manifest.archive.sha256 !== expected.archive.sha256
  ) {
    return { ok: false, reason: `installed ${manifest.tag} does not match the lock file` };
  }
  if (!(BINARY_NAME in manifest.files) || !(LICENSE_NAME in manifest.files)) {
    return { ok: false, reason: "manifest is incomplete" };
  }
  for (const [name, entry] of Object.entries(manifest.files)) {
    const path = join(dir, name);
    try {
      if ("symlink" in entry) {
        if ((await readlink(path)) !== entry.symlink)
          return { ok: false, reason: `${name} changed` };
      } else {
        const info = await lstat(path);
        if (!info.isFile() || info.size !== entry.sizeBytes) {
          return { ok: false, reason: `${name} changed` };
        }
        if ((await sha256File(path)) !== entry.sha256)
          return { ok: false, reason: `${name} changed` };
      }
    } catch {
      return { ok: false, reason: `${name} is missing` };
    }
  }
  return { ok: true, manifest };
}

interface PlannedFile {
  name: string;
  /** Set for symlinks: the (same-directory) file the link points at. */
  symlink?: string;
}

async function findBinaryDir(root: string): Promise<string> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const entries = await readdir(next.dir, { withFileTypes: true });
    if (entries.some((e) => e.name === BINARY_NAME && e.isFile())) return next.dir;
    if (next.depth < 2) {
      for (const e of entries) {
        if (e.isDirectory()) queue.push({ dir: join(next.dir, e.name), depth: next.depth + 1 });
      }
    }
  }
  throw new RuntimeError("install-failed", `The archive has no ${BINARY_NAME}`);
}

/**
 * The files to install: `llama-server`, the transitive closure of the non-system libraries it
 * loads (with the version symlinks they are loaded through), and the licence.
 */
export async function planRuntimeFiles(binDir: string, arch: RuntimeArch): Promise<PlannedFile[]> {
  const cpuType = cpuTypeForArch(arch);
  const planned = new Map<string, PlannedFile>();
  const queue = [BINARY_NAME];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || planned.has(name)) continue;
    const path = join(binDir, name);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch {
      throw new RuntimeError(
        "install-failed",
        `${name} is needed by ${BINARY_NAME} but not in the archive`,
      );
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (target.includes("/")) {
        throw new RuntimeError("install-failed", `${name} links outside its directory (${target})`);
      }
      planned.set(name, { name, symlink: target });
      queue.push(target);
      continue;
    }
    if (!info.isFile()) throw new RuntimeError("install-failed", `${name} is not a regular file`);
    const image = await readMachO(path, cpuType);
    if (!image) {
      throw new RuntimeError("install-failed", `${name} is not a Mach-O image for ${arch}`);
    }
    planned.set(name, { name });
    for (const lib of image.dylibs) {
      if (isSystemLibrary(lib.name)) continue;
      const libName = bundledLibraryName(lib.name);
      if (!libName) {
        throw new RuntimeError(
          "install-failed",
          `${name} loads ${lib.name}, which cannot be bundled`,
        );
      }
      if (lib.weak && !(await exists(join(binDir, libName)))) continue;
      queue.push(libName);
    }
  }
  if (!(await exists(join(binDir, LICENSE_NAME)))) {
    throw new RuntimeError("install-failed", `The archive has no ${LICENSE_NAME} file`);
  }
  planned.set(LICENSE_NAME, { name: LICENSE_NAME });
  // Real files first so symlinks never dangle while copying, then a stable order.
  return [...planned.values()].sort(
    (a, b) =>
      Number(a.symlink !== undefined) - Number(b.symlink !== undefined) ||
      a.name.localeCompare(b.name),
  );
}

export interface EnsureTestModelOptions extends DownloadOptions {
  pin: TestModelPin;
  dir?: string;
  log?: (message: string) => void;
}

/** Downloads the pinned test model once into `.cache/test-models/` and verifies its hash. */
export async function ensureTestModel(options: EnsureTestModelOptions): Promise<string> {
  const { pin } = options;
  const log = options.log ?? (() => {});
  const dir = options.dir ?? defaultTestModelDir;
  const path = join(dir, pin.file);
  if (await exists(path)) {
    const info = await stat(path);
    if (info.size === pin.sizeBytes && (await sha256File(path)) === pin.sha256) {
      log(`test model ${pin.file} already present and verified`);
      return path;
    }
    log(`test model ${pin.file} does not match its pin; downloading again`);
    await unlink(path);
  }
  log(`downloading ${pin.repo}@${pin.revision.slice(0, 12)} ${pin.file}`);
  await downloadVerified(pin.url, path, pin, options);
  log(`test model SHA-256 verified (${pin.sha256})`);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
