/**
 * Downloading one page for WebFetch: the address check before every connection (the first and
 * each redirect), same-site redirects followed and others reported, a byte cap that also applies
 * after decompression, and a deadline over the whole download.
 */
import { pipeline, Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  checkedAddresses,
  type Resolver,
  type Transport,
  type TransportResponse,
} from "./transport.ts";
import { parseTarget, sameSite, upgrade } from "./url.ts";

/** Redirects followed within one site before giving up. */
export const MAX_REDIRECTS = 10;

export const USER_AGENT = "dawg-code-WebFetch/1.0 (+https://github.com/Mac-Cooper1/dawg-code)";

/**
 * As documented for WebFetch, an `Accept` header that prefers Markdown, so servers that
 * negotiate content can send it directly (code.claude.com/docs/en/tools-reference, "Identify
 * WebFetch requests to your site").
 */
export const ACCEPT =
  "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.5";

export interface DownloadOptions {
  resolve: Resolver;
  transport: Transport;
  maxBytes: number;
  timeoutMs: number;
  /** The turn's signal: when it aborts, the download throws. */
  signal: AbortSignal;
}

export type Download =
  | {
      kind: "page";
      /** The URL the content came from, after same-site redirects. */
      url: string;
      status: number;
      /** Lower case, without parameters; "" when the server sent none. */
      mediaType: string;
      /** The `charset` parameter, if any. */
      charset: string | null;
      body: Uint8Array;
    }
  /** The page moved to another host; the model is told, and decides whether to fetch it. */
  | { kind: "redirect"; url: string; status: number; location: string }
  /** Refused for safety, before or between connections. */
  | { kind: "refused"; reason: string }
  /** Could not be downloaded: network, TLS, status, size or time. */
  | { kind: "failed"; reason: string; status?: number };

class TooLarge extends Error {}

function header(response: TransportResponse, name: string): string | null {
  const value = response.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function mediaTypeOf(value: string | null): { mediaType: string; charset: string | null } {
  if (value === null) return { mediaType: "", charset: null };
  const [type, ...params] = value.split(";");
  let charset: string | null = null;
  for (const param of params) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(param);
    if (match?.[1]) charset = match[1];
  }
  return { mediaType: (type ?? "").trim().toLowerCase(), charset };
}

/** The body, decompressed as the server says, cut off with `TooLarge` past `maxBytes`. */
async function readBody(response: TransportResponse, maxBytes: number): Promise<Uint8Array> {
  const encoding = (header(response, "content-encoding") ?? "identity").trim().toLowerCase();
  let source: AsyncIterable<Uint8Array> = response.body;
  // `pipeline` passes a failure of the download on to the decompressor, so reading it throws.
  const through = (decoder: Transform): AsyncIterable<Uint8Array> => {
    pipeline(Readable.from(response.body), decoder, () => {});
    return decoder;
  };
  if (encoding === "gzip" || encoding === "x-gzip") {
    source = through(createGunzip());
  } else if (encoding === "deflate") {
    source = through(createInflate());
  } else if (encoding === "br") {
    source = through(createBrotliDecompress());
  } else if (encoding !== "identity" && encoding !== "") {
    throw new Error(`the server used an encoding WebFetch cannot read (${encoding})`);
  }
  const declared = Number(header(response, "content-length"));
  if (encoding === "identity" && Number.isFinite(declared) && declared > maxBytes) {
    throw new TooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new TooLarge();
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Downloads `url` (already upgraded to https and checked by `parseTarget`). Throws only when
 * the turn's signal aborts.
 */
export async function download(start: URL, options: DownloadOptions): Promise<Download> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([options.signal, deadline]);
  const timedOut = (): Download => ({
    kind: "failed",
    reason: `The download did not finish within ${Math.round(options.timeoutMs / 1000)} seconds.`,
  });
  let url = start;
  for (let hop = 0; ; hop++) {
    const checked = await checkedAddresses(url.hostname, options.resolve, signal).catch(
      (error: unknown) => {
        options.signal.throwIfAborted();
        if (deadline.aborted) return null;
        throw error;
      },
    );
    if (checked === null) return timedOut();
    if (!checked.ok) return { kind: "refused", reason: checked.reason };

    let response: TransportResponse;
    try {
      response = await options.transport({
        url,
        addresses: checked.addresses,
        headers: {
          "user-agent": USER_AGENT,
          accept: ACCEPT,
          "accept-encoding": "gzip, deflate, br",
        },
        signal,
      });
    } catch (error) {
      options.signal.throwIfAborted();
      if (deadline.aborted) return timedOut();
      return { kind: "failed", reason: `${url.host} could not be reached: ${messageOf(error)}.` };
    }

    const status = response.status;
    if (status >= 300 && status < 400 && status !== 304) {
      response.destroy();
      const location = header(response, "location");
      if (location === null) {
        return {
          kind: "failed",
          status,
          reason: `The server answered ${status} without saying where to.`,
        };
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { kind: "failed", status, reason: `The server redirected to an invalid URL.` };
      }
      const target = parseTarget(next.href);
      if (!target.ok)
        return { kind: "refused", reason: `The page redirects to ${next.href}. ${target.reason}` };
      next = upgrade(target.url);
      if (!sameSite(url, next)) {
        return { kind: "redirect", url: url.href, status, location: next.href };
      }
      if (hop >= MAX_REDIRECTS) {
        return {
          kind: "failed",
          status,
          reason: `The page redirected more than ${MAX_REDIRECTS} times.`,
        };
      }
      url = next;
      continue;
    }

    if (status < 200 || status >= 300) {
      response.destroy();
      return { kind: "failed", status, reason: `The server answered ${status} for ${url.href}.` };
    }
    try {
      const body = await readBody(response, options.maxBytes);
      const { mediaType, charset } = mediaTypeOf(header(response, "content-type"));
      return { kind: "page", url: url.href, status, mediaType, charset, body };
    } catch (error) {
      response.destroy();
      options.signal.throwIfAborted();
      if (deadline.aborted) return timedOut();
      if (error instanceof TooLarge) {
        return {
          kind: "failed",
          status,
          reason: `The page is larger than ${sizeText(options.maxBytes)}, the most WebFetch downloads.`,
        };
      }
      return { kind: "failed", status, reason: `The download failed: ${messageOf(error)}.` };
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined && !error.message.includes(code)
      ? `${error.message} (${code})`
      : error.message;
  }
  return String(error);
}
