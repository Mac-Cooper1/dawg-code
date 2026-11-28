/**
 * Reading the URL WebFetch was given: which ones it fetches, the https form it fetches them in,
 * and the `domain:` specifier its permission rules match. Pure functions.
 */
import { hostnameRefusal } from "./address.ts";

export type ParsedTarget = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * The URL to fetch, or why it is refused without any network access. Only http and https;
 * http is upgraded to https, as documented ("HTTP URLs will be automatically upgraded"); a user
 * name or password in the URL is refused, so a page can never carry credentials there; and the
 * host must pass `hostnameRefusal` (no `localhost`, no name without a dot, no private address
 * written out).
 */
export function parseTarget(raw: string): ParsedTarget {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `"${oneLine(raw)}" is not a valid URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `WebFetch only fetches http and https URLs, not ${url.protocol.replace(/:$/, "")}.`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "WebFetch does not fetch URLs that carry a user name or password.",
    };
  }
  const why = hostnameRefusal(url.hostname);
  if (why !== null) {
    return {
      ok: false,
      reason: `WebFetch does not fetch local or private addresses: ${why}. To reach a server on this machine or the local network, use curl through Bash.`,
    };
  }
  return { ok: true, url: upgrade(url) };
}

/** The https form of a URL; the default http port becomes the default https port. */
export function upgrade(url: URL): URL {
  if (url.protocol === "https:") return url;
  const next = new URL(url.href);
  next.protocol = "https:";
  if (url.port === "80") next.port = "";
  return next;
}

/**
 * The hostname as permission rules compare it: lower case, without a trailing dot, as documented
 * ("Matching is case-insensitive ... and strips a trailing `.`", code.claude.com/docs/en/
 * permissions, "WebFetch"). IPv6 literals keep their brackets.
 */
export function ruleHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

/** The permission specifier for fetching a URL: `domain:example.com`. */
export function domainSpecifier(url: URL): string {
  return `domain:${ruleHost(url)}`;
}

function withoutWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Whether a redirect from `from` to `to` stays on the same site, so WebFetch follows it. As
 * documented, a redirect that changes the host "by more than adding or dropping `www.`" is
 * reported to the model instead (code.claude.com/docs/en/tools-reference, "Fix a failed WebFetch
 * request"). A change of port is a change of host.
 */
export function sameSite(from: URL, to: URL): boolean {
  if (from.port !== to.port) return false;
  return withoutWww(ruleHost(from)) === withoutWww(ruleHost(to));
}

export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
