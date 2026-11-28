/**
 * A test authorization server and an MCP server it protects, written by hand on node:http from
 * the MCP authorization specification (OAuth 2.1, RFC 9728, RFC 8414, RFC 7591, RFC 7636):
 *
 * - the MCP server answers 401 with `WWW-Authenticate` (its resource metadata) without a valid
 *   token, and otherwise speaks enough MCP for a client: initialize, tools/list, tools/call;
 * - its protected resource metadata names the authorization server;
 * - the authorization server publishes its metadata, registers clients dynamically (or not),
 *   and its authorize endpoint redirects straight back with a code (nobody to log in), checking
 *   the client, the redirect URI and the PKCE challenge;
 * - its token endpoint exchanges codes (checking the verifier) and refreshes tokens, rotating
 *   the refresh token each time.
 *
 * Two servers on two ports, so the authorization server is another origin, as it usually is.
 * The test controls it: tokens can be made to run out, refreshes refused, sign-ins declined.
 *
 * Run as a script (`node oauth-server.ts`), for tests in another package or process: it prints
 * `{"mcpUrl": …, "issuer": …}` on one line, and `GET <issuer>/test/state` answers with what
 * happened so far (registrations, authorize and token requests, the tokens issued).
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

export interface OAuthTestServerOptions {
  /** Offer dynamic client registration. Default true. */
  registration?: boolean;
  /** Clients registered in advance, by id. */
  clients?: Record<string, { secret?: string; redirectUris: string[] }>;
  /** Seconds an access token lasts, as the token response says. Default 3600. */
  expiresIn?: number;
  scopesSupported?: string[];
  /** The MCP server's name in its `serverInfo`. Default "secure". */
  serverName?: string;
}

export interface OAuthTestServer {
  /** The MCP server: "http://127.0.0.1:P/mcp". */
  mcpUrl: string;
  /** The authorization server's issuer: "http://127.0.0.1:Q". */
  issuer: string;
  /** Registrations made, with the redirect URIs each asked for. */
  registrations: { clientId: string; redirectUris: string[] }[];
  /** Every authorize request's parameters, in order. */
  authorizeRequests: URLSearchParams[];
  /** Every token request's grant type and client, in order. */
  tokenRequests: { grant: string; clientId: string | null; secret: string | null }[];
  /** Requests to the MCP server: the token each carried (null for none), and if it was good. */
  mcpRequests: { method: string; bearer: string | null; authorized: boolean }[];
  /** Every access and refresh token issued, to check none leaks. */
  issued: string[];
  /** Refuses every access token issued so far, as if they ran out. */
  expireAccessTokens(): void;
  /** Refresh requests are answered with invalid_grant while true. */
  refuseRefresh: boolean;
  /** The next authorize request redirects back with this error instead of a code. */
  denyNext: string | null;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

function send(res: ServerResponse, status: number, body: Json | null, headers: Json = {}): void {
  res.writeHead(status, {
    ...(body === null ? {} : { "content-type": "application/json" }),
    "cache-control": "no-store",
    ...(headers as Record<string, string>),
  });
  res.end(body === null ? undefined : JSON.stringify(body));
}

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function startOAuthTestServer(
  options: OAuthTestServerOptions = {},
): Promise<OAuthTestServer> {
  const registration = options.registration ?? true;
  const expiresIn = options.expiresIn ?? 3600;
  const scopes = options.scopesSupported ?? ["mcp:read", "mcp:write"];
  const clients = new Map<string, { secret?: string; redirectUris: string[] }>(
    Object.entries(options.clients ?? {}),
  );
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; scope: string | null }
  >();
  const access = new Set<string>();
  const refresh = new Map<string, { clientId: string; scope: string | null }>();

  const as = createServer();
  const rs = createServer();
  const asPort = await listen(as);
  const rsPort = await listen(rs);
  const issuer = `http://127.0.0.1:${asPort}`;
  const rsBase = `http://127.0.0.1:${rsPort}`;
  const mcpUrl = `${rsBase}/mcp`;

  const state: OAuthTestServer = {
    mcpUrl,
    issuer,
    registrations: [],
    authorizeRequests: [],
    tokenRequests: [],
    mcpRequests: [],
    issued: [],
    expireAccessTokens: () => access.clear(),
    refuseRefresh: false,
    denyNext: null,
    close: async () => {
      for (const server of [as, rs]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };

  const issue = (clientId: string, scope: string | null): Json => {
    const accessToken = token("at");
    const refreshToken = token("rt");
    access.add(accessToken);
    refresh.set(refreshToken, { clientId, scope });
    state.issued.push(accessToken, refreshToken);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      ...(scope === null ? {} : { scope }),
    };
  };

  // --- The authorization server ---------------------------------------------------------------
  as.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (req.method === "GET" && url.pathname === "/test/state") {
      send(res, 200, {
        registrations: state.registrations,
        authorizeRequests: state.authorizeRequests.map((p) => Object.fromEntries(p)),
        tokenRequests: state.tokenRequests,
        issued: state.issued,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      send(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(registration ? { registration_endpoint: `${issuer}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        scopes_supported: scopes,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/register" && registration) {
      const body = JSON.parse((await readText(req)) || "{}") as Json;
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
      if (redirectUris.length === 0) {
        send(res, 400, { error: "invalid_redirect_uri" });
        return;
      }
      const clientId = `client-${state.registrations.length + 1}`;
      clients.set(clientId, { redirectUris });
      state.registrations.push({ clientId, redirectUris });
      send(res, 201, {
        ...body,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const params = url.searchParams;
      state.authorizeRequests.push(params);
      const clientId = params.get("client_id") ?? "";
      const redirectUri = params.get("redirect_uri") ?? "";
      const client = clients.get(clientId);
      if (client === undefined || !client.redirectUris.includes(redirectUri)) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Unknown client or redirect URI.");
        return;
      }
      const challenge = params.get("code_challenge");
      if (
        params.get("response_type") !== "code" ||
        challenge === null ||
        params.get("code_challenge_method") !== "S256"
      ) {
        res.writeHead(400, { "content-type": "text/plain" }).end("PKCE (S256) is required.");
        return;
      }
      const back = new URL(redirectUri);
      const returned = params.get("state");
      if (returned !== null) back.searchParams.set("state", returned);
      if (state.denyNext !== null) {
        back.searchParams.set("error", state.denyNext);
        back.searchParams.set("error_description", "<b>The person said no.</b>");
        state.denyNext = null;
      } else {
        const code = token("code");
        codes.set(code, { clientId, redirectUri, challenge, scope: params.get("scope") });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readText(req));
      let clientId = form.get("client_id");
      let secret = form.get("client_secret");
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      if (basic !== null) {
        const [id, pass] = Buffer.from(basic[1] as string, "base64").toString().split(":");
        clientId = decodeURIComponent(id ?? "");
        secret = decodeURIComponent(pass ?? "");
      }
      const grant = form.get("grant_type") ?? "";
      state.tokenRequests.push({ grant, clientId, secret });
      const client = clientId === null ? undefined : clients.get(clientId);
      if (client === undefined || (client.secret !== undefined && client.secret !== secret)) {
        send(res, 401, { error: "invalid_client" });
        return;
      }
      if (grant === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (
          code === undefined ||
          code.clientId !== clientId ||
          code.redirectUri !== form.get("redirect_uri") ||
          s256(verifier) !== code.challenge
        ) {
          send(res, 400, { error: "invalid_grant" });
          return;
        }
        send(res, 200, issue(code.clientId, code.scope));
        return;
      }
      if (grant === "refresh_token") {
        const old = form.get("refresh_token") ?? "";
        const held = refresh.get(old);
        if (state.refuseRefresh || held === undefined || held.clientId !== clientId) {
          send(res, 400, { error: "invalid_grant", error_description: "The refresh token is not valid." });
          return;
        }
        refresh.delete(old);
        send(res, 200, issue(held.clientId, held.scope));
        return;
      }
      send(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    send(res, 404, { error: "not_found" });
  });

  // --- The MCP server it protects ---------------------------------------------------------------
  const metadata = {
    resource: mcpUrl,
    authorization_servers: [issuer],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
  };
  const answer = (message: Json): Json | null => {
    const id = message.id;
    if (id === undefined || id === null) return null; // A notification.
    const method = String(message.method ?? "");
    if (method === "initialize") {
      const params = (message.params ?? {}) as Json;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: options.serverName ?? "secure", version: "1.0.0" },
        },
      };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "whoami",
              description: "Says whose sign-in the call used.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      };
    }
    if (method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "You are signed in as test-user." }] },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `No method ${method}.` } };
  };
  rs.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", rsBase);
    if (
      req.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      send(res, 200, metadata);
      return;
    }
    if (url.pathname !== "/mcp") {
      send(res, 404, { error: "not_found" });
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
    const authorized = bearer !== null && access.has(bearer);
    state.mcpRequests.push({ method: req.method ?? "", bearer, authorized });
    if (!authorized) {
      const error = bearer === null ? "" : ', error="invalid_token"';
      send(res, 401, null, {
        "www-authenticate": `Bearer resource_metadata="${rsBase}/.well-known/oauth-protected-resource"${error}`,
      });
      await readText(req).catch(() => "");
      return;
    }
    if (req.method === "GET") {
      send(res, 405, null);
      return;
    }
    if (req.method === "DELETE") {
      send(res, 200, null);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readText(req));
    } catch {
      send(res, 400, null);
      return;
    }
    const messages = Array.isArray(body) ? (body as Json[]) : [body as Json];
    const answers = messages.map(answer).filter((a): a is Json => a !== null);
    if (answers.length === 0) {
      send(res, 202, null);
      return;
    }
    send(res, 200, (Array.isArray(body) ? answers : answers[0]) as unknown as Json);
  });

  return state;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startOAuthTestServer();
  process.stdout.write(`${JSON.stringify({ mcpUrl: server.mcpUrl, issuer: server.issuer })}\n`);
  process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
}
