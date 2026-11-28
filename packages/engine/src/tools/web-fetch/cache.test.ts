import { describe, expect, it } from "vitest";
import { CACHE_TTL_MS, type CachedPage, PageCache } from "./cache.ts";

const page = (text: string): CachedPage => ({
  url: "https://example.com/",
  status: 200,
  mediaType: "text/html",
  bytes: text.length,
  title: null,
  text,
});

describe("the page cache", () => {
  it("keeps a page for 15 minutes, as documented", () => {
    let now = 1_000;
    const cache = new PageCache({ now: () => now });
    expect(CACHE_TTL_MS).toBe(15 * 60_000);
    cache.set("https://example.com/", page("hello"));
    now += CACHE_TTL_MS - 1;
    expect(cache.get("https://example.com/")?.text).toBe("hello");
    now += 1;
    expect(cache.get("https://example.com/")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("is keyed by URL", () => {
    const cache = new PageCache();
    cache.set("https://example.com/a", page("a"));
    expect(cache.get("https://example.com/b")).toBeNull();
    expect(cache.get("https://example.com/a")?.text).toBe("a");
  });

  it("drops the least recently used pages past its entry and size limits", () => {
    const cache = new PageCache({ maxEntries: 2, maxChars: 10 });
    cache.set("a", page("aaa"));
    cache.set("b", page("bbb"));
    expect(cache.get("a")?.text).toBe("aaa");
    cache.set("c", page("ccc"));
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    cache.set("d", page("dddddddd"));
    expect(cache.size).toBe(1);
    expect(cache.get("d")).not.toBeNull();
    cache.set("e", page("x".repeat(11)));
    expect(cache.get("e")).toBeNull();
  });

  it("replaces an entry stored again", () => {
    const cache = new PageCache({ maxChars: 10 });
    cache.set("a", page("12345"));
    cache.set("a", page("1234567890"));
    expect(cache.get("a")?.text).toBe("1234567890");
    expect(cache.size).toBe(1);
  });
});
