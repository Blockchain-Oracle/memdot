import { createRoute, z } from "@hono/zod-openapi";
import { folders, objects } from "@memdot/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { tombstoneObjects } from "../lib/lifecycle.js";
import { loadFolder, loadSpace } from "../lib/ownership.js";
import { requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { fromBase64, IdParam, SealedText, toBase64, Uuid } from "../schemas.js";

const MemoryMode = z.enum(["off", "private", "assisted"]).openapi({
  description:
    "off: a plain folder. private: memories are extracted and indexed on your device. assisted: the server reads text to extract memories and keeps an index. Fixed at creation.",
});

export const Folder = z
  .object({
    id: z.uuid(),
    spaceId: z.uuid(),
    parentId: z.uuid().nullable(),
    encryptedName: z.string(),
    memoryMode: MemoryMode,
    createdAt: z.iso.datetime(),
  })
  .openapi("Folder");

type FolderRow = typeof folders.$inferSelect;
const serialize = (row: FolderRow) => ({
  id: row.id,
  spaceId: row.spaceId,
  parentId: row.parentId,
  encryptedName: toBase64(row.encryptedName) ?? "",
  memoryMode: row.memoryMode,
  createdAt: row.createdAt.toISOString(),
});

const SpaceParam = z.object({ spaceId: Uuid.openapi({ param: { name: "spaceId", in: "path" } }) });

type Executor = Pick<typeof db, "execute">;

/**
 * The folder and every live folder below it, within its space. `union` (not `union all`) stops
 * at a folder already seen, so even a corrupted parent chain cannot loop forever.
 */
async function subtreeIds(executor: Executor, rootId: string, spaceId: string): Promise<string[]> {
  const result = await executor.execute<{ id: string }>(sql`
    with recursive tree as (
      select id from folders where id = ${rootId}
      union
      select f.id from folders f join tree t on f.parent_id = t.id
       where f.space_id = ${spaceId} and f.deleted_at is null
    )
    select id from tree`);
  return result.rows.map((row) => row.id);
}

/** Folder moves in one space run one at a time, so two moves cannot form a cycle together. */
async function lockSpaceFolders(tx: Executor, spaceId: string): Promise<void> {
  await tx.execute(sql`select id from spaces where id = ${spaceId} for update`);
}

export function folderRoutes() {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/spaces/{spaceId}/folders",
        tags: ["Folders"],
        summary: "List a space's folders",
        description: "A flat list; build the tree from parentId.",
        security: authenticated,
        middleware: [requireScope("spaces", "read")] as const,
        request: { params: SpaceParam },
        responses: {
          200: {
            description: "Folders",
            content: jsonContent(z.object({ items: z.array(Folder) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const space = await loadSpace(c, c.req.valid("param").spaceId);
        const rows = await db
          .select()
          .from(folders)
          .where(and(eq(folders.spaceId, space.id), isNull(folders.deletedAt)))
          .orderBy(asc(folders.createdAt));
        return c.json({ items: rows.map(serialize) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/spaces/{spaceId}/folders",
        tags: ["Folders"],
        summary: "Create a folder or a memory namespace",
        security: authenticated,
        middleware: [requireScope("spaces", "write")] as const,
        request: {
          params: SpaceParam,
          body: {
            content: jsonContent(
              z
                .object({
                  encryptedName: SealedText,
                  parentId: z.uuid().nullable().default(null),
                  memoryMode: MemoryMode.default("off"),
                })
                .openapi("NewFolder"),
            ),
            required: true,
          },
        },
        responses: {
          201: { description: "Created", content: jsonContent(Folder) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const space = await loadSpace(c, c.req.valid("param").spaceId);
        const body = c.req.valid("json");
        if (body.parentId) {
          const parent = await loadFolder(c, body.parentId);
          if (parent.spaceId !== space.id) {
            throw badRequest("PARENT_SPACE", "The parent folder is in another space.");
          }
        }
        const [row] = await db
          .insert(folders)
          .values({
            spaceId: space.id,
            parentId: body.parentId,
            encryptedName: fromBase64(body.encryptedName),
            memoryMode: body.memoryMode,
          })
          .returning();
        if (!row) throw new Error("folder insert returned no row");
        return c.json(serialize(row), 201);
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/v1/folders/{id}",
        tags: ["Folders"],
        summary: "Rename or move a folder",
        description: "A folder's memory mode is fixed; create a new namespace to change it.",
        security: authenticated,
        middleware: [requireScope("spaces", "write")] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              z.object({
                encryptedName: SealedText.optional(),
                parentId: z.uuid().nullable().optional(),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Folder", content: jsonContent(Folder) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const folder = await loadFolder(c, c.req.valid("param").id);
        const body = c.req.valid("json");
        if (body.parentId) {
          const parent = await loadFolder(c, body.parentId);
          if (parent.spaceId !== folder.spaceId) {
            throw badRequest("PARENT_SPACE", "A folder can only move within its space.");
          }
        }
        const row = await db.transaction(async (tx) => {
          await lockSpaceFolders(tx, folder.spaceId);
          if (
            body.parentId &&
            (await subtreeIds(tx, folder.id, folder.spaceId)).includes(body.parentId)
          ) {
            throw badRequest("FOLDER_CYCLE", "A folder cannot move inside itself.");
          }
          const [updated] = await tx
            .update(folders)
            .set({
              ...(body.encryptedName ? { encryptedName: fromBase64(body.encryptedName) } : {}),
              ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
            })
            .where(eq(folders.id, folder.id))
            .returning();
          return updated;
        });
        if (!row) throw new Error("folder update returned no row");
        return c.json(serialize(row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/folders/{id}",
        tags: ["Folders"],
        summary: "Delete a folder and everything in it",
        security: authenticated,
        middleware: [requireScope("spaces", "write")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Deleted",
            content: jsonContent(
              z.object({
                deleted: z.literal(true),
                folders: z.number().int(),
                objects: z.number().int(),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const folder = await loadFolder(c, c.req.valid("param").id);
        const { ids, tombstoned } = await db.transaction(async (tx) => {
          await lockSpaceFolders(tx, folder.spaceId);
          const subtree = await subtreeIds(tx, folder.id, folder.spaceId);
          const n = await tombstoneObjects(
            tx,
            and(eq(objects.spaceId, folder.spaceId), inArray(objects.folderId, subtree)) ??
              sql`false`,
          );
          await tx
            .update(folders)
            .set({ deletedAt: new Date() })
            .where(inArray(folders.id, subtree));
          return { ids: subtree, tombstoned: n };
        });
        return c.json({ deleted: true as const, folders: ids.length, objects: tombstoned }, 200);
      },
    );
}
