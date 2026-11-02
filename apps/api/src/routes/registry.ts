import { createRoute, z } from "@hono/zod-openapi";
import { toHex } from "@memdot/chain";
import { Action, bytes32ToUuid, memDotRegistryAbi, NO_SALT } from "@memdot/contracts";
import { accounts, spaces } from "@memdot/db";
import { enqueueChainTx } from "@memdot/jobs";
import { blake2b } from "@noble/hashes/blake2.js";
import { and, eq } from "drizzle-orm";
import { decodeFunctionData, type Hex, hexToBytes } from "viem";
import { db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { accountOf, assertSpaceAllowed, principalOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import type { Services } from "../types.js";

/** Large enough for one object list; the relayer pays for every byte of calldata. */
export const MAX_CALLDATA_HEX_CHARS = 16_384;
const SPACE_ID_BYTES = 32;

/** Records about the account itself rather than a space: key bundles, sharing keys, grant keys. */
const ACCOUNT_ACTIONS = new Set<number>([
  Action.RegisterKey,
  Action.RegisterAgent,
  Action.RevokeAgent,
  Action.DeleteAccount,
  Action.AddObjects,
  Action.TombstoneObjects,
]);

export function decodeRecordCall(calldata: Hex) {
  try {
    const { functionName, args } = decodeFunctionData({ abi: memDotRegistryAbi, data: calldata });
    if (functionName === "record") return args;
  } catch {}
  throw badRequest("BAD_RECORD", "That is not a registry record.");
}

export function registryRoutes(services: Services) {
  return createRouter().openapi(
    createRoute({
      method: "post",
      path: "/v1/registry/records",
      tags: ["Registry"],
      summary: "Submit an owner-signed registry record",
      description:
        "MemDot's relayer submits the record to MemDotRegistry on Portaldot V3 and pays the fee. The contract checks the owner's signature, so the API cannot forge or alter a record. Spaces named in a record must belong to the caller.",
      security: authenticated,
      middleware: [requireScope("files", "write")] as const,
      request: {
        body: {
          required: true,
          content: jsonContent(
            z.object({
              calldata: z
                .string()
                .max(MAX_CALLDATA_HEX_CHARS)
                .regex(/^0x[0-9a-fA-F]+$/)
                .openapi({ description: "ABI-encoded MemDotRegistry.record(...) call" }),
            }),
          ),
        },
      },
      responses: {
        202: {
          description: "Queued for the relayer",
          content: jsonContent(z.object({ queued: z.literal(true) })),
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const accountId = accountOf(c);
      const calldata = c.req.valid("json").calldata as Hex;
      const [owner, salt, action] = decodeRecordCall(calldata);

      const [account] = await db
        .select({ registryOwner: accounts.registryOwner })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (!account) throw notFound("Account");
      if (account.registryOwner && account.registryOwner !== owner) {
        throw forbidden("Records for this account are signed by a different key.");
      }
      if (!account.registryOwner && action !== Action.RegisterKey) {
        throw conflict("REGISTER_KEY_FIRST", "Register this account's key first.");
      }

      let chainSpaceId: string | null = null;
      if (salt === NO_SALT) {
        if (!ACCOUNT_ACTIONS.has(action)) {
          throw badRequest("BAD_RECORD", "That record must name a space.");
        }
      } else {
        // A deleted space still counts: its deletion is recorded after it happens.
        const [space] = await db
          .select({ chainSpaceId: spaces.chainSpaceId })
          .from(spaces)
          .where(and(eq(spaces.id, bytes32ToUuid(salt)), eq(spaces.accountId, accountId)))
          .limit(1);
        if (!space) throw notFound("Space");
        assertSpaceAllowed(principalOf(c), bytes32ToUuid(salt));
        if (action === Action.CreateSpace && !space.chainSpaceId) {
          const preimage = new Uint8Array([...hexToBytes(owner), ...hexToBytes(salt)]);
          chainSpaceId = toHex(blake2b(preimage, { dkLen: SPACE_ID_BYTES }));
        }
      }

      await db.transaction(async (tx) => {
        if (!account.registryOwner) {
          await tx.update(accounts).set({ registryOwner: owner }).where(eq(accounts.id, accountId));
        }
        if (chainSpaceId) {
          await tx
            .update(spaces)
            .set({ chainSpaceId })
            .where(eq(spaces.id, bytes32ToUuid(salt)));
        }
        await enqueueChainTx(services.boss, tx, { action: "registry", calldata });
      });
      return c.json({ queued: true as const }, 202);
    },
  );
}
