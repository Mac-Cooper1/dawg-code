import http from "node:http";
import https from "node:https";
import type { Transform } from "node:stream";
import zlib from "node:zlib";

/** Raised when the upstream sends nothing for longer than the idle timeout. */
export class UpstreamTimeoutError extends Error {
  constructor(ms: number) {
    super(`upstream timed out (no data for ${ms} ms)`);
    this.name = "UpstreamTimeoutError";
  }
}

/** Keep-alive connection pools for one proxy instance. */
export class UpstreamAgents {
  readonly http = new http.Agent({ keepAlive: true });
  readonly https = new https.Agent({ keepAlive: true });

  destroy(): void {
    this.http.destroy();
    this.https.destroy();
  }
}

export interface UpstreamRequest {
  url: URL;
  method: string;
  headers: http.OutgoingHttpHeaders;
  body: Buffer | null;
  signal: AbortSignal;
  /** Abort when the socket is idle this long (before or during the response). 0 = never. */
  idleTimeoutMs: number;
  agents: UpstreamAgents;
}

/**
 * Send a request upstream with node:http(s), which (unlike fetch) leaves the response bytes
 * exactly as sent, compressed or not. Resolves once response headers arrive.
 */
export function sendUpstream(options: UpstreamRequest): Promise<http.IncomingMessage> {
  const { url, method, body, signal, idleTimeoutMs } = options;
  const headers = { ...options.headers };
  if (body !== null) headers["content-length"] = String(body.length);
  else if (method !== "GET" && method !== "HEAD") headers["content-length"] = "0";
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      headers,
      signal,
      agent: isHttps ? options.agents.https : options.agents.http,
    });
    let response: http.IncomingMessage | null = null;
    if (idleTimeoutMs > 0) {
      // Socket inactivity, before and while the response body streams.
      req.setTimeout(idleTimeoutMs, () => {
        const err = new UpstreamTimeoutError(idleTimeoutMs);
        // Fail the body stream with the timeout itself, not a generic "aborted".
        response?.destroy(err);
        req.destroy(err);
      });
    }
    req.once("response", (res) => {
      response = res;
      resolve(res);
    });
    req.once("error", reject);
    req.end(body ?? undefined);
  });
}

/** Human-readable description of a transport error. */
export function describeTransportError(err: unknown): string {
  if (err instanceof UpstreamTimeoutError) return err.message;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED") return `upstream connection refused (${err.message})`;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN")
      return `upstream host not found (${err.message})`;
    if (code === "ECONNRESET") return `upstream connection reset (${err.message})`;
    if (err.name === "AbortError") return "request aborted";
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

export function isTimeout(err: unknown): boolean {
  return err instanceof UpstreamTimeoutError;
}

/**
 * Decompresses a response body for parsing (the client still receives the original bytes).
 * Returns null for encodings we cannot decode; the caller then skips parsing.
 */
export function bodyDecoder(
  contentEncoding: string | string[] | undefined,
  sink: (chunk: Buffer) => void,
): { write(chunk: Buffer): void; end(): Promise<void> } | null {
  const encoding = (Array.isArray(contentEncoding) ? contentEncoding.join(",") : contentEncoding)
    ?.trim()
    .toLowerCase();
  if (!encoding || encoding === "identity") {
    return { write: sink, end: async () => {} };
  }
  let stream: Transform;
  const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  if (encoding === "gzip" || encoding === "x-gzip") stream = zlib.createGunzip(flush);
  else if (encoding === "deflate") stream = zlib.createInflate(flush);
  else if (encoding === "br") stream = zlib.createBrotliDecompress();
  else if (encoding === "zstd" && typeof zlib.createZstdDecompress === "function") {
    stream = zlib.createZstdDecompress();
  } else return null;
  let failed = false;
  stream.on("data", (chunk: Buffer) => {
    if (!failed) sink(chunk);
  });
  const done = new Promise<void>((resolve) => {
    stream.once("end", () => resolve());
    stream.once("error", () => {
      failed = true;
      resolve();
    });
  });
  return {
    write(chunk) {
      if (!failed) stream.write(chunk);
    },
    end() {
      if (!failed) stream.end();
      return done;
    },
  };
}
