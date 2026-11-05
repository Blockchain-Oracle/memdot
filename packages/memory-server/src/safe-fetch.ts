import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * An account can point its models at any address, and memories can name a document by URL. The
 * server fetches on its behalf, so this refuses anything that reaches inside its own network.
 */
function isPrivateV4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The 16 bytes of an IPv6 address, however it's written. */
function ipv6Bytes(ip: string): number[] {
  // A dotted ending (::ffff:127.0.0.1) is the last two groups.
  const dotted = ip.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const text = dotted
    ? `${ip.slice(0, dotted.index)}${((Number(dotted[1]) << 8) | Number(dotted[2])).toString(16)}:${(
        (Number(dotted[3]) << 8) | Number(dotted[4])
      ).toString(16)}`
    : ip;
  const [head = "", tail] = text.split("::");
  const groups = (part: string) =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const words = [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().split("%")[0] as string;
  if (isIP(ip) !== 6) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return isPrivateV4(a, b);
  }
  const bytes = ipv6Bytes(ip);
  const at = (index: number) => bytes[index] as number;
  const leadingZeros = (count: number) => bytes.slice(0, count).every((byte) => byte === 0);
  // ::, ::1 and the old IPv4-compatible form.
  if (leadingZeros(12)) return true;
  // fc00::/7 unique local, fe80::/10 link local, fec0::/10 site local, ff00::/8 multicast.
  if ((at(0) & 0xfe) === 0xfc || (at(0) === 0xfe && at(1) >= 0x80) || at(0) === 0xff) return true;
  // An IPv4 address in disguise, which can reach whatever that address can.
  const mapped = leadingZeros(10) && at(10) === 0xff && at(11) === 0xff;
  const nat64 = at(0) === 0 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b;
  if (mapped || nat64) return isPrivateV4(at(12), at(13));
  if (at(0) === 0x20 && at(1) === 0x02) return isPrivateV4(at(2), at(3));
  return false;
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`MemDot won't call ${host}: use a public https address.`);
    this.name = "BlockedAddressError";
  }
}

/** Throws unless the URL is public https. */
export async function assertPublicUrl(url: string | URL): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new BlockedAddressError(parsed.hostname);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new BlockedAddressError(parsed.hostname);
  }
}

/**
 * `fetch` for addresses a caller chose. Redirects are followed by hand so each hop is checked. A
 * caller that asks for `redirect: "manual"` gets the 3xx itself: a signed webhook delivery must not
 * be sent on to wherever its endpoint points.
 */
export const safeFetch: typeof fetch = async (input, init) => {
  let url = input instanceof Request ? input.url : String(input);
  for (let hop = 0; hop < 3; hop += 1) {
    await assertPublicUrl(url);
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (init?.redirect === "manual") return response;
    const next = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !next) return response;
    url = new URL(next, url).toString();
  }
  throw new Error("Too many redirects.");
};
