import { BlockList, isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { env } from "../env.js";
import type { AppEnv } from "../types.js";
import { HttpError } from "./errors.js";

/**
 * Fixed-window counters in memory: per API key, per dashboard user, and per IP on public routes.
 * One API instance runs today, so a process-local window is exact; several instances would each
 * allow the full budget.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), windowMs);
    this.sweeper.unref();
  }

  /** Counts one hit; returns the seconds to wait when the budget is spent, else 0. */
  hit(key: string, now = Date.now()): number {
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    window.count += 1;
    return window.count > this.max ? Math.ceil((window.resetAt - now) / 1000) : 0;
  }

  private sweep(now = Date.now()): void {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

const trusted = new BlockList();
for (const entry of env.TRUSTED_PROXIES) {
  const [address = "", prefix] = entry.split("/");
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  if (prefix) trusted.addSubnet(address, Number(prefix), family);
  else trusted.addAddress(address, family);
}

const isTrusted = (address: string) => {
  const family = isIP(address);
  return family !== 0 && trusted.check(address, family === 6 ? "ipv6" : "ipv4");
};

function socketAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The caller's IP. A client can write any X-Forwarded-For it likes, so the header is only read
 * when the request came through a trusted proxy, walking the chain right to left past trusted
 * hops: the first untrusted address is the client.
 */
export function clientIp(c: Context): string {
  const socket = socketAddress(c);
  if (!isTrusted(socket)) return socket;
  const hops = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i] ?? "";
    if (!isTrusted(hop)) return hop;
  }
  return socket;
}

export function rateLimit(
  limiter: RateLimiter,
  keyOf: (c: Context<AppEnv>) => string | null,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = keyOf(c);
    const retryAfter = key ? limiter.hit(key) : 0;
    if (retryAfter > 0) {
      c.header("retry-after", String(retryAfter));
      throw new HttpError(429, "RATE_LIMITED", "Too many requests. Slow down and retry shortly.");
    }
    await next();
  };
}
