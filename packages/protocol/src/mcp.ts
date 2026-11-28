/**
 * MCP servers (Phase 4 spec, "MCP"): what Settings → MCP servers and `/mcp` show, the import of
 * Claude Code's own servers, and what a session's composer offers from its servers (resources for
 * `@`, prompts for `/`). A call to a server's tool is an ordinary tool call; its card's display is
 * `McpDisplay` (common.ts).
 */
import { z } from "zod";
import { CommandInfoSchema, CompatSourceSchema, SessionIdSchema } from "./common.ts";

export const McpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerStateSchema = z.enum([
  /** Running, with its tools listed. */
  "connected",
  /** Starting, or starting again after a failure. */
  "starting",
  /** It failed and is not running; `reason` says why. dawg tries again a few times by itself. */
  "failed",
  /** Defined in the project's files, and the person has not approved it yet. */
  "needs-approval",
  /** A remote server that wants the person to sign in (OAuth) before it answers. */
  "needs-sign-in",
  /** Turned off, or not running because no session uses it; `reason` says which. */
  "off",
]);
export type McpServerState = z.infer<typeof McpServerStateSchema>;

/** One tool a server offers. */
export const McpToolInfoSchema = z.object({
  /** As the model, permission rules and hooks see it: "mcp__github__get_issue". */
  name: z.string().min(1),
  /** The server's own name for it: "get_issue". */
  tool: z.string().min(1),
  /** Its description's first line; may be empty. */
  description: z.string(),
});
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;

/**
 * Signing in to a remote server with OAuth (Phase 4 spec, MCP: "Auth"). Never holds a token: they
 * stay in the engine's credential store.
 */
export const McpSignInInfoSchema = z.object({
  /**
   * "signed-in": dawg holds a token for it (the server may still refuse it, then the state is
   * "needs-sign-in"); "signing-in": a browser step is waiting (`mcp.signIn`); "signed-out": none.
   */
  status: z.enum(["signed-out", "signing-in", "signed-in"]),
  /** Why the last sign-in did not finish, in plain words; null when it did or none was tried. */
  problem: z.string().nullable(),
});
export type McpSignInInfo = z.infer<typeof McpSignInInfoSchema>;

export const McpServerInfoSchema = z.object({
  /** The name in its configuration: "github". */
  name: z.string().min(1),
  /**
   * Which definition is used, highest precedence first: a session's own, the person's for this
   * project (`~/.dawg/mcp.json` `projects`), the project's `.mcp.json`, the person's for every
   * project (`~/.dawg/mcp.json`).
   */
  scope: z.enum(["session", "local", "project", "user"]),
  /** The file that defines it. */
  source: CompatSourceSchema,
  /** Null when dawg cannot run the definition (a WebSocket server, or one that is not valid). */
  transport: McpTransportSchema.nullable(),
  /** What it runs or where it connects, for people: a command line, or a URL without its query. */
  target: z.string(),
  state: McpServerStateSchema,
  /** Why it failed, is off, waits for approval or sign-in; null when connected or starting. */
  reason: z.string().nullable(),
  /** Its tools, sorted by name; empty until it has connected once. */
  tools: z.array(McpToolInfoSchema),
  /** Prompts it offers as slash commands, and resources it offers for `@` mentions. */
  prompts: z.number().int().nonnegative(),
  resources: z.number().int().nonnegative(),
  /** The person's switch: false when they turned it off (Settings → MCP servers). */
  enabled: z.boolean(),
  /**
   * Sentences about the definition: a variable that is not set, a field dawg does not use yet,
   * a definition of the same name it overrides.
   */
  notes: z.array(z.string()).default([]),
  /**
   * Added (Phase 4, round 3): sign-in for a remote server dawg may sign in to; null for a local
   * one, or one whose definition sends its own Authorization header.
   */
  signIn: McpSignInInfoSchema.nullable().default(null),
});
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

/** Settings → MCP servers, `/mcp`: the servers a project's sessions get, with their state. */
export const McpListParamsSchema = z.object({
  /** An absolute folder, or null for only the person's own servers. */
  projectDir: z.string().min(1).nullable(),
  /**
   * Added (Phase 4, round 3): an open session's servers instead, its own (scope "session",
   * `session.create`'s `mcpServers`) among them. `projectDir` is then the session's.
   */
  sessionId: SessionIdSchema.optional(),
});

export const McpListResultSchema = z.object({
  projectDir: z.string().nullable(),
  /** Sorted by name. */
  servers: z.array(McpServerInfoSchema),
  /**
   * How many servers Claude Code's own configuration (`~/.claude.json`) holds that are not in
   * dawg yet. They are never started from there: `mcp.importPreview` shows what importing them
   * would copy.
   */
  importable: z.number().int().nonnegative(),
});

/** Stops a server and starts it again (or starts one no session uses, to check it). */
export const McpRestartParamsSchema = z.object({
  projectDir: z.string().min(1).nullable(),
  name: z.string().min(1),
});

export const McpRestartResultSchema = z.object({
  server: McpServerInfoSchema,
});

/**
 * The person's switch for one server, kept in dawg's data folder: off stops it now and keeps it
 * from starting. For the project's servers it holds for that project only.
 */
export const McpSetEnabledParamsSchema = z.object({
  projectDir: z.string().min(1).nullable(),
  name: z.string().min(1),
  enabled: z.boolean(),
});

export const McpSetEnabledResultSchema = z.object({
  enabled: z.boolean(),
});

/** One server the import would copy from Claude Code's `~/.claude.json`, or leave. */
export const McpImportItemSchema = z.object({
  name: z.string().min(1),
  /** The project it is for, as Claude Code keeps it (`projects`), or null for every project. */
  project: z.string().nullable(),
  transport: McpTransportSchema.nullable(),
  /** A command line, or a URL without its query. */
  target: z.string(),
  /**
   * Values the copy carries that may be secrets, named but never shown: "env GITHUB_TOKEN",
   * "header Authorization", "a query in the URL".
   */
  secrets: z.array(z.string()),
  /** "copy", or "skip" when it cannot or need not be copied; `reason` says why. */
  action: z.enum(["copy", "skip"]),
  reason: z.string().nullable(),
});
export type McpImportItem = z.infer<typeof McpImportItemSchema>;

export const McpImportPreviewParamsSchema = z.object({});

/** What `mcp.import` would copy, with a hash of it: the import copies only what was shown. */
export const McpImportPlanSchema = z.object({
  /** Claude Code's file, read and never written. */
  from: z.string(),
  /** dawg's file the servers are copied into (`~/.dawg/mcp.json`). */
  to: z.string(),
  /** A hash of what would be copied; null when there is nothing to copy. */
  hash: z.string().nullable(),
  items: z.array(McpImportItemSchema),
});
export type McpImportPlan = z.infer<typeof McpImportPlanSchema>;

export const McpImportParamsSchema = z.object({
  /** The plan's `hash` the person saw. InvalidState when Claude Code's file changed since. */
  hash: z.string().min(1),
});

export const McpImportResultSchema = z.object({
  /** How many servers were copied. */
  imported: z.number().int().nonnegative(),
  /** The file they were copied into. */
  path: z.string(),
});

/** A resource a session's servers offer, for the composer's `@` menu. */
export const McpResourceInfoSchema = z.object({
  server: z.string().min(1),
  uri: z.string().min(1),
  /** For people: its title or name. */
  name: z.string(),
  description: z.string(),
  /** Null when the server did not say. */
  mimeType: z.string().nullable(),
  /** What to put in a message to attach it: "@github:issue://123". */
  mention: z.string().min(1),
});
export type McpResourceInfo = z.infer<typeof McpResourceInfoSchema>;

/** What a session's connected servers offer the composer now. */
export const McpSessionParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

export const McpSessionResultSchema = z.object({
  /** Sorted by server, then name. */
  resources: z.array(McpResourceInfoSchema),
  /**
   * Prompts as slash commands (`/mcp__server__prompt`), for the `/` menu: servers that connect
   * after the session opened add theirs, which the snapshot's `commands` does not hold.
   */
  prompts: z.array(CommandInfoSchema),
});

// --- Added (Phase 4, round 3): signing in with OAuth, and a session's own servers ----------------

/**
 * Starts signing in to a remote server: the engine discovers its authorization server, registers
 * dawg with it when it allows that, and listens on 127.0.0.1 for the browser's return. The client
 * opens `url` in the browser; the rest finishes in the background, and `mcp.list` follows it
 * ("needs-sign-in", then "starting", then "connected", or `signIn.problem` says what went wrong).
 * InvalidState for a server that cannot sign in (local, waiting for approval, off, or one whose
 * definition sends its own Authorization header), and in a run with nobody to answer.
 */
export const McpSignInParamsSchema = z.object({
  projectDir: z.string().min(1).nullable(),
  name: z.string().min(1),
  /** A server of this open session's (its own ones included), as in `mcp.list`. */
  sessionId: SessionIdSchema.optional(),
});

export const McpSignInResultSchema = z.object({
  /** The authorization server's page, for the browser. Carries no secret: only a PKCE challenge. */
  url: z.string().min(1),
});

/** Forgets the server's tokens and dawg's registration with it, and stops a sign-in on its way. */
export const McpSignOutParamsSchema = McpSignInParamsSchema;

export const McpSignOutResultSchema = z.object({
  server: McpServerInfoSchema,
});

/** Stops a sign-in on its way: the browser's return is no longer accepted. */
export const McpCancelSignInParamsSchema = McpSignInParamsSchema;

export const McpCancelSignInResultSchema = z.object({
  server: McpServerInfoSchema,
});

/**
 * A session's own servers (`session.create`'s `mcpServers`, the command line's `--mcp-config`):
 * the `mcpServers` object of a `.mcp.json`, server name to definition. Each definition is read as
 * `.mcp.json`'s are; one that is not valid shows as failed, with why.
 */
export const McpSessionServersSchema = z.record(z.string().min(1), z.unknown());
