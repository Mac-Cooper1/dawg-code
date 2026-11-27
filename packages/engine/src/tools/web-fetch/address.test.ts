import { describe, expect, it } from "vitest";
import { addressRefusal, hostnameRefusal, parseIpv6 } from "./address.ts";
import { domainSpecifier, parseTarget, sameSite } from "./url.ts";

describe("addresses WebFetch refuses", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["0.0.0.0", "this network"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.10", "private"],
    ["169.254.169.254", "metadata"],
    ["100.100.100.200", "carrier-grade"],
    ["192.0.0.192", "IETF"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["fc00::1", "unique-local"],
    ["fd00:ec2::254", "unique-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "metadata"],
    ["64:ff9b::10.0.0.1", "NAT64"],
    ["2001:db8::1", "documentation"],
    ["2002:7f00:1::1", "6to4"],
    ["2001::1", "Teredo"],
    ["::127.0.0.1", "global unicast"],
  ])("%s", (address, why) => {
    const verdict = addressRefusal(address);
    expect(verdict).not.toBeNull();
    expect(verdict).toMatch(new RegExp(why, "i"));
  });

  it("allows public addresses", () => {
    for (const address of [
      "93.184.215.14",
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700:4700::1111",
      "2a00:1450:4009:81f::200e",
      "::ffff:8.8.8.8",
      "64:ff9b::8.8.8.8",
    ]) {
      expect(addressRefusal(address), address).toBeNull();
    }
  });

  it("refuses what is not an address", () => {
    expect(addressRefusal("example.com")).toBe("not a valid address");
    expect(addressRefusal("")).toBe("not a valid address");
  });

  it("parses IPv6 forms", () => {
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6("[fe80::1%lo0]")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIpv6("12345::")).toBeNull();
  });
});

describe("hostnames WebFetch refuses before looking them up", () => {
  it("refuses localhost and names without a dot, as documented", () => {
    expect(hostnameRefusal("localhost")).toMatch(/this machine/);
    expect(hostnameRefusal("LOCALHOST.")).toMatch(/this machine/);
    expect(hostnameRefusal("app.localhost")).toMatch(/this machine/);
    expect(hostnameRefusal("intranet")).toMatch(/no dot/);
    expect(hostnameRefusal("printer.local")).toMatch(/mDNS/);
    expect(hostnameRefusal("[::1]")).toMatch(/loopback/);
    expect(hostnameRefusal("10.0.0.1")).toMatch(/private/);
  });

  it("leaves public names to the lookup", () => {
    expect(hostnameRefusal("example.com")).toBeNull();
    expect(hostnameRefusal("93.184.215.14")).toBeNull();
  });
});

describe("the URL", () => {
  it("upgrades http to https", () => {
    const t = parseTarget("http://example.com/a?b=1");
    expect(t.ok && t.url.href).toBe("https://example.com/a?b=1");
    const p = parseTarget("http://example.com:80/");
    expect(p.ok && p.url.href).toBe("https://example.com/");
    const q = parseTarget("http://example.com:8080/");
    expect(q.ok && q.url.href).toBe("https://example.com:8080/");
  });

  it.each([
    ["file:///etc/passwd", /only fetches http and https/],
    ["ftp://example.com/x", /only fetches http and https/],
    ["javascript:alert(1)", /only fetches http and https/],
    ["data:text/html,hi", /only fetches http and https/],
    ["gopher://example.com/", /only fetches http and https/],
    ["not a url", /not a valid URL/],
    ["https://user:pass@example.com/", /user name or password/],
    ["http://localhost:3000/", /local or private/],
    ["http://127.0.0.1/", /local or private/],
    ["http://2130706433/", /local or private/],
    ["http://0x7f.1/", /local or private/],
    ["http://[::1]:8080/", /local or private/],
    ["http://[::ffff:127.0.0.1]/", /local or private/],
    ["http://169.254.169.254/latest/meta-data/", /local or private/],
    ["https://intranet/", /local or private/],
  ])("refuses %s", (url, why) => {
    const t = parseTarget(url);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toMatch(why);
  });

  it("writes the permission specifier as rules compare it", () => {
    const t = parseTarget("https://Docs.Example.COM./x");
    expect(t.ok && domainSpecifier(t.url)).toBe("domain:docs.example.com");
  });

  it("follows redirects that only add or drop www.", () => {
    const u = (s: string) => new URL(s);
    expect(sameSite(u("https://example.com/a"), u("https://www.example.com/b"))).toBe(true);
    expect(sameSite(u("https://www.example.com/a"), u("https://example.com/b"))).toBe(true);
    expect(sameSite(u("https://example.com/a"), u("https://EXAMPLE.com/b"))).toBe(true);
    expect(sameSite(u("https://example.com/a"), u("https://api.example.com/b"))).toBe(false);
    expect(sameSite(u("https://example.com/a"), u("https://example.org/b"))).toBe(false);
    expect(sameSite(u("https://example.com/a"), u("https://example.com:8443/b"))).toBe(false);
  });
});
