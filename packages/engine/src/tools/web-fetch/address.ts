/**
 * Which addresses WebFetch may connect to. The documented tool refuses `localhost` and other
 * hostnames without a dot (code.claude.com/docs/en/tools-reference, "Fix a failed WebFetch
 * request"); dawg goes further and refuses every address that is not on the public internet,
 * checked on the address a name resolves to, so a public-looking name pointing at the machine,
 * the local network or a cloud metadata service gets nowhere.
 *
 * The rule is an allow list: IPv4 outside the special-purpose ranges (RFC 6890 and its
 * successors), and IPv6 global unicast (2000::/3) outside its special-purpose ranges. IPv6 forms
 * that carry an IPv4 address (mapped, NAT64) are judged by that IPv4 address.
 */
import { isIP } from "node:net";

/** IPv4 ranges that are not the public internet: [first address, prefix length, why]. */
const IPV4_BLOCKED: readonly (readonly [string, number, string])[] = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "a private network (RFC 1918)"],
  ["100.64.0.0", 10, "carrier-grade NAT (RFC 6598)"],
  ["127.0.0.0", 8, "this machine (loopback)"],
  ["169.254.0.0", 16, "link-local, where cloud metadata services live"],
  ["172.16.0.0", 12, "a private network (RFC 1918)"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation (TEST-NET-1)"],
  ["192.31.196.0", 24, "AS112 service"],
  ["192.52.193.0", 24, "AMT relay"],
  ["192.88.99.0", 24, "6to4 relay anycast"],
  ["192.168.0.0", 16, "a private network (RFC 1918)"],
  ["192.175.48.0", 24, "AS112 service"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation (TEST-NET-2)"],
  ["203.0.113.0", 24, "documentation (TEST-NET-3)"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

const IPV4_RANGES = IPV4_BLOCKED.map(([base, bits, why]) => ({
  base: ipv4ToNumber(base) as number,
  mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0,
  why,
}));

/** "1.2.3.4" as an unsigned 32-bit number; null when it is not dotted-decimal IPv4. */
export function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/**
 * An IPv6 address as eight 16-bit groups. Accepts "::" compression, an embedded IPv4 tail
 * ("::ffff:10.0.0.1") and a zone ("fe80::1%en0", ignored). Null when it does not parse.
 */
export function parseIpv6(address: string): number[] | null {
  let text = address.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (text === "") return null;
  let tail: number[] = [];
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4 = ipv4ToNumber(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [v4 >>> 16, v4 & 0xffff];
    // Keep "::" when the IPv4 part follows it; otherwise drop the single separating colon.
    text = text.endsWith("::", lastColon + 1)
      ? text.slice(0, lastColon + 1)
      : text.slice(0, lastColon);
  }
  const wanted = 8 - tail.length;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = groups(halves[0] as string);
  if (head === null) return null;
  if (halves.length === 1) return head.length === wanted ? [...head, ...tail] : null;
  const rest = groups(halves[1] as string);
  if (rest === null || head.length + rest.length >= wanted) return null;
  return [
    ...head,
    ...new Array<number>(wanted - head.length - rest.length).fill(0),
    ...rest,
    ...tail,
  ];
}

function ipv4Verdict(value: number): string | null {
  for (const range of IPV4_RANGES) {
    if ((value & range.mask) >>> 0 === range.base) return range.why;
  }
  return null;
}

function embeddedIpv4(groups: readonly number[]): number {
  return (((groups[6] as number) << 16) >>> 0) + (groups[7] as number);
}

function ipv6Verdict(groups: readonly number[]): string | null {
  const [g0, g1, g2, g3, g4, g5] = groups as [number, number, number, number, number, number];
  const zeroTo = (n: number) => groups.slice(0, n).every((g) => g === 0);
  // ::ffff:a.b.c.d (IPv4-mapped): judged by the IPv4 address.
  if (zeroTo(5) && g5 === 0xffff) {
    const why = ipv4Verdict(embeddedIpv4(groups));
    return why === null ? null : `${why}, as an IPv4-mapped address`;
  }
  // 64:ff9b::a.b.c.d (NAT64, RFC 6052): what DNS64 hands out for IPv4-only hosts.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const why = ipv4Verdict(embeddedIpv4(groups));
    return why === null ? null : `${why}, through NAT64`;
  }
  if (zeroTo(7) && groups[7] === 1) return "this machine (loopback)";
  if (zeroTo(8)) return "the unspecified address";
  if ((g0 & 0xe000) !== 0x2000) {
    if ((g0 & 0xfe00) === 0xfc00) return "a unique-local network (fc00::/7)";
    if ((g0 & 0xffc0) === 0xfe80) return "link-local";
    if ((g0 & 0xffc0) === 0xfec0) return "site-local";
    if ((g0 & 0xff00) === 0xff00) return "multicast";
    return "not a global unicast address";
  }
  if (g0 === 0x2001 && g1 === 0) return "Teredo tunnelling";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation";
  if (g0 === 0x2001 && g1 < 0x0200) return "IETF protocol assignments";
  if (g0 === 0x2002) return "6to4 tunnelling";
  if (g0 === 0x3fff && g1 < 0x1000) return "documentation";
  return null;
}

/**
 * Why an IP address is not on the public internet ("this machine (loopback)"), or null when
 * WebFetch may connect to it. Anything that is not a valid IP address is refused.
 */
export function addressRefusal(address: string): string | null {
  const family = isIP(address.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (family === 4) {
    const value = ipv4ToNumber(address);
    return value === null ? "not a valid address" : ipv4Verdict(value);
  }
  if (family === 6) {
    const groups = parseIpv6(address);
    return groups === null ? "not a valid address" : ipv6Verdict(groups);
  }
  return "not a valid address";
}

/**
 * Why a hostname is refused before any lookup, or null. As documented, `localhost` and names
 * without a dot are refused; so are the names that by definition stay on the machine or the
 * local network (`.localhost`, mDNS's `.local`). IP literals are judged by `addressRefusal`.
 */
export function hostnameRefusal(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) {
    const why = addressRefusal(bare);
    return why === null ? null : `${bare} is ${why}`;
  }
  if (host === "") return "the URL has no host";
  if (host === "localhost" || host.endsWith(".localhost")) {
    return `${host} is this machine`;
  }
  if (!host.includes(".")) return `${host} has no dot, so it names a machine on a local network`;
  if (host.endsWith(".local")) return `${host} is a name on the local network (mDNS)`;
  return null;
}
