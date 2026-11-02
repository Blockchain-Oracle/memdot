import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * An account can point its models at any address, and memories can name a document by URL. The
 * server fetches on its behalf, so this refuses anything that reaches inside its own network.
 */
function isPrivate(address: string): boolean {
  const ip = address.toLowerCase();
  if (isIP(ip) === 6) {
    if (ip === "::1" || ip === "::" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip)) return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivate(mapped[1] as string) : false;
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
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
  const addresses = await lookup(parsed.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivate(address))) {
    throw new BlockedAddressError(parsed.hostname);
  }
}

/** `fetch` for addresses a caller chose. Redirects are followed by hand so each hop is checked. */
export const safeFetch: typeof fetch = async (input, init) => {
  let url = input instanceof Request ? input.url : String(input);
  for (let hop = 0; hop < 3; hop += 1) {
    await assertPublicUrl(url);
    const response = await fetch(url, { ...init, redirect: "manual" });
    const next = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !next) return response;
    url = new URL(next, url).toString();
  }
  throw new Error("Too many redirects.");
};
