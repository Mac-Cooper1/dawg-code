import { z } from "zod";
import { encodePath } from "./paths.ts";

const TreeItemSchema = z.object({
  type: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative().optional(),
  lfs: z.object({ oid: z.string(), size: z.number().int().nonnegative() }).optional().nullable(),
});

export interface RepoFile {
  path: string;
  sizeBytes: number;
  /** SHA-256 of the content, present for files stored with Git LFS (every GGUF). */
  sha256?: string;
}

export interface ListOptions {
  hubUrl: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** An HTTP failure from the hub, with the status so callers can tell retryable from final. */
export class HubHttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HubHttpError";
    this.status = status;
  }
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Lists the files in one directory of a repo at a revision
 * (`GET /api/models/{repo}/tree/{revision}[/{dir}]`), following `Link: rel="next"` pages.
 */
export async function listRepoFiles(
  repo: string,
  revision: string,
  dir: string,
  options: ListOptions,
): Promise<RepoFile[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const suffix = dir ? `/${encodePath(dir)}` : "";
  let url: string | null =
    `${options.hubUrl}/api/models/${encodePath(repo)}/tree/${encodeURIComponent(revision)}${suffix}`;
  const files: RepoFile[] = [];
  while (url) {
    const response = await fetchImpl(url, {
      signal: options.signal,
      headers: { accept: "application/json", ...options.headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HubHttpError(response.status, url);
    }
    const items = z.array(TreeItemSchema).parse(await response.json());
    for (const item of items) {
      if (item.type !== "file") continue;
      files.push({
        path: item.path,
        sizeBytes: item.lfs?.size ?? item.size ?? 0,
        ...(item.lfs ? { sha256: item.lfs.oid } : {}),
      });
    }
    const next = nextLink(response.headers.get("link"));
    url = next ? new URL(next, url).toString() : null;
  }
  return files;
}
