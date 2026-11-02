import { createRoute, z } from "@hono/zod-openapi";
import { memoryConfig } from "@memdot/db";
import { EMBEDDING_PROVIDERS, LLM_PROVIDERS, PROVIDERS } from "@memdot/memory-engine";
import { generateInstructions } from "@memdot/memory-engine/llm";
import { assertPublicUrl, BlockedAddressError } from "@memdot/memory-server";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest, conflict, HttpError } from "../lib/errors.js";
import { accountModels, spendSharedModel } from "../lib/namespaces.js";
import {
  accountOf,
  isAccountWide,
  principalOf,
  requireAccountWide,
  requireScope,
} from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { fromBase64, toBase64 } from "../schemas.js";
import type { Services } from "../types.js";

/** Largest sealed blob of a device's Private settings. */
const MAX_PRIVATE_SEALED_BASE64 = 16_384;

const ModelSource = z.enum(["account", "service", "none"]);

const EffectiveModel = z.object({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  base_url: z.string().nullable(),
  has_key: z.boolean(),
  source: ModelSource.openapi({
    description: "Whose key is used: this account's, MemDot's shared one, or none is set",
  }),
});

const Configuration = z
  .object({
    llm: EffectiveModel,
    embedder: EffectiveModel,
    private_sealed: z.string().nullable().openapi({
      description: "Private namespaces' settings, sealed on a device. The server can't open them.",
    }),
    daily_shared_writes: z.number().int(),
  })
  .openapi("MemoryConfiguration");

const stored = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
});

const NewLlm = z.object({
  provider: z.enum(LLM_PROVIDERS),
  model: z.string().min(1).max(128),
  api_key: z.string().min(1).max(512).optional().openapi({
    description: "Kept encrypted. Leave out to keep the one already set.",
  }),
  base_url: z.url().optional(),
});
const NewEmbedder = NewLlm.extend({ provider: z.enum(EMBEDDING_PROVIDERS) });

type Row = typeof memoryConfig.$inferSelect | undefined;

function effective(
  choice: unknown,
  sealedKey: Uint8Array | null | undefined,
  fallback: { provider?: string | undefined; model?: string | undefined; key?: string | undefined },
) {
  const own = stored.safeParse(choice);
  if (own.success && sealedKey) {
    return {
      provider: own.data.provider,
      model: own.data.model,
      base_url: own.data.baseUrl ?? null,
      has_key: true,
      source: "account" as const,
    };
  }
  if (fallback.provider && fallback.model && fallback.key) {
    return {
      provider: fallback.provider,
      model: fallback.model,
      base_url: null,
      has_key: true,
      source: "service" as const,
    };
  }
  return { provider: null, model: null, base_url: null, has_key: false, source: "none" as const };
}

function serialize(row: Row) {
  return {
    llm: effective(row?.llm, row?.llmKeySealed, {
      provider: env.MEMORY_LLM_PROVIDER,
      model: env.MEMORY_LLM_MODEL,
      key: env.MEMORY_LLM_API_KEY,
    }),
    embedder: effective(row?.embedder, row?.embedderKeySealed, {
      provider: env.MEMORY_EMBEDDING_PROVIDER,
      model: env.MEMORY_EMBEDDING_MODEL,
      key: env.MEMORY_EMBEDDING_API_KEY,
    }),
    private_sealed: toBase64(row?.privateSealed ?? null),
    daily_shared_writes: env.MEMORY_DAILY_SHARED_WRITES,
  };
}

/** Refuses an address that reaches inside our network, in words the caller can act on. */
async function checkAddress(url: string | undefined) {
  if (!url) return;
  try {
    await assertPublicUrl(url);
  } catch (error) {
    if (error instanceof BlockedAddressError) throw badRequest("BLOCKED_ADDRESS", error.message);
    throw badRequest("BAD_ADDRESS", `Couldn't reach ${url}.`);
  }
}

export function configureRoutes(services: Services) {
  const keys = services.memoryKeys;

  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/configure",
        tags: ["Configuration"],
        summary: "The models this account's Assisted memories use",
        description: "Keys are never returned.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        responses: {
          200: { description: "Configuration", content: jsonContent(Configuration) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const [row] = await db
          .select()
          .from(memoryConfig)
          .where(eq(memoryConfig.accountId, accountOf(c)));
        // The owner's own sealed settings are for their device, not for a key limited to some spaces.
        const config = serialize(row);
        return c.json(
          isAccountWide(principalOf(c)) ? config : { ...config, private_sealed: null },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/v1/configure",
        tags: ["Configuration"],
        summary: "Choose this account's models",
        description:
          "Your own key has no daily limit. Changing the embedder means existing memories need re-embedding: run Restore on each namespace. null goes back to MemDot's model.",
        security: authenticated,
        middleware: [requireAccountWide, requireScope("memories", "write")] as const,
        request: {
          body: {
            content: jsonContent(
              z.object({
                llm: NewLlm.nullable().optional(),
                embedder: NewEmbedder.nullable().optional(),
                private_sealed: z
                  .base64()
                  .max(MAX_PRIVATE_SEALED_BASE64)
                  .nullable()
                  .optional()
                  .openapi({ description: "Sealed on your device; only ever stored" }),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Configuration", content: jsonContent(Configuration) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const body = c.req.valid("json");
        await checkAddress(body.llm?.base_url);
        await checkAddress(body.embedder?.base_url);
        const [current] = await db
          .select()
          .from(memoryConfig)
          .where(eq(memoryConfig.accountId, accountId));
        const choose = (
          next: typeof body.llm,
          choiceNow: unknown,
          sealedNow: Uint8Array | null | undefined,
        ): { choice: unknown; sealed: Uint8Array | null } => {
          if (!next) return { choice: null, sealed: null };
          // A saved key only ever goes where it was saved for: a key that could be pointed at a
          // new address could be read back by anyone holding an API key.
          const saved = stored.safeParse(choiceNow);
          const sameDestination =
            saved.success &&
            saved.data.provider === next.provider &&
            (saved.data.baseUrl ?? undefined) === next.base_url;
          const sealed = next.api_key
            ? keys.sealForAccount(accountId, next.api_key)
            : sameDestination
              ? (sealedNow ?? null)
              : null;
          if (!sealed) throw conflict("KEY_REQUIRED", `Give an API key for ${next.provider}.`);
          return {
            choice: {
              provider: next.provider,
              model: next.model,
              ...(next.base_url ? { baseUrl: next.base_url } : {}),
            },
            sealed,
          };
        };
        const llm =
          body.llm === undefined ? null : choose(body.llm, current?.llm, current?.llmKeySealed);
        const embedder =
          body.embedder === undefined
            ? null
            : choose(body.embedder, current?.embedder, current?.embedderKeySealed);
        const values = {
          ...(llm ? { llm: llm.choice, llmKeySealed: llm.sealed } : {}),
          ...(embedder ? { embedder: embedder.choice, embedderKeySealed: embedder.sealed } : {}),
          ...(body.private_sealed !== undefined
            ? { privateSealed: body.private_sealed ? fromBase64(body.private_sealed) : null }
            : {}),
          updatedAt: new Date(),
        };
        const [row] = await db
          .insert(memoryConfig)
          .values({ accountId, ...values })
          .onConflictDoUpdate({ target: memoryConfig.accountId, set: values })
          .returning();
        return c.json(serialize(row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/configure/providers",
        tags: ["Configuration"],
        summary: "Model providers MemDot can call",
        security: authenticated,
        responses: {
          200: {
            description: "Providers",
            content: jsonContent(
              z.object({
                providers: z.array(
                  z.object({
                    id: z.string(),
                    label: z.string(),
                    llmModels: z.array(z.string()),
                    embeddingModels: z.array(z.string()),
                    needsBaseUrl: z.boolean(),
                  }),
                ),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      (c) => c.json({ providers: PROVIDERS }, 200),
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/configure/test",
        tags: ["Configuration"],
        summary: "Try the configured models",
        description: "Sends one short request to each, and reports what they said back.",
        security: authenticated,
        // It spends the owner's model key on text the caller chooses.
        middleware: [requireScope("memories", "write"), requireAccountWide] as const,
        responses: {
          200: {
            description: "Result",
            content: jsonContent(
              z.object({
                llm: z.object({ ok: z.boolean(), error: z.string().nullable() }),
                embedder: z.object({
                  ok: z.boolean(),
                  dimensions: z.number().int().nullable(),
                  error: z.string().nullable(),
                }),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        await spendSharedModel(c);
        const models = await accountModels(c, services);
        const reason = (error: unknown) =>
          (error instanceof Error ? error.message : String(error)).slice(0, 300);
        let llm: { ok: boolean; error: string | null } = { ok: false, error: "No model is set." };
        if (models.llm) {
          llm = await generateText({ model: models.llm, prompt: "Reply with the word ok." }).then(
            () => ({ ok: true, error: null }),
            (error: unknown) => ({ ok: false, error: reason(error) }),
          );
        }
        let embedder: { ok: boolean; dimensions: number | null; error: string | null } = {
          ok: false,
          dimensions: null,
          error: "No embedder is set.",
        };
        if (models.embedder) {
          embedder = await models.embedder.embed(["memdot"], "document").then(
            (vectors) => ({ ok: true, dimensions: vectors[0]?.length ?? null, error: null }),
            (error: unknown) => ({ ok: false, dimensions: null, error: reason(error) }),
          );
        }
        return c.json({ llm, embedder }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/generate-instructions",
        tags: ["Configuration"],
        summary: "Draft a namespace's custom instructions from a use case",
        security: authenticated,
        // It spends the owner's model key on text the caller chooses.
        middleware: [requireScope("memories", "write"), requireAccountWide] as const,
        request: {
          body: {
            content: jsonContent(z.object({ use_case: z.string().trim().min(1).max(2_000) })),
            required: true,
          },
        },
        responses: {
          200: {
            description: "A draft",
            content: jsonContent(
              z.object({ custom_instructions: z.string(), test_message: z.string() }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const models = await accountModels(c, services);
        if (!models.llm) {
          throw new HttpError(409, "MODEL_REQUIRED", "Set a model under Configuration first.");
        }
        await spendSharedModel(c);
        return c.json(await generateInstructions(models.llm, c.req.valid("json").use_case), 200);
      },
    );
}
