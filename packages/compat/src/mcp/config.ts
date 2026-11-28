// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP definitions write ${VAR} variables literally
/**
 * One MCP server definition, as the MCP docs (code.claude.com/docs/en/mcp) write it in
 * `.mcp.json`, `~/.claude.json` and dawg's `~/.dawg/mcp.json`:
 *
 *   { "command": "npx", "args": [...], "env": {...} }                       a local server (stdio)
 *   { "type": "http", "url": "https://…", "headers": {...} }                streamable HTTP
 *   { "type": "sse", "url": "https://…", "headers": {...} }                 older servers
 *
 * plus `timeout` (milliseconds per tool call) and `alwaysLoad` (its tools are always in the
 * prompt). `${VAR}` and `${VAR:-default}` are expanded in the command, arguments, environment,
 * URL and headers, from the environment dawg runs in. A variable that is not set and has no
 * default stays as written, with a note, as the docs describe.
 *
 * A remote server's `oauth` object (round 3) says how signing in to it works, in the fields the
 * docs give: `clientId` for a client registered in advance, `callbackPort` for the loopback port
 * its redirect URI names, `authServerMetadataUrl` to skip discovery, `scopes` to pin the scopes.
 * A client secret is never in the file (the docs keep it in the Keychain).
 */
import type { McpTransport } from "@dawg/protocol";

/** How signing in to a remote server works, from its definition's `oauth` object. */
export interface McpOAuthSettings {
  /** A client registered in advance with the authorization server; null to register dawg. */
  clientId: string | null;
  /** The port of `http://localhost:PORT/callback`, for a redirect URI registered in advance. */
  callbackPort: number | null;
  /** The authorization server's metadata (https), used instead of discovery. */
  authServerMetadataUrl: string | null;
  /** The scopes to ask for, space-separated, over what the server advertises. */
  scopes: string | null;
}

/** A definition dawg can start, after expansion. */
export type McpServerConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | {
      type: "http" | "sse";
      url: string;
      headers: Record<string, string>;
      /** Present only when the definition has an `oauth` object. */
      oauth?: McpOAuthSettings;
    };

export interface ParsedServer {
  /** "ok": dawg can start it; "not-supported": a valid kind dawg cannot run; "invalid": not a definition. */
  status: "ok" | "not-supported" | "invalid";
  /** After expansion; null unless `status` is "ok". */
  config: McpServerConfig | null;
  transport: McpTransport | null;
  /** What it runs or where it connects, for people, with variables as written. */
  target: string;
  /** Milliseconds a tool call may take, or null for the default. */
  timeoutMs: number | null;
  /** True or false when the definition says; null when it does not. */
  alwaysLoad: boolean | null;
  /** Variables used without a value or default, in order of first use. */
  missing: string[];
  /** Sentences: what is wrong, or what dawg does not use. */
  notes: string[];
}

/**
 * Variables a project's remote server never gets, even when set: a project must not be able to
 * send them to a server it names (the docs' list for `url` and `headers`).
 */
export const PROJECT_WITHHELD_VARIABLES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "HTTPS_PROXY",
  "NPM_TOKEN",
]);

const KNOWN_FIELDS = {
  stdio: new Set(["type", "command", "args", "env", "timeout", "alwaysLoad"]),
  remote: new Set(["type", "url", "headers", "timeout", "alwaysLoad", "oauth"]),
};

/** Fields the docs describe that dawg does not act on yet, with what that means. */
const LATER_FIELDS: Record<string, string> = {
  headersHelper: "Its headersHelper command is not run yet, so only its fixed headers are sent.",
};

const OAUTH_FIELDS = new Set(["clientId", "callbackPort", "authServerMetadataUrl", "scopes"]);

/**
 * Reads a remote definition's `oauth` object. A field that is not valid is left out with a note,
 * so signing in still works the default way.
 */
function parseOAuth(value: unknown, notes: string[]): McpOAuthSettings | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    notes.push("“oauth” should be an object, so signing in works the default way.");
    return null;
  }
  const settings: McpOAuthSettings = {
    clientId: null,
    callbackPort: null,
    authServerMetadataUrl: null,
    scopes: null,
  };
  if (typeof value.clientId === "string" && value.clientId.trim() !== "") {
    settings.clientId = value.clientId.trim();
  } else if (value.clientId !== undefined) {
    notes.push("“oauth.clientId” should be text, so dawg registers itself instead.");
  }
  const port = value.callbackPort;
  if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535) {
    settings.callbackPort = port;
  } else if (port !== undefined) {
    notes.push("“oauth.callbackPort” should be a port number, so a free port is used.");
  }
  const metadata = value.authServerMetadataUrl;
  if (typeof metadata === "string" && /^https:\/\/[^\s]+$/i.test(metadata.trim())) {
    settings.authServerMetadataUrl = metadata.trim();
  } else if (metadata !== undefined) {
    notes.push(
      "“oauth.authServerMetadataUrl” should be an https:// address, so discovery is used.",
    );
  }
  if (typeof value.scopes === "string" && value.scopes.trim() !== "") {
    settings.scopes = value.scopes.trim().split(/\s+/).join(" ");
  } else if (value.scopes !== undefined) {
    notes.push("“oauth.scopes” should be text, scopes separated by spaces.");
  }
  if (typeof value.clientSecret === "string") {
    notes.push(
      "“oauth.clientSecret” is not read from the file: set MCP_CLIENT_SECRET when you sign in.",
    );
  }
  const ignored = Object.keys(value).filter((k) => !OAUTH_FIELDS.has(k) && k !== "clientSecret");
  if (ignored.length > 0) {
    notes.push(`dawg does not use ${ignored.map((k) => `“oauth.${k}”`).join(", ")}.`);
  }
  return settings;
}

/** Longest command line or URL shown. */
const MAX_TARGET_CHARS = 160;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./~${}-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/** A command line as a person reads it, cut to a readable length. */
export function commandLine(command: string, args: readonly string[]): string {
  const line = [command, ...args].map(quoteArg).join(" ");
  return line.length > MAX_TARGET_CHARS ? `${line.slice(0, MAX_TARGET_CHARS - 1)}…` : line;
}

/** A URL without credentials, query or fragment. Variables such as `${HOST}` stay as written. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

export interface ExpandOptions {
  /** Where `${VAR}` values come from. */
  env: Readonly<Record<string, string | undefined>>;
  /** Names that expand to "" whatever their value. */
  withheld?: ReadonlySet<string>;
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expands `${VAR}` and `${VAR:-default}`. An empty value counts as set. A variable that is not
 * set and has no default stays as written and is added to `missing`.
 */
export function expandVariables(text: string, options: ExpandOptions, missing: string[]): string {
  return text.replace(VARIABLE, (whole, name: string, fallback: string | undefined) => {
    if (options.withheld?.has(name) === true) return "";
    const value = options.env[name];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    if (!missing.includes(name)) missing.push(name);
    return whole;
  });
}

function stringRecord(
  value: unknown,
  field: string,
  notes: string[],
): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    notes.push(`“${field}” should map names to text values.`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
    else notes.push(`“${field}.${key}” is not text, so it is left out.`);
  }
  return out;
}

function expandRecord(
  record: Record<string, string>,
  options: ExpandOptions,
  missing: string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, expandVariables(value, options, missing)]),
  );
}

/**
 * Reads one definition. `env` is the environment variables are expanded from; `withheld` names
 * those a project's remote server never gets (see PROJECT_WITHHELD_VARIABLES).
 */
export function parseServer(
  entry: unknown,
  options: { env: Readonly<Record<string, string | undefined>>; withheld?: ReadonlySet<string> },
): ParsedServer {
  const result: ParsedServer = {
    status: "invalid",
    config: null,
    transport: null,
    target: "",
    timeoutMs: null,
    alwaysLoad: null,
    missing: [],
    notes: [],
  };
  if (!isPlainObject(entry)) {
    result.notes.push("Not a server definition: expected an object.");
    return result;
  }
  const type = entry.type === undefined ? null : entry.type;
  if (type !== null && typeof type !== "string") {
    result.notes.push("“type” should be text: stdio, http or sse.");
    return result;
  }
  if (typeof entry.timeout === "number" && entry.timeout > 0) {
    result.timeoutMs = Math.round(entry.timeout);
  } else if (entry.timeout !== undefined) {
    result.notes.push("“timeout” should be a number of milliseconds, so the default applies.");
  }
  if (typeof entry.alwaysLoad === "boolean") result.alwaysLoad = entry.alwaysLoad;

  if (type === null || type === "stdio") {
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (command === "") {
      result.notes.push(
        typeof entry.url === "string"
          ? "Has a url but no type, which Claude Code rejects too."
          : "Needs a command (a local server) or a type and url (a remote one).",
      );
      return result;
    }
    const args: string[] = [];
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args)) {
        result.notes.push("“args” should be a list of text.");
        return result;
      }
      for (const arg of entry.args) {
        if (typeof arg === "string" || typeof arg === "number") args.push(String(arg));
        else {
          result.notes.push("“args” should be a list of text.");
          return result;
        }
      }
    }
    const env = stringRecord(entry.env, "env", result.notes);
    if (env === null) return result;
    result.transport = "stdio";
    result.target = commandLine(command, args);
    noteFields(entry, KNOWN_FIELDS.stdio, result.notes);
    const expand: ExpandOptions = { env: options.env };
    result.config = {
      type: "stdio",
      command: expandVariables(command, expand, result.missing),
      args: args.map((arg) => expandVariables(arg, expand, result.missing)),
      env: expandRecord(env, expand, result.missing),
    };
    result.status = "ok";
    noteMissing(result);
    return result;
  }

  if (type === "http" || type === "streamable-http" || type === "sse") {
    if (typeof entry.url !== "string" || entry.url.trim() === "") {
      result.notes.push(`A ${type} server needs a url.`);
      return result;
    }
    const headers = stringRecord(entry.headers, "headers", result.notes);
    if (headers === null) return result;
    result.transport = type === "sse" ? "sse" : "http";
    result.target = safeUrl(entry.url.trim());
    noteFields(entry, KNOWN_FIELDS.remote, result.notes);
    const expand: ExpandOptions = {
      env: options.env,
      ...(options.withheld === undefined ? {} : { withheld: options.withheld }),
    };
    const url = expandVariables(entry.url.trim(), expand, result.missing);
    const oauth = parseOAuth(entry.oauth, result.notes);
    result.config = {
      type: result.transport,
      url,
      headers: expandRecord(headers, expand, result.missing),
      ...(oauth === null ? {} : { oauth }),
    };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        result.notes.push(`Its url should start with http:// or https://, not ${parsed.protocol}.`);
        result.status = "invalid";
        result.config = null;
        return result;
      }
    } catch {
      if (result.missing.length === 0) {
        result.notes.push("Its url is not a valid address.");
        result.status = "invalid";
        result.config = null;
        return result;
      }
    }
    result.status = "ok";
    noteMissing(result);
    return result;
  }

  if (type === "ws") {
    result.transport = null;
    result.target = typeof entry.url === "string" ? safeUrl(entry.url) : "";
    result.status = typeof entry.url === "string" ? "not-supported" : "invalid";
    result.notes.push(
      typeof entry.url === "string"
        ? "dawg does not connect to MCP servers over WebSocket yet."
        : "A ws server needs a url.",
    );
    return result;
  }
  if (type === "sdk") {
    result.status = "not-supported";
    result.notes.push("Provided by a program that embeds Claude Code; dawg cannot start it.");
    return result;
  }
  result.notes.push(`Unknown server type “${type}”.`);
  return result;
}

function noteFields(entry: Record<string, unknown>, known: ReadonlySet<string>, notes: string[]) {
  const ignored: string[] = [];
  for (const key of Object.keys(entry)) {
    if (known.has(key)) continue;
    const later = LATER_FIELDS[key];
    if (later !== undefined) notes.push(later);
    else ignored.push(key);
  }
  if (ignored.length > 0) {
    notes.push(`dawg does not use ${ignored.map((k) => `“${k}”`).join(", ")}.`);
  }
}

function noteMissing(result: ParsedServer): void {
  if (result.missing.length === 0) return;
  const names = result.missing.map((name) => `\${${name}}`).join(", ");
  result.notes.push(
    result.missing.length === 1
      ? `${names} is not set, so it stays as written.`
      : `${names} are not set, so they stay as written.`,
  );
}
