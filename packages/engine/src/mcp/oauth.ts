/**
 * Signing in to remote MCP servers with OAuth (Phase 4 spec, MCP: "Auth"; the MCP authorization
 * specification), on the SDK's client support. `auth()` does the protocol: it discovers the
 * protected resource's metadata and its authorization server's, registers dawg when the server
 * offers dynamic registration, makes the authorization URL with a PKCE (S256) challenge, and
 * exchanges and refreshes tokens. This module adds what an app around it must:
 *
 * - where the browser comes back: a listener on 127.0.0.1, and on ::1 at the same port when the
 *   machine allows it (a browser may try localhost's IPv6 address alone), path `/callback`. The
 *   two take one return carrying the `state` the sign-in was started with, the first to come,
 *   answer with a short plain page, give up after five minutes, and close together. The redirect
 *   URI is `http://localhost:PORT/callback`, the form Claude Code documents for clients
 *   registered in advance;
 * - the settings Claude Code documents in a definition's `oauth` object: a client registered in
 *   advance (`clientId`, its secret from `MCP_CLIENT_SECRET` when signing in), a fixed
 *   `callbackPort`, `authServerMetadataUrl` instead of discovery, and pinned `scopes`;
 * - tokens kept in the credential store (credentials.ts), read again when a server refuses one
 *   (another dawg process may have signed in or renewed it since), and renewed with the refresh
 *   token without asking. A refused renewal makes the server "needs sign-in" again;
 * - a connection that only connects never registers dawg or opens anything: without a token it
 *   is "needs sign-in", and only the person's "Sign in" starts the browser step.
 *
 * Tokens and codes never reach a log, a protocol payload, a note or a reason: the sentences here
 * name what happened, not what was sent.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpOAuthSettings, McpScope, McpServerConfig } from "@dawg/compat";
import type { McpSignInInfo } from "@dawg/protocol";
import {
  type AuthProvider,
  auth,
  extractWWWAuthenticateParams,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {
  credentialId,
  type McpCredentialKey,
  type McpCredentialStore,
  type McpCredentials,
} from "./credentials.ts";

/** How long the browser's return is waited for. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const CALLBACK_PATH = "/callback";
/** How long the first look at the server (for its `WWW-Authenticate`) may take. */
const PROBE_TIMEOUT_MS = 10_000;
/** Longest sentence taken from an error, so a long server answer stays readable. */
const MAX_REASON_CHARS = 240;

export const NEEDS_SIGN_IN = "The server wants you to sign in first.";

/** A remote server dawg can sign in to. */
export interface McpAuthTarget {
  key: McpCredentialKey;
  /** The server's name, for people. */
  name: string;
  url: string;
  /** The definition's own headers, sent to the authorization server too (a proxy's key). */
  headers: Readonly<Record<string, string>>;
  oauth: McpOAuthSettings | null;
}

/**
 * The sign-in a definition has: a remote one without an Authorization header of its own (that
 * header is its credential, as Claude Code treats it). Null for anything else.
 */
export function authTarget(
  name: string,
  scope: McpScope,
  config: McpServerConfig | null,
): McpAuthTarget | null {
  if (config === null || config.type === "stdio") return null;
  if (Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization")) return null;
  let origin: string;
  try {
    origin = new URL(config.url).origin;
  } catch {
    return null;
  }
  if (origin === "null") return null;
  return {
    key: { scope, name, origin },
    name,
    url: config.url,
    headers: config.headers,
    oauth: config.oauth ?? null,
  };
}

/** A sign-in that could not start; the message is for people. */
export class McpSignInError extends Error {
  override name = "McpSignInError";
}

/** A sentence from an error, cut to a readable length; never a secret (see the module note). */
function describe(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim().split("\n")[0] ?? "";
  const plain = text === "" ? "no reason was given" : text;
  return plain.length > MAX_REASON_CHARS ? `${plain.slice(0, MAX_REASON_CHARS - 1)}…` : plain;
}

function minutes(ms: number): string {
  if (ms >= 60_000) {
    const n = Math.round(ms / 60_000);
    return n === 1 ? "a minute" : `${n} minutes`;
  }
  const s = Math.max(1, Math.round(ms / 1000));
  return s === 1 ? "a second" : `${s} seconds`;
}

/**
 * A fetch that adds the definition's headers to requests to the server's own origin (a proxy in
 * front of the server and its sign-in reads them there), never to another origin's
 * authorization server, which was not meant to see them.
 */
function fetchFor(target: McpAuthTarget): FetchLike {
  return (input, init) => {
    const merged = new Headers(init?.headers);
    let origin: string | null = null;
    try {
      origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    } catch {
      // Not an address: fetch says so.
    }
    if (origin === target.key.origin) {
      for (const [key, value] of Object.entries(target.headers)) {
        if (!merged.has(key)) merged.set(key, value);
      }
    }
    return fetch(input, { ...init, headers: merged });
  };
}

/** The loopback port of a registration's redirect URI, if it names one. */
function registeredPort(client: StoredOAuthClientInformation | undefined): number | null {
  const uris = (client as { redirect_uris?: unknown } | undefined)?.redirect_uris;
  if (!Array.isArray(uris)) return null;
  for (const uri of uris) {
    try {
      const url = new URL(String(uri));
      if (url.hostname === "localhost" && url.pathname === CALLBACK_PATH && url.port !== "") {
        return Number(url.port);
      }
    } catch {
      // Not an address: look at the next.
    }
  }
  return null;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Starts one listener on a loopback address; `port` 0 takes any free one. */
function listenOn(host: "127.0.0.1" | "::1", port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const fail = (error: Error) => reject(error);
    server.once("error", fail);
    server.listen({ port, host, exclusive: true, ipv6Only: host === "::1" }, () => {
      server.off("error", fail);
      server.unref();
      resolve(server);
    });
  });
}

/**
 * Listens on 127.0.0.1 (`port` 0 takes any free one), then on ::1 at the same port as well, as a
 * best effort: without IPv6, or with the port taken there, 127.0.0.1 alone serves.
 */
async function listen(port: number): Promise<{ servers: Server[]; port: number }> {
  const v4 = await listenOn("127.0.0.1", port);
  const bound = (v4.address() as AddressInfo).port;
  const v6 = await listenOn("::1", bound).catch(() => null);
  return { servers: v6 === null ? [v4] : [v4, v6], port: bound };
}

function page(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(`${text}\n`);
}

/** A sign-in waiting for the browser. */
interface Flow {
  target: McpAuthTarget;
  /** The listeners, on 127.0.0.1 and maybe ::1: one flow, closed together. */
  servers: Server[];
  redirectUrl: string;
  state: string;
  /** The client secret for a client registered in advance, from MCP_CLIENT_SECRET. */
  secret: string | null;
  verifier: string | null;
  discovery: OAuthDiscoveryState | undefined;
  authorizationUrl: URL | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** True once a matching return is being handled: a second one is not. */
  answering: boolean;
  done: boolean;
  finish: (problem: string | null) => void;
  finished: Promise<string | null>;
}

interface ServerState {
  /** Undefined until read from the store. */
  credentials: McpCredentials | null | undefined;
  flow: Flow | null;
  /** Why the last sign-in or renewal did not work, for people. */
  problem: string | null;
  /** Metadata fetched from the definition's `authServerMetadataUrl`. */
  fixedDiscovery: OAuthDiscoveryState | null;
  /** A renewal on its way: connections that are refused meanwhile wait for it. */
  renewing: Promise<void> | null;
}

export interface McpAuthOptions {
  store: McpCredentialStore;
  /** The environment `MCP_CLIENT_SECRET` is read from when signing in. */
  env?: () => Readonly<Record<string, string | undefined>>;
  /** How long the browser's return is waited for. */
  timeoutMs?: number;
  clientName?: string;
  /** Called once a sign-in finished, so the server's connections start again with the token. */
  onSignedIn?: (target: McpAuthTarget) => void | Promise<void>;
}

export interface SignInStart {
  /** The authorization server's page, for the browser. */
  url: string;
  /** Resolves when the sign-in ended: null once signed in, else why not. */
  finished: Promise<string | null>;
}

export class McpAuth {
  readonly store: McpCredentialStore;
  readonly #options: McpAuthOptions;
  readonly #states = new Map<string, ServerState>();

  constructor(options: McpAuthOptions) {
    this.store = options.store;
    this.#options = options;
  }

  #state(target: McpAuthTarget): ServerState {
    const id = credentialId(target.key);
    let state = this.#states.get(id);
    if (state === undefined) {
      state = {
        credentials: undefined,
        flow: null,
        problem: null,
        fixedDiscovery: null,
        renewing: null,
      };
      this.#states.set(id, state);
    }
    return state;
  }

  /** The server's credentials, read once (or again, with `fresh`). Null when there are none. */
  async load(target: McpAuthTarget, fresh = false): Promise<McpCredentials | null> {
    const state = this.#state(target);
    if (state.credentials !== undefined && !fresh) return state.credentials;
    try {
      state.credentials = await this.store.get(target.key);
    } catch (error) {
      state.problem = describe(error);
      state.credentials ??= null;
    }
    return state.credentials;
  }

  async #save(target: McpAuthTarget, next: McpCredentials): Promise<void> {
    const state = this.#state(target);
    const empty = next.tokens === undefined && next.client === undefined;
    state.credentials = empty ? null : next;
    if (empty) await this.store.delete(target.key);
    else await this.store.set(target.key, next);
  }

  /** Where the server's sign-in stands, as `mcp.list` shows it. */
  status(target: McpAuthTarget): McpSignInInfo {
    const state = this.#state(target);
    if (state.flow !== null) return { status: "signing-in", problem: null };
    const signedIn = state.credentials?.tokens?.access_token !== undefined;
    return { status: signedIn ? "signed-in" : "signed-out", problem: state.problem };
  }

  /** Why the server wants a sign-in now, for its state's reason. */
  reason(target: McpAuthTarget): string {
    return this.#state(target).problem ?? NEEDS_SIGN_IN;
  }

  /** The secret of a client registered in advance, when signing in. */
  #secret(target: McpAuthTarget): string | null {
    if (target.oauth?.clientId == null) return null;
    const secret = (this.#options.env?.() ?? process.env).MCP_CLIENT_SECRET;
    return secret === undefined || secret === "" ? null : secret;
  }

  /** The `authServerMetadataUrl`'s metadata, fetched once. */
  async #fixedDiscovery(
    target: McpAuthTarget,
    fetchFn: FetchLike,
  ): Promise<OAuthDiscoveryState | null> {
    const url = target.oauth?.authServerMetadataUrl ?? null;
    if (url === null) return null;
    const state = this.#state(target);
    if (state.fixedDiscovery !== null) return state.fixedDiscovery;
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`its authorization server's metadata answered HTTP ${response.status}`);
    }
    const metadata = (await response.json()) as Record<string, unknown>;
    for (const field of ["issuer", "authorization_endpoint", "token_endpoint"]) {
      if (typeof metadata[field] !== "string") {
        throw new Error(`its authorization server's metadata has no ${field}`);
      }
    }
    state.fixedDiscovery = {
      authorizationServerUrl: metadata.issuer as string,
      authorizationServerMetadata: metadata as unknown as NonNullable<
        OAuthDiscoveryState["authorizationServerMetadata"]
      >,
    };
    return state.fixedDiscovery;
  }

  /** The scopes to ask for: pinned in the definition, else the fixed metadata's. */
  #scope(target: McpAuthTarget, challenged: string | undefined): string | undefined {
    if (target.oauth?.scopes != null) return target.oauth.scopes;
    const fixed = this.#state(target).fixedDiscovery?.authorizationServerMetadata?.scopes_supported;
    if (Array.isArray(fixed) && fixed.length > 0) return fixed.join(" ");
    return challenged;
  }

  /**
   * The SDK's view of one server: during a sign-in (`flow`), everything; otherwise only what a
   * renewal needs. Without a flow it cannot register dawg (`saveClientInformation` is left out,
   * so the SDK stops there) and its authorization URL goes nowhere.
   */
  #provider(target: McpAuthTarget, flow: Flow | null): OAuthClientProvider {
    const state = this.#state(target);
    const pinned = target.oauth?.clientId ?? null;
    const clientName = this.#options.clientName ?? "dawg-code";
    const credentials = () => state.credentials ?? {};
    const redirectUrl = (): string => {
      if (flow !== null) return flow.redirectUrl;
      const port = registeredPort(credentials().client) ?? target.oauth?.callbackPort ?? null;
      return `http://localhost${port === null ? "" : `:${port}`}${CALLBACK_PATH}`;
    };
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return redirectUrl();
      },
      get clientMetadata(): OAuthClientMetadata {
        const secret = flow?.secret ?? null;
        return {
          client_name: clientName,
          redirect_uris: [redirectUrl()],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: secret === null ? "none" : "client_secret_post",
          ...(target.oauth?.scopes == null ? {} : { scope: target.oauth.scopes }),
        };
      },
      state: () => flow?.state ?? randomBytes(24).toString("base64url"),
      clientInformation: (ctx) => {
        const stored = credentials().client;
        if (pinned === null) return stored;
        if (stored !== undefined && stored.client_id === pinned) return stored;
        const secret = flow?.secret ?? null;
        // Bound to the authorization server it is used with, as the SDK keeps registrations.
        return {
          client_id: pinned,
          ...(secret === null ? {} : { client_secret: secret }),
          ...(ctx?.issuer === undefined ? {} : { issuer: ctx.issuer }),
        };
      },
      tokens: () => credentials().tokens,
      saveTokens: async (tokens) => {
        state.problem = null;
        const next: McpCredentials = { ...credentials(), tokens };
        if (pinned !== null && flow !== null && next.client?.client_id !== pinned) {
          // The client registered in advance is kept with its secret, for renewals later.
          next.client = {
            client_id: pinned,
            ...(flow.secret === null ? {} : { client_secret: flow.secret }),
            ...(tokens.issuer === undefined ? {} : { issuer: tokens.issuer }),
          };
        }
        await this.#save(target, next);
      },
      redirectToAuthorization: (url) => {
        // Only a sign-in the person started takes them to the browser.
        if (flow !== null) flow.authorizationUrl = url;
      },
      saveCodeVerifier: (verifier) => {
        if (flow !== null) flow.verifier = verifier;
      },
      codeVerifier: () => {
        if (flow?.verifier == null) throw new Error("No sign-in is on its way.");
        return flow.verifier;
      },
      saveDiscoveryState: (discovery) => {
        if (flow !== null) flow.discovery = discovery;
      },
      discoveryState: () => flow?.discovery ?? state.fixedDiscovery ?? undefined,
      invalidateCredentials: async (scope) => {
        const current = { ...credentials() };
        if (scope === "all" || scope === "tokens") delete current.tokens;
        if (scope === "all" || scope === "client") delete current.client;
        if ((scope === "all" || scope === "verifier") && flow !== null) flow.verifier = null;
        if ((scope === "all" || scope === "discovery") && flow !== null) flow.discovery = undefined;
        if (scope === "all" || scope === "tokens" || scope === "client") {
          await this.#save(target, current);
        }
      },
    };
    if (flow !== null) {
      provider.saveClientInformation = async (client) => {
        await this.#save(target, { ...credentials(), client });
      };
    }
    return provider;
  }

  /**
   * What a connection's transport uses: the stored token before each request, and when the
   * server refuses it, a newer one another process saved, or a renewal with the refresh token.
   * Throws `UnauthorizedError` when only a new sign-in can help.
   */
  transportProvider(target: McpAuthTarget): AuthProvider {
    return {
      token: async () => (await this.load(target))?.tokens?.access_token,
      onUnauthorized: async (ctx) => {
        const state = this.#state(target);
        const sent = state.credentials?.tokens?.access_token;
        // One renewal at a time: a refresh token may be good for one use only.
        while (state.renewing !== null) await state.renewing.catch(() => {});
        const stored = await this.load(target, true);
        const now = stored?.tokens?.access_token;
        if (now !== undefined && now !== sent) return; // Signed in or renewed elsewhere: try it.
        const registered = stored?.client !== undefined || target.oauth?.clientId != null;
        if (stored?.tokens?.refresh_token === undefined || !registered) {
          throw new UnauthorizedError(this.reason(target));
        }
        const { resourceMetadataUrl } = extractWWWAuthenticateParams(ctx.response);
        const renewal = (async () => {
          let result: Awaited<ReturnType<typeof auth>>;
          const fetchFn = fetchFor(target);
          try {
            await this.#fixedDiscovery(target, fetchFn);
            result = await auth(this.#provider(target, null), {
              serverUrl: ctx.serverUrl,
              fetchFn,
              ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
            });
          } catch (error) {
            state.problem = `Renewing the sign-in failed: ${describe(error)}.`;
            throw new UnauthorizedError(this.reason(target));
          }
          if (result !== "AUTHORIZED") {
            state.problem = "The sign-in ran out and the server would not renew it. Sign in again.";
            throw new UnauthorizedError(this.reason(target));
          }
        })();
        state.renewing = renewal;
        try {
          await renewal;
        } finally {
          if (state.renewing === renewal) state.renewing = null;
        }
      },
    };
  }

  /** The server's own answer to a first request: the challenge's metadata address and scope. */
  async #probe(
    target: McpAuthTarget,
    fetchFn: FetchLike,
  ): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
    try {
      const response = await fetchFn(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: this.#options.clientName ?? "dawg-code", version: "0.0.0" },
          },
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (response.status !== 401 && response.status !== 403) return {};
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
      return {
        ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
        ...(scope === undefined ? {} : { scope }),
      };
    } catch {
      return {}; // Discovery at the well-known addresses still works.
    }
  }

  /**
   * Starts a sign-in: listens for the browser's return, then has the SDK discover, register and
   * make the authorization URL. Resolves with that URL; `finished` says how it ended. A sign-in
   * already on its way for the server is stopped first.
   */
  async signIn(target: McpAuthTarget): Promise<SignInStart> {
    this.cancel(target);
    const state = this.#state(target);
    state.problem = null;
    const credentials = (await this.load(target, true)) ?? {};
    const pinned = target.oauth?.clientId ?? null;
    const fixedPort = target.oauth?.callbackPort ?? null;
    // The port: the one the definition names, else the one dawg registered with before (some
    // servers want the redirect URI exactly as registered), else any free one.
    let listening: { servers: Server[]; port: number };
    try {
      if (fixedPort !== null) listening = await listen(fixedPort);
      else {
        const before = pinned === null ? registeredPort(credentials.client) : null;
        listening =
          (before === null ? null : await listen(before).catch(() => null)) ?? (await listen(0));
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new McpSignInError(
        code === "EADDRINUSE"
          ? `Could not sign in to ${target.name}: port ${fixedPort} (its oauth.callbackPort) is in use by another program.`
          : `Could not sign in to ${target.name}: ${describe(error)}.`,
      );
    }
    const redirectUrl = `http://localhost:${listening.port}${CALLBACK_PATH}`;
    if (pinned === null && credentials.client !== undefined) {
      const uris = (credentials.client as { redirect_uris?: unknown }).redirect_uris;
      // A registration for another return address would be refused: register again.
      if (!Array.isArray(uris) || !uris.includes(redirectUrl)) {
        const { client: _old, ...rest } = credentials;
        await this.#save(target, rest).catch(() => {});
      }
    }

    let finish: (problem: string | null) => void = () => {};
    const finished = new Promise<string | null>((resolve) => {
      finish = resolve;
    });
    const flow: Flow = {
      target,
      servers: listening.servers,
      redirectUrl,
      state: randomBytes(24).toString("base64url"),
      secret: this.#secret(target),
      verifier: null,
      discovery: undefined,
      authorizationUrl: null,
      timer: null,
      answering: false,
      done: false,
      finish,
      finished,
    };
    state.flow = flow;
    for (const server of listening.servers) {
      server.on("request", (req, res) => void this.#answer(flow, req, res));
    }

    const fetchFn = fetchFor(target);
    try {
      const fixed = await this.#fixedDiscovery(target, fetchFn);
      if (fixed !== null) flow.discovery = fixed;
      const challenge = fixed === null ? await this.#probe(target, fetchFn) : {};
      const scope = this.#scope(target, challenge.scope);
      await auth(this.#provider(target, flow), {
        serverUrl: target.url,
        fetchFn,
        forceReauthorization: true,
        ...(scope === undefined ? {} : { scope }),
        ...(challenge.resourceMetadataUrl === undefined
          ? {}
          : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
      });
    } catch (error) {
      const problem = `Could not start signing in to ${target.name}: ${describe(error)}.`;
      this.#end(flow, problem);
      throw new McpSignInError(problem);
    }
    if (flow.authorizationUrl === null) {
      const problem = `Could not start signing in to ${target.name}: its authorization server gave no address to sign in at.`;
      this.#end(flow, problem);
      throw new McpSignInError(problem);
    }
    const timeoutMs = this.#options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    flow.timer = setTimeout(
      () =>
        this.#end(
          flow,
          `Nobody finished signing in within ${minutes(timeoutMs)}, so dawg stopped waiting. Sign in again.`,
        ),
      timeoutMs,
    );
    flow.timer.unref?.();
    return { url: flow.authorizationUrl.href, finished };
  }

  /** The browser's return. */
  async #answer(flow: Flow, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      page(res, 404, "Not found.");
      return;
    }
    const name = flow.target.name;
    const returned = url.searchParams.get("state");
    if (flow.done || returned === null || !sameText(returned, flow.state)) {
      // Not the sign-in dawg started (a stale tab, or a page that forged it): keep waiting.
      page(res, 400, `This is not the sign-in to ${name} that dawg is waiting for.`);
      return;
    }
    if (flow.answering) {
      page(res, 409, `dawg is already finishing the sign-in to ${name}.`);
      return;
    }
    flow.answering = true;
    const error = url.searchParams.get("error");
    if (error !== null) {
      // Only the error's code: its description comes from whoever made the page.
      const code = error.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) || "error";
      page(res, 200, `Signing in to ${name} did not finish (${code}). You can close this tab.`);
      this.#end(
        flow,
        code === "access_denied"
          ? "The sign-in was declined at the authorization server."
          : `The authorization server did not sign you in (${code}).`,
      );
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null || code === "") {
      page(res, 400, `The sign-in to ${name} came back without a code. Sign in again from dawg.`);
      this.#end(flow, "The authorization server came back without a code.");
      return;
    }
    const iss = url.searchParams.get("iss");
    try {
      const result = await auth(this.#provider(flow.target, flow), {
        serverUrl: flow.target.url,
        authorizationCode: code,
        fetchFn: fetchFor(flow.target),
        ...(iss === null ? {} : { iss }),
      });
      if (result !== "AUTHORIZED") throw new Error("the authorization server gave no token");
    } catch (error) {
      page(res, 200, `Could not sign in to ${name}. dawg says why; you can close this tab.`);
      this.#end(flow, `Could not finish signing in: ${describe(error)}.`);
      return;
    }
    page(res, 200, `Signed in to ${name}. You can close this tab.`);
    this.#end(flow, null);
    await Promise.resolve(this.#options.onSignedIn?.(flow.target)).catch(() => {});
  }

  #end(flow: Flow, problem: string | null): void {
    if (flow.done) return;
    flow.done = true;
    if (flow.timer !== null) clearTimeout(flow.timer);
    for (const server of flow.servers) {
      server.close();
      server.closeAllConnections?.();
    }
    const state = this.#state(flow.target);
    if (state.flow === flow) state.flow = null;
    state.problem = problem;
    flow.finish(problem);
  }

  /** Stops a sign-in on its way. True when there was one. */
  cancel(target: McpAuthTarget): boolean {
    const flow = this.#state(target).flow;
    if (flow === null) return false;
    this.#end(flow, null);
    return true;
  }

  /** Forgets the server's tokens and dawg's registration with it. */
  async signOut(target: McpAuthTarget): Promise<void> {
    this.cancel(target);
    const state = this.#state(target);
    state.credentials = null;
    state.problem = null;
    state.fixedDiscovery = null;
    await this.store.delete(target.key);
  }

  /** Stops every sign-in on its way. */
  close(): void {
    for (const state of this.#states.values()) {
      if (state.flow !== null) this.#end(state.flow, null);
    }
  }
}
