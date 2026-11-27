/**
 * WebSearch's `allowed_domains` and `blocked_domains`. A domain covers its subdomains, as the
 * Claude API's web search tool documents ("docs.example.com" is covered by "example.com";
 * docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool, "Domain filtering"). Entries
 * are forgiving: a scheme, a path, a leading `*.` or `www.`... are dropped.
 */

/** "https://Docs.Example.com/x" → "docs.example.com"; null when nothing usable is left. */
export function normalizeDomain(entry: string): string | null {
  let text = entry.trim().toLowerCase();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  text = text.replace(/[/?#].*$/, "");
  text = text.replace(/:\d+$/, "");
  text = text.replace(/^\*\./, "").replace(/\.$/, "");
  if (text === "" || !/^[a-z0-9.-]+$/.test(text) || !text.includes(".")) return null;
  return text;
}

export function normalizeDomains(entries: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const entry of entries ?? []) {
    const domain = normalizeDomain(entry);
    if (domain !== null) out.add(domain);
  }
  return [...out];
}

/** Whether `host` is `domain` or one of its subdomains. */
export function hostInDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith(`.${domain}`);
}

/** Whether a result's URL passes the filters. URLs that are not http(s) never do. */
export function urlPasses(
  url: string,
  allowed: readonly string[],
  blocked: readonly string[],
): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname;
  } catch {
    return false;
  }
  if (blocked.some((d) => hostInDomain(host, d))) return false;
  return allowed.length === 0 || allowed.some((d) => hostInDomain(host, d));
}
