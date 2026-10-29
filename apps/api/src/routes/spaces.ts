import { createRoute, z } from "@hono/zod-openapi";
import { MAX_SPACES_PER_ACCOUNT } from "@memdot/config";
import { account as authAccount, folders, objects, spaces } from "@memdot/db";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";
import { conflict } from "../lib/errors.js";
import { tombstoneObjects } from "../lib/lifecycle.js";
import { loadSpace } from "../lib/ownership.js";
import { accountOf, principalOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { fromBase64, IdParam, SealedText, toBase64 } from "../schemas.js";

const Mode = z.enum(["sponsored", "self_signed"]).openapi({
  description:
    "sponsored: MemDot's relayer signs and pays within the quota. self_signed: your wallet signs every store.",
});

export const Space = z
  .object({
    id: z.uuid(),
    chainSpaceId: z.string().nullable(),
    encryptedName: z.string(),
    mode: Mode,
    keyEpoch: z.number().int(),
    quotaBytes: z.number().int(),
    usedBytes: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Space");

type SpaceRow = typeof spaces.$inferSelect;
export const serializeSpace = (row: SpaceRow) => ({
  id: row.id,
  chainSpaceId: row.chainSpaceId,
  encryptedName: toBase64(row.encryptedName) ?? "",
  mode: row.mode,
  keyEpoch: row.keyEpoch,
  quotaBytes: row.quotaBytes,
  usedBytes: row.usedBytes,
  createdAt: row.createdAt.toISOString(),
});

async function hasWallet(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), inArray(authAccount.providerId, ["siws", "siwe"])))
    .limit(1);
  return !!row;
}

export function spaceRoutes() {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/spaces",
        tags: ["Spaces"],
        summary: "List spaces",
        security: authenticated,
        middleware: [requireScope("spaces", "read")] as const,
        responses: {
          200: { description: "Spaces", content: jsonContent(z.object({ items: z.array(Space) })) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const allowed = principalOf(c).apiKey?.spaceIds;
        const rows = await db
          .select()
          .from(spaces)
          .where(
            and(
              eq(spaces.accountId, accountId),
              isNull(spaces.deletedAt),
              allowed ? inArray(spaces.id, allowed) : undefined,
            ),
          )
          .orderBy(asc(spaces.createdAt));
        return c.json({ items: rows.map(serializeSpace) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/spaces",
        tags: ["Spaces"],
        summary: "Create a space",
        security: authenticated,
        middleware: [requireScope("spaces", "manage")] as const,
        request: {
          body: {
            content: jsonContent(
              z
                .object({ encryptedName: SealedText, mode: Mode.default("sponsored") })
                .openapi("NewSpace"),
            ),
            required: true,
          },
        },
        responses: {
          201: { description: "Created", content: jsonContent(Space) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const body = c.req.valid("json");
        if (body.mode === "self_signed" && !(await hasWallet(principalOf(c).userId))) {
          throw conflict(
            "WALLET_REQUIRED",
            "Self-signed spaces need a linked wallet to sign each store. Link Talisman, SubWallet or MetaMask first.",
          );
        }
        const [existing] = await db
          .select({ n: count() })
          .from(spaces)
          .where(and(eq(spaces.accountId, accountId), isNull(spaces.deletedAt)));
        if ((existing?.n ?? 0) >= MAX_SPACES_PER_ACCOUNT) {
          throw conflict(
            "SPACE_LIMIT",
            `An account can have up to ${MAX_SPACES_PER_ACCOUNT} spaces.`,
          );
        }
        const [row] = await db
          .insert(spaces)
          .values({
            accountId,
            encryptedName: fromBase64(body.encryptedName),
            mode: body.mode,
            quotaBytes: env.SPONSORED_QUOTA_BYTES,
          })
          .returning();
        if (!row) throw new Error("space insert returned no row");
        return c.json(serializeSpace(row), 201);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/spaces/{id}",
        tags: ["Spaces"],
        summary: "Get a space with its usage",
        security: authenticated,
        middleware: [requireScope("spaces", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: { description: "Space", content: jsonContent(Space) },
          ...errorResponses,
        },
      }),
      async (c) => c.json(serializeSpace(await loadSpace(c, c.req.valid("param").id)), 200),
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/v1/spaces/{id}",
        tags: ["Spaces"],
        summary: "Rename a space or switch who signs future writes",
        security: authenticated,
        middleware: [requireScope("spaces", "manage")] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              z.object({ encryptedName: SealedText.optional(), mode: Mode.optional() }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Space", content: jsonContent(Space) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const space = await loadSpace(c, c.req.valid("param").id);
        const body = c.req.valid("json");
        if (body.mode === "self_signed" && !(await hasWallet(principalOf(c).userId))) {
          throw conflict(
            "WALLET_REQUIRED",
            "Link a wallet before switching to self-signed writes.",
          );
        }
        if (body.mode && body.mode !== space.mode) {
          const [inFlight] = await db
            .select({ n: count() })
            .from(objects)
            .where(
              and(eq(objects.spaceId, space.id), inArray(objects.status, ["queued", "uploading"])),
            );
          if ((inFlight?.n ?? 0) > 0) {
            throw conflict(
              "UPLOADS_IN_FLIGHT",
              "Finish or cancel this space's uploads before switching who signs them.",
            );
          }
        }
        const [row] = await db
          .update(spaces)
          .set({
            ...(body.encryptedName ? { encryptedName: fromBase64(body.encryptedName) } : {}),
            ...(body.mode ? { mode: body.mode } : {}),
          })
          .where(eq(spaces.id, space.id))
          .returning();
        if (!row) throw new Error("space update returned no row");
        return c.json(serializeSpace(row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/spaces/{id}",
        tags: ["Spaces"],
        summary: "Delete a space",
        description:
          "Tombstones every object, stops renewing them and frees the quota. Stored bytes expire from the chain within 7 days; anything already shared or downloaded cannot be recalled.",
        security: authenticated,
        middleware: [requireScope("spaces", "manage")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Deleted",
            content: jsonContent(z.object({ deleted: z.literal(true), objects: z.number().int() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const space = await loadSpace(c, c.req.valid("param").id);
        const tombstoned = await db.transaction(async (tx) => {
          const n = await tombstoneObjects(tx, eq(objects.spaceId, space.id));
          const now = new Date();
          await tx.update(folders).set({ deletedAt: now }).where(eq(folders.spaceId, space.id));
          await tx
            .update(spaces)
            .set({ deletedAt: now, usedBytes: 0 })
            .where(eq(spaces.id, space.id));
          return n;
        });
        return c.json({ deleted: true as const, objects: tombstoned }, 200);
      },
    );
}
