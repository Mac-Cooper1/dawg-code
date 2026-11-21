/**
 * Installs the pinned ripgrep into `apps/desktop/resources/bin/<target>/`: the `rg` binary, the
 * licence files it ships with, and a manifest recording what was installed so that a later run
 * can check the installation without downloading again.
 */
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { downloadVerified, sha256File } from "@dawg/models";
import { z } from "zod";
import { currentTarget, defaultBinRoot, type RipgrepLock, type RipgrepTarget } from "./lock.ts";

const execFileAsync = promisify(execFile);

export const RIPGREP_BINARY = "rg";
export const RIPGREP_MANIFEST = "ripgrep-manifest.json";

const manifestSchema = z.object({
  version: z.string(),
  target: z.string(),
  archive: z.object({ name: z.string(), sha256: z.string() }),
  files: z.record(z.string(), z.object({ sha256: z.string(), sizeBytes: z.number() })),
});
export type RipgrepManifest = z.infer<typeof manifestSchema>;

export interface InstallRipgrepOptions {
  target: RipgrepTarget;
  lock: RipgrepLock;
  /** Parent of the per-target directories. Defaults to `apps/desktop/resources/bin`. */
  binRoot?: string;
  /** Scratch space for the download and its extraction. Defaults to the OS temp directory. */
  tmpDir?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface InstallRipgrepResult {
  target: RipgrepTarget;
  dir: string;
  binary: string;
  action: "installed" | "already-present";
  /** `rg --version`'s first line, when the binary is for this machine. */
  version: string | null;
}

export async function installRipgrep(
  options: InstallRipgrepOptions,
): Promise<InstallRipgrepResult> {
  const { target, lock } = options;
  const log = options.log ?? (() => {});
  const pin = lock.ripgrep;
  const archive = pin.archives[target];
  const dir = path.join(options.binRoot ?? defaultBinRoot, target);
  const binary = path.join(dir, RIPGREP_BINARY);
  const expectedFiles = [RIPGREP_BINARY, ...pin.licenceFiles];

  const existing = await verifyInstalledRipgrep(dir, {
    version: pin.version,
    target,
    archiveSha256: archive.sha256,
    files: expectedFiles,
  });
  if (existing.ok) {
    log(`${target}: ripgrep ${pin.version} already present and verified in ${dir}`);
    return {
      target,
      dir,
      binary,
      action: "already-present",
      version: await runVersion(binary, target),
    };
  }
  if (existing.reason !== "missing") log(`${target}: reinstalling (${existing.reason})`);

  const work = await mkdtemp(path.join(options.tmpDir ?? tmpdir(), "dawg-ripgrep-"));
  try {
    const archivePath = path.join(work, archive.name);
    log(`${target}: downloading ${archive.url}`);
    await downloadVerified(archive.url, archivePath, archive, { fetchImpl: options.fetchImpl });
    log(`${target}: SHA-256 verified (${archive.sha256})`);

    const extractDir = path.join(work, "extract");
    await mkdir(extractDir);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir]);
    const sourceDir = await findDirHolding(extractDir, RIPGREP_BINARY);

    await mkdir(dir, { recursive: true });
    // Without a manifest the directory reads as "missing", so an interrupted install is redone.
    await rm(path.join(dir, RIPGREP_MANIFEST), { force: true });
    const manifest: RipgrepManifest = {
      version: pin.version,
      target,
      archive: { name: archive.name, sha256: archive.sha256 },
      files: {},
    };
    for (const name of expectedFiles) {
      const source = path.join(sourceDir, name);
      const info = await lstat(source).catch(() => null);
      if (!info?.isFile()) throw new Error(`The ripgrep archive has no regular file ${name}`);
      const staged = path.join(dir, `.${name}.tmp-${process.pid}`);
      await copyFile(source, staged);
      await chmod(staged, name === RIPGREP_BINARY ? 0o755 : 0o644);
      await rename(staged, path.join(dir, name));
      manifest.files[name] = {
        sha256: await sha256File(path.join(dir, name)),
        sizeBytes: info.size,
      };
    }
    const manifestTmp = path.join(dir, `.${RIPGREP_MANIFEST}.tmp-${process.pid}`);
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(manifestTmp, path.join(dir, RIPGREP_MANIFEST));
    log(`${target}: installed ${expectedFiles.join(", ")} into ${dir}`);
    return { target, dir, binary, action: "installed", version: await runVersion(binary, target) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export type VerifyRipgrepResult =
  | { ok: true; manifest: RipgrepManifest }
  | { ok: false; reason: string };

/** Checks an installed directory against the lock entry and the manifest written at install. */
export async function verifyInstalledRipgrep(
  dir: string,
  expected: { version: string; target: string; archiveSha256: string; files: string[] },
): Promise<VerifyRipgrepResult> {
  let manifest: RipgrepManifest;
  try {
    const text = await readFile(path.join(dir, RIPGREP_MANIFEST), "utf8");
    manifest = manifestSchema.parse(JSON.parse(text));
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (
    manifest.version !== expected.version ||
    manifest.target !== expected.target ||
    manifest.archive.sha256 !== expected.archiveSha256
  ) {
    return {
      ok: false,
      reason: `installed ripgrep ${manifest.version} does not match the lock file`,
    };
  }
  for (const name of expected.files) {
    const entry = manifest.files[name];
    if (!entry) return { ok: false, reason: "manifest is incomplete" };
    const file = path.join(dir, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.size !== entry.sizeBytes)
      return { ok: false, reason: `${name} changed` };
    if ((await sha256File(file)) !== entry.sha256) return { ok: false, reason: `${name} changed` };
  }
  return { ok: true, manifest };
}

async function findDirHolding(root: string, name: string): Promise<string> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const entries = await readdir(next.dir, { withFileTypes: true });
    if (entries.some((e) => e.name === name && e.isFile())) return next.dir;
    if (next.depth < 2) {
      for (const e of entries) {
        if (e.isDirectory())
          queue.push({ dir: path.join(next.dir, e.name), depth: next.depth + 1 });
      }
    }
  }
  throw new Error(`The ripgrep archive has no ${name}`);
}

/** `rg --version`'s first line, or null when the binary is for another platform or fails. */
async function runVersion(binary: string, target: string): Promise<string | null> {
  if (target !== currentTarget()) return null;
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 10_000 });
    return stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}
