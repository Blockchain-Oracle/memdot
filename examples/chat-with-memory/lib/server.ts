import { createMemDot } from "@memdot/ai-sdk";
import { cookies } from "next/headers";

export const memdot = createMemDot();
export const MODEL = process.env.EXAMPLE_MODEL ?? "gemini-2.5-flash";

const COOKIE = "memdot-example-user";
const YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Who's asking. This cookie stands in for your own sign-in: each browser is a different person, so
 * open another browser to see that memories don't cross. Whatever you use, it has to come from your
 * own session, never from the request body, or anyone could read anyone's memories.
 */
export async function currentUser(): Promise<string> {
  const jar = await cookies();
  const known = jar.get(COOKIE)?.value;
  if (known) return known;
  const created = `chat-${crypto.randomUUID()}`;
  jar.set(COOKIE, created, { httpOnly: true, sameSite: "lax", maxAge: YEAR_SECONDS });
  return created;
}
