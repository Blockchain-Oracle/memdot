import { folders, objects, spaces } from "@memdot/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db.js";
import type { AppEnv } from "../types.js";
import { notFound } from "./errors.js";
import { accountOf, assertSpaceAllowed, principalOf } from "./principal.js";

// Every lookup by id checks the caller owns the row. Someone else's id answers "not found", so
// ids cannot be probed.

export async function loadSpace(c: Context<AppEnv>, spaceId: string) {
  const accountId = accountOf(c);
  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.accountId, accountId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!space) throw notFound("Space");
  assertSpaceAllowed(principalOf(c), space.id);
  return space;
}

export async function loadFolder(c: Context<AppEnv>, folderId: string) {
  const accountId = accountOf(c);
  const [row] = await db
    .select({ folder: folders })
    .from(folders)
    .innerJoin(spaces, eq(spaces.id, folders.spaceId))
    .where(
      and(
        eq(folders.id, folderId),
        eq(spaces.accountId, accountId),
        isNull(folders.deletedAt),
        isNull(spaces.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Folder");
  assertSpaceAllowed(principalOf(c), row.folder.spaceId);
  return row.folder;
}

export async function loadObject(c: Context<AppEnv>, objectId: string) {
  const accountId = accountOf(c);
  const [object] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.id, objectId), eq(objects.accountId, accountId)))
    .limit(1);
  if (!object) throw notFound("Object");
  const principal = principalOf(c);
  if (object.spaceId) assertSpaceAllowed(principal, object.spaceId);
  // Key bundles and grant keys belong to the whole account: invisible to space-limited keys.
  else if (principal.apiKey?.spaceIds) throw notFound("Object");
  return object;
}
