import { CLIENT_HEADER, IDEMPOTENCY_HEADER } from "@memdot/config";
import createClient, { type Middleware } from "openapi-fetch";
import { errorFrom, MemDotError } from "./errors.js";
import type { paths } from "./schema.js";

export const SDK_CLIENT = "sdk-ts/0.0.0";

export interface TransportOptions {
  /** The API's base URL, for example https://api.memdot.xyz. */
  baseUrl: string;
  /** An `md_` key for servers, agents and scripts. Without one, the SDK uses a session. */
  apiKey?: string;
  /**
   * Sent as Origin on session requests from Node, where the API checks it like a browser would.
   * Browsers set their own.
   */
  origin?: string;
  fetch?: typeof fetch;
  /** Names the caller in the activity log (default `sdk-ts/<version>`). */
  client?: string;
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

/**
 * One connection to the API. JSON routes go through a client typed from the OpenAPI document;
 * binary routes (uploads, the CID gateway) and sign-in use `send`. Both carry the same auth:
 * the API key, or the session (browser cookies, or a cookie jar kept here in Node).
 */
export class Transport {
  readonly api: ReturnType<typeof createClient<paths>>;
  private cookies = new Map<string, string>();

  constructor(private readonly options: TransportOptions) {
    this.api = createClient<paths>({
      baseUrl: options.baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(isBrowser ? { credentials: "include" } : {}),
    });
    const auth: Middleware = {
      onRequest: ({ request }) => {
        this.decorate(request.headers);
        return request;
      },
      onResponse: ({ response }) => {
        this.remember(response);
        return response;
      },
    };
    this.api.use(auth);
  }

  get apiKey(): string | undefined {
    return this.options.apiKey;
  }

  set apiKey(value: string | undefined) {
    this.options.apiKey = value;
  }

  /** A raw request with the same auth, for binary bodies, streams and the auth endpoints. */
  async send(
    method: string,
    path: string,
    init: { body?: BodyInit | null; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    this.decorate(headers);
    let body = init.body ?? null;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const doFetch = this.options.fetch ?? fetch;
    const response = await doFetch(new URL(path, this.options.baseUrl), {
      method,
      headers,
      body,
      ...(isBrowser ? { credentials: "include" as const } : {}),
    });
    this.remember(response);
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  async json<T>(method: string, path: string, json?: unknown): Promise<T> {
    const response = await this.send(method, path, json === undefined ? {} : { json });
    return (await response.json()) as T;
  }

  async bytes(path: string): Promise<Uint8Array> {
    const response = await this.send("GET", path);
    return new Uint8Array(await response.arrayBuffer());
  }

  idempotencyHeader(key: string): Record<string, string> {
    return { [IDEMPOTENCY_HEADER]: key };
  }

  private decorate(headers: Headers): void {
    headers.set(CLIENT_HEADER, this.options.client ?? SDK_CLIENT);
    if (this.options.apiKey) {
      headers.set("authorization", `Bearer ${this.options.apiKey}`);
      return;
    }
    if (!isBrowser) {
      if (this.cookies.size > 0) {
        headers.set(
          "cookie",
          [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        );
      }
      if (this.options.origin) headers.set("origin", this.options.origin);
    }
  }

  private remember(response: Response): void {
    if (isBrowser) return;
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value === "" || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

/** Unwraps an openapi-fetch result: the data, or the API's error as a MemDotError. */
export async function unwrap<T>(
  result: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await result;
  if (error !== undefined || !response.ok) {
    const body = (error ?? {}) as {
      error?: { code?: string; message?: string; requestId?: string; details?: unknown };
    };
    throw new MemDotError(
      response.status,
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.message ?? response.statusText,
      body.error?.requestId ?? response.headers.get("x-request-id"),
      body.error?.details,
    );
  }
  return data as T;
}
