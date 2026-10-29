import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";
import { HttpError } from "./errors.js";

/**
 * Fixed-window counters in memory. API keys are limited by Better Auth's api-key plugin (shared
 * through the database); this covers public routes per IP and dashboard sessions per user. One
 * API instance runs today, so a process-local window is exact; several instances would each
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

/** The caller's IP: the first X-Forwarded-For hop behind Coolify's proxy, else the socket. */
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
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
