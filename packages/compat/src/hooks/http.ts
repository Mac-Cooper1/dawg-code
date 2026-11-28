/**
 * HTTP hooks' rules from the settings and hooks references: which addresses a hook may post to
 * (`allowedHttpHookUrls`), and which environment variables its headers may read (its own
 * `allowedEnvVars`, narrowed by `httpHookAllowedEnvVars` when a settings file sets it).
 */
import type { HookHandler, HttpHookPolicy } from "./read.ts";

/** `$NAME` or `${NAME}` in a header value. */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * A URL as patterns are matched against it: scheme and host in lower case, the host without the
 * trailing dot of a fully qualified name ("Hostname matching is case-insensitive and treats
 * `hooks.example.com.` ... the same as `hooks.example.com`"). Null when it is not a URL.
 */
function comparable(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/\.$/, "");
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  return `${parsed.protocol}//${host}${port}${parsed.pathname}${parsed.search}`;
}

/** A pattern's scheme and host part in lower case, the rest as written. */
function comparablePattern(pattern: string): string {
  const at = pattern.indexOf("://");
  if (at < 0) return pattern;
  const slash = pattern.indexOf("/", at + 3);
  const authority = slash < 0 ? pattern : pattern.slice(0, slash);
  const rest = slash < 0 ? "" : pattern.slice(slash);
  const lowered = authority.toLowerCase().replace(/\.(?=:|$)/, "");
  return `${lowered}${rest}`;
}

/** Whether `url` matches one of `patterns`, where `*` stands for any run of characters. */
export function httpUrlAllowed(url: string, patterns: readonly string[]): boolean {
  const target = comparable(url);
  if (target === null) return false;
  return patterns.some((pattern) => {
    const source = comparablePattern(pattern.trim())
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${source}$`).test(target);
  });
}

/**
 * Whether the settings let this http hook run: true unless `allowedHttpHookUrls` is set and
 * none of its patterns matches the hook's URL.
 */
export function httpHookAllowed(handler: HookHandler, policy: HttpHookPolicy): boolean {
  if (handler.type !== "http" || policy.allowedUrls === null) return true;
  return handler.url !== null && httpUrlAllowed(handler.url, policy.allowedUrls);
}

/**
 * The variables an http hook's headers may read: those its `allowedEnvVars` lists, and, when a
 * settings file sets `httpHookAllowedEnvVars`, only those both name.
 */
export function headerVariablesAllowed(handler: HookHandler, policy: HttpHookPolicy): Set<string> {
  const own = new Set(handler.allowedEnvVars);
  if (policy.allowedEnvVars === null) return own;
  const settings = new Set(policy.allowedEnvVars);
  return new Set([...own].filter((name) => settings.has(name)));
}

/** The variables a header value names. */
export function headerVariables(value: string): string[] {
  return [...value.matchAll(VARIABLE)].map((m) => (m[1] ?? m[2]) as string);
}

/**
 * The headers an http hook sends: each value with the variables it may read put in, and every
 * other `$NAME` replaced by an empty string ("References to unlisted variables are replaced with
 * empty strings").
 */
export function interpolateHeaders(
  headers: Readonly<Record<string, string>>,
  allowed: ReadonlySet<string>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.replace(
      VARIABLE,
      (_all, braced: string | undefined, bare: string | undefined) => {
        const variable = (braced ?? bare) as string;
        return allowed.has(variable) ? (env[variable] ?? "") : "";
      },
    );
  }
  return out;
}
