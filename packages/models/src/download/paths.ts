import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/** Environment variables that move the Hugging Face cache, as huggingface_hub reads them. */
export interface HubEnv {
  HF_HUB_CACHE?: string;
  HF_HOME?: string;
  XDG_CACHE_HOME?: string;
  HF_ENDPOINT?: string;
}

export const DEFAULT_HUB_URL = "https://huggingface.co";

/**
 * The Hugging Face hub cache directory (the one holding `models--*` folders).
 * Order follows huggingface_hub: `HF_HUB_CACHE`, then `$HF_HOME/hub`, then
 * `$XDG_CACHE_HOME/huggingface/hub`, then `~/.cache/huggingface/hub`.
 */
export function resolveHubCacheDir(
  env: HubEnv = process.env as HubEnv,
  home: string = homedir(),
): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, "hub");
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "huggingface", "hub");
  return join(home, ".cache", "huggingface", "hub");
}

/** The hub base URL: `HF_ENDPOINT` when set, otherwise huggingface.co. */
export function resolveHubUrl(env: HubEnv = process.env as HubEnv): string {
  return (env.HF_ENDPOINT ?? DEFAULT_HUB_URL).replace(/\/+$/, "");
}

/** `org/name` → `models--org--name`. */
export function repoFolderName(repo: string): string {
  return `models--${repo.split("/").join("--")}`;
}

export interface CachePaths {
  /** `<hub>/models--org--name` */
  repoDir: string;
  /** `<repoDir>/blobs/<sha256>`: the finished, verified file. */
  blobPath: string;
  /** `<repoDir>/blobs/<sha256>.incomplete`: partial data while downloading. */
  incompletePath: string;
  /** `<repoDir>/snapshots/<revision>/<file>`: relative symlink to the blob. */
  snapshotPath: string;
  /** The symlink target as written, relative to the snapshot file's directory. */
  snapshotTarget: string;
  /** `<repoDir>/refs/main` */
  mainRefPath: string;
}

export function cachePaths(
  hubDir: string,
  repo: string,
  revision: string,
  file: string,
  sha256: string,
): CachePaths {
  const repoDir = join(hubDir, repoFolderName(repo));
  const blobPath = join(repoDir, "blobs", sha256);
  const snapshotPath = join(repoDir, "snapshots", revision, ...file.split("/"));
  return {
    repoDir,
    blobPath,
    incompletePath: `${blobPath}.incomplete`,
    snapshotPath,
    snapshotTarget: relative(dirname(snapshotPath), blobPath),
    mainRefPath: join(repoDir, "refs", "main"),
  };
}

/** Encodes a repo file path for a URL, keeping the `/` separators. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function resolveUrl(hubUrl: string, repo: string, revision: string, file: string): string {
  return `${hubUrl}/${encodePath(repo)}/resolve/${encodeURIComponent(revision)}/${encodePath(file)}`;
}
