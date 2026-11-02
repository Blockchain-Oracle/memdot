import { folders, memories, memoryConfig, memoryModelUsage, spaces } from "@memdot/db";
import { FilterError, type FilterNode, parseFilter } from "@memdot/memory-engine";
import { modelsFor } from "@memdot/memory-server";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db.js";
import { env } from "../env.js";
import type { AppEnv, Services } from "../types.js";
import { badRequest, HttpError } from "./errors.js";
import { loadFolder } from "./ownership.js";
import { accountOf, principalOf } from "./principal.js";

export type Namespace = typeof folders.$inferSelect & { memoryMode: "private" | "assisted" };

function asNamespace(folder: typeof folders.$inferSelect): Namespace {
  if (folder.memoryMode === "off") {
    throw badRequest("NOT_A_NAMESPACE", "That folder isn't in memory mode.");
  }
  return folder as Namespace;
}

/** A folder in memory mode the caller may reach. */
export async function loadNamespace(c: Context<AppEnv>, id: string): Promise<Namespace> {
  return asNamespace(await loadFolder(c, id));
}

/** The server can only serve Assisted namespaces; Private ones have no key or index here. */
export function assertAssisted(namespace: Namespace): void {
  if (namespace.memoryMode !== "assisted") {
    throw new HttpError(
      409,
      "PRIVATE_NAMESPACE",
      "This namespace is Private: its memories are read and searched on your device, so use the SDK.",
      { namespaceId: namespace.id },
    );
  }
}

/** The namespace named, or the caller's oldest Assisted one. */
export async function resolveAssisted(
  c: Context<AppEnv>,
  namespaceId: string | undefined,
): Promise<Namespace> {
  if (namespaceId) {
    const namespace = await loadNamespace(c, namespaceId);
    assertAssisted(namespace);
    return namespace;
  }
  const allowed = principalOf(c).apiKey?.spaceIds;
  const [row] = await db
    .select({ folder: folders })
    .from(folders)
    .innerJoin(spaces, eq(spaces.id, folders.spaceId))
    .where(
      and(
        eq(spaces.accountId, accountOf(c)),
        eq(folders.memoryMode, "assisted"),
        isNull(folders.deletedAt),
        isNull(spaces.deletedAt),
        allowed ? inArray(spaces.id, allowed) : undefined,
      ),
    )
    .orderBy(asc(folders.createdAt))
    .limit(1);
  if (!row) {
    throw new HttpError(
      409,
      "NAMESPACE_REQUIRED",
      "Create an Assisted memory namespace first, in the dashboard or at POST /v1/spaces/{id}/folders, or pass namespace_id.",
    );
  }
  return row.folder as Namespace;
}

export function parseFilters(filters: Record<string, unknown> | undefined): FilterNode | undefined {
  if (!filters || Object.keys(filters).length === 0) return undefined;
  try {
    return parseFilter(filters);
  } catch (error) {
    if (error instanceof FilterError) throw badRequest("BAD_FILTER", error.message);
    throw error;
  }
}

/** A row of memories in a namespace the caller can reach, by id. */
export async function loadMemory(c: Context<AppEnv>, id: string) {
  const [row] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.accountId, accountOf(c))));
  if (!row) throw new HttpError(404, "NOT_FOUND", "Memory not found.");
  await loadFolder(c, row.folderId);
  return row;
}

export const liveRows = (where: SQL | undefined) => and(where, isNull(memories.deletedAt));

/** The account's models, for routes that run inline (search, update, summary). */
export function accountModels(c: Context<AppEnv>, services: Services) {
  return modelsFor(db, services.memoryKeys, env, accountOf(c));
}

type UsageColumn = "modelCalls" | "searches";

/** Counts toward today's allowance and returns the new total. */
async function countUsage(accountId: string, column: UsageColumn, by: number): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .insert(memoryModelUsage)
    .values({ accountId, day, [column]: by })
    .onConflictDoUpdate({
      target: [memoryModelUsage.accountId, memoryModelUsage.day],
      set: { [column]: sql`${memoryModelUsage[column]} + ${by}` },
    })
    .returning({ total: memoryModelUsage[column] });
  return row?.total ?? by;
}

/**
 * Every call on MemDot's shared model key counts against the account's daily allowance, whatever
 * route makes it. An account's own key isn't counted. `calls` is how many model calls this will take.
 */
export async function spendSharedModel(c: Context<AppEnv>, calls = 1): Promise<void> {
  const accountId = accountOf(c);
  const [own] = await db
    .select({ key: memoryConfig.llmKeySealed })
    .from(memoryConfig)
    .where(eq(memoryConfig.accountId, accountId));
  if (own?.key) return;
  if ((await countUsage(accountId, "modelCalls", calls)) > env.MEMORY_DAILY_SHARED_WRITES) {
    throw new HttpError(
      429,
      "MODEL_LIMIT",
      `This account has used its ${env.MEMORY_DAILY_SHARED_WRITES} calls for today on MemDot's model. Add your own key under Configuration, or store with infer: false.`,
    );
  }
}

/** The embedder a search may use: past the daily allowance on MemDot's key, none, so keywords only. */
export async function searchEmbedder(c: Context<AppEnv>, services: Services) {
  const models = await accountModels(c, services);
  const accountId = accountOf(c);
  const [own] = await db
    .select({ key: memoryConfig.embedderKeySealed })
    .from(memoryConfig)
    .where(eq(memoryConfig.accountId, accountId));
  if (own?.key || !models.embedder) return { ...models };
  const total = await countUsage(accountId, "searches", 1);
  return total > env.MEMORY_DAILY_SHARED_SEARCHES ? { ...models, embedder: null } : { ...models };
}
