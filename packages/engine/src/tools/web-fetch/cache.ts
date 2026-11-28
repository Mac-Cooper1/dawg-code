/**
 * WebFetch's page cache: a page fetched in the last 15 minutes is reused, as documented ("WebFetch
 * reuses its copy of a page for 15 minutes", code.claude.com/docs/en/tools-reference). Keyed by
 * the URL fetched (after the https upgrade). It lives in the engine's memory only, shared by its
 * sessions, and is bounded so a long day of fetching cannot grow it without limit.
 */

export const CACHE_TTL_MS = 15 * 60_000;
/** Pages kept at most. */
export const CACHE_MAX_ENTRIES = 64;
/** Characters kept in all, across pages. */
export const CACHE_MAX_CHARS = 16 * 1024 * 1024;

export interface CachedPage {
  /** Where the content came from, after same-site redirects. */
  url: string;
  status: number;
  mediaType: string;
  /** Bytes downloaded. */
  bytes: number;
  title: string | null;
  /** The page as text: Markdown for HTML, the text itself otherwise. */
  text: string;
}

export interface PageCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxChars?: number;
  now?: () => number;
}

export class PageCache {
  readonly #entries = new Map<string, { page: CachedPage; expires: number }>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxChars: number;
  readonly #now: () => number;
  #chars = 0;

  constructor(options: PageCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.#maxEntries = options.maxEntries ?? CACHE_MAX_ENTRIES;
    this.#maxChars = options.maxChars ?? CACHE_MAX_CHARS;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The page cached for `url`, if it is still fresh. A hit becomes the most recently used. */
  get(url: string): CachedPage | null {
    const entry = this.#entries.get(url);
    if (entry === undefined) return null;
    if (entry.expires <= this.#now()) {
      this.#delete(url);
      return null;
    }
    this.#entries.delete(url);
    this.#entries.set(url, entry);
    return entry.page;
  }

  set(url: string, page: CachedPage): void {
    this.#delete(url);
    if (page.text.length > this.#maxChars) return;
    this.#entries.set(url, { page, expires: this.#now() + this.#ttlMs });
    this.#chars += page.text.length;
    // The least recently used go first.
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries && this.#chars <= this.#maxChars) break;
      this.#delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#chars = 0;
  }

  #delete(url: string): void {
    const entry = this.#entries.get(url);
    if (entry === undefined) return;
    this.#entries.delete(url);
    this.#chars -= entry.page.text.length;
  }
}
