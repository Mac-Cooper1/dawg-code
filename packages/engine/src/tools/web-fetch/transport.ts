/**
 * The network side of WebFetch: looking a name up, and one HTTPS request to addresses that were
 * checked. Both are injectable so unit tests can run without the internet; the defaults are the
 * only ones the engine ever uses (see `createWebFetchTool` for why tests may swap them).
 *
 * Connecting to the checked address: the request's `lookup` hook hands Node exactly the
 * addresses `checkedAddresses` approved, so the socket cannot go anywhere a second DNS answer
 * would send it (DNS rebinding). TLS still verifies the certificate against the hostname.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { addressRefusal } from "./address.ts";

export interface ResolvedAddress {
  address: string;
  /** 4 or 6. */
  family: number;
}

/** Every address a hostname resolves to. Rejects when the name does not resolve. */
export type Resolver = (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  url: URL;
  /** Where to connect: addresses `checkedAddresses` approved for `url.hostname`. */
  addresses: readonly ResolvedAddress[];
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Header names in lower case. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Stops reading and closes the connection. */
  destroy(): void;
}

/** One GET request. Rejects on a network or TLS failure, or when `signal` aborts. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export const systemResolver: Resolver = async (hostname, signal) => {
  signal.throwIfAborted();
  const found = await dnsLookup(hostname.replace(/^\[|\]$/g, ""), { all: true, order: "verbatim" });
  signal.throwIfAborted();
  return found.map((a) => ({ address: a.address, family: a.family }));
};

/**
 * The addresses to connect to for a hostname, or why it is refused. Every address the name
 * resolves to must be public: a name with one public and one private answer is refused, since
 * which one a connection would use is not ours to choose.
 */
export async function checkedAddresses(
  hostname: string,
  resolve: Resolver,
  signal: AbortSignal,
): Promise<{ ok: true; addresses: ResolvedAddress[] } | { ok: false; reason: string }> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  let found: ResolvedAddress[];
  try {
    found = await resolve(bare, signal);
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    const why =
      code === "ENOTFOUND" || code === "ENODATA" ? "it does not exist" : String(code ?? error);
    return { ok: false, reason: `The name ${bare} could not be looked up: ${why}.` };
  }
  if (found.length === 0) {
    return { ok: false, reason: `The name ${bare} could not be looked up: no addresses.` };
  }
  for (const a of found) {
    const why = addressRefusal(a.address);
    if (why !== null) {
      return {
        ok: false,
        reason: `WebFetch does not fetch local or private addresses: ${bare} resolves to ${a.address}, which is ${why}.`,
      };
    }
  }
  return { ok: true, addresses: found };
}

/** A `lookup` for `http(s).request` that answers with the given addresses only. */
export function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return ((_hostname, options, callback) => {
    const wantAll = typeof options === "object" && options !== null && options.all === true;
    const family = typeof options === "object" && options !== null ? options.family : undefined;
    const usable = addresses.filter(
      (a) => family === undefined || family === 0 || a.family === family,
    );
    const list = usable.length > 0 ? usable : addresses;
    if (wantAll) {
      (callback as (e: null, list: ResolvedAddress[]) => void)(null, [...list]);
      return;
    }
    const first = list[0] as ResolvedAddress;
    (callback as (e: null, address: string, family: number) => void)(
      null,
      first.address,
      first.family,
    );
  }) as LookupFunction;
}

/**
 * HTTPS with the connection pinned to the checked addresses. No connection pooling (each request
 * makes its own socket to its own checked address), no cookies, certificate checks on.
 */
export const httpsTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    if (request.url.protocol !== "https:") {
      reject(new Error(`Only https is fetched, not ${request.url.protocol}`));
      return;
    }
    const req = httpsRequest(request.url, {
      method: "GET",
      headers: request.headers,
      lookup: pinnedLookup(request.addresses),
      agent: false,
      signal: request.signal,
    });
    req.on("response", (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: res,
        destroy: () => {
          res.destroy();
          req.destroy();
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
