/** An error the MemDot API answered with; `code` is stable, `message` is for people. */
export class MemDotError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "MemDotError";
  }
}

/** Raised before any request when an operation needs the account unlocked on this device. */
export class LockedError extends Error {
  constructor(what = "this") {
    super(`Unlock the account to do ${what}: the keys stay on your device.`);
    this.name = "LockedError";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; requestId?: string; details?: unknown };
}

export async function errorFrom(response: Response): Promise<MemDotError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // Not JSON (a proxy error page, say); the status still tells the story.
  }
  return new MemDotError(
    response.status,
    body.error?.code ?? `HTTP_${response.status}`,
    body.error?.message ?? response.statusText,
    body.error?.requestId ?? response.headers.get("x-request-id"),
    body.error?.details,
  );
}
