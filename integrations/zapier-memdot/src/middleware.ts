import type { AfterResponseMiddleware, BeforeRequestMiddleware } from "zapier-platform-core";
import { CLIENT, DEFAULT_API_URL } from "./constants.js";

/** Every action names a path; this adds where it goes and who's asking. */
export const addAuth: BeforeRequestMiddleware = (request, z, bundle) => {
  const apiUrl = String(bundle.authData?.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  // This address is typed in by hand, and it's about to be handed the key.
  if (!apiUrl.startsWith("https://")) {
    throw new z.errors.Error("The API URL has to start with https://.", "BadApiUrl", 400);
  }
  if (request.url.startsWith("/")) request.url = `${apiUrl}${request.url}`;
  request.headers = {
    ...request.headers,
    "x-memdot-client": CLIENT,
    ...(bundle.authData?.apiKey ? { authorization: `Bearer ${bundle.authData.apiKey}` } : {}),
  };
  return request;
};

/** The API's own words, which already say what to do next. */
export const handleErrors: AfterResponseMiddleware = (response, z) => {
  if (response.status < 400) return response;
  // A search that finds nothing isn't an error, and that action asks to see the 404.
  if (response.status === 404 && response.request.skipThrowForStatus) return response;
  const { error } = (response.data ?? {}) as { error?: { code?: string; message?: string } };
  const message = error?.message ?? `MemDot answered ${response.status}.`;
  if (response.status === 401) {
    throw new z.errors.Error(
      "MemDot refused this key: it was revoked or has expired. Reconnect with a new one.",
      "AuthenticationError",
      401,
    );
  }
  if (response.status === 429) throw new z.errors.ThrottledError(message);
  throw new z.errors.Error(message, error?.code ?? "MemDotError", response.status);
};
