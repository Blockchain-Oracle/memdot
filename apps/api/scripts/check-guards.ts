// Checks the S04 review fixes against a running API, without spending tPOT: key scoping, quota
// and mode-switch guards, concurrent idempotency, pagination across identical timestamps, delete
// semantics and the body limit. Nothing here is uploaded to the chain.
// Usage: pnpm --filter @memdot/api dev, then pnpm --filter @memdot/api check:guards

import { randomBytes } from "node:crypto";
import { cidOf } from "@memdot/chain";
import { b64, Client, check, type Declared, onboard } from "./client.js";

const client = new Client();
await onboard(client);

interface Space {
  id: string;
  usedBytes: number;
  quotaBytes: number;
}
const sealedName = b64(randomBytes(64));
const newSpace = async (mode: "sponsored" | "self_signed" = "sponsored") =>
  (await client.call<Space>("POST", "/v1/spaces", { body: { encryptedName: sealedName, mode } }))
    .json;
const spaceOf = async (id: string) => (await client.call<Space>("GET", `/v1/spaces/${id}`)).json;
const segment = (spaceId: string, bytes = randomBytes(100)) => ({
  kind: "segment",
  spaceId,
  sizeBytes: bytes.length,
  root: { cid: cidOf(bytes), size: bytes.length },
});

const [a, b] = [await newSpace(), await newSpace()];
if (!a || !b) throw new Error("spaces were not created");

// Key scoping: a key limited to one space cannot widen itself.
const scoped = await client.call<{ key: string }>("POST", "/v1/keys", {
  body: { name: "scoped", role: "management", spaceIds: [a.id] },
});
const narrow = new Client();
narrow.apiKey = scoped.json.key;
const escalate = await narrow.call("POST", "/v1/keys", {
  auth: "key",
  body: { name: "wider", role: "management" },
});
check("a space-scoped key cannot mint an unscoped key", escalate.status === 403, escalate.json);
const log = await narrow.call("GET", "/v1/activity/requests", { auth: "key" });
check("a space-scoped key cannot read the account's request log", log.status === 403, log.json);
const bundle = await narrow.call("POST", "/v1/objects", {
  auth: "key",
  body: { kind: "key_bundle", sizeBytes: 64, root: { cid: cidOf(randomBytes(64)), size: 64 } },
});
check("a space-scoped key cannot write account objects", bundle.status === 403, bundle.json);
const otherSpace = await narrow.call("GET", `/v1/spaces/${b.id}`, { auth: "key" });
check("a space-scoped key cannot open another space", otherSpace.status === 403, otherSpace.json);

// Concurrent retries with one Idempotency-Key: one object, quota reserved once, no 500.
const body = segment(a.id);
const [first, second] = await Promise.all(
  [0, 1].map(() =>
    client.call<Declared>("POST", "/v1/objects", {
      body,
      headers: { "idempotency-key": "guards-race" },
    }),
  ),
);
check(
  "concurrent requests with one Idempotency-Key return one object",
  [first?.status, second?.status].every((s) => s === 200 || s === 202) &&
    first?.json.object.id === second?.json.object.id,
  { first: first?.status, second: second?.status },
);
check("its quota is reserved once", (await spaceOf(a.id)).usedBytes === 100, await spaceOf(a.id));

// Mode switches cannot strand or skip quota.
const flip = await client.call("PATCH", `/v1/spaces/${a.id}`, { body: { mode: "self_signed" } });
check("a space with uploads in flight cannot switch who signs", flip.status === 409, flip.json);
const selfSigned = await newSpace("self_signed");
const declaredSelf = await client.call<Declared>("POST", "/v1/objects", {
  body: segment(selfSigned.id),
});
const put = await client.call("PUT", declaredSelf.json.uploads[0]?.url ?? "/", {
  raw: randomBytes(100),
});
check("self-signed blobs are not staged on the server", put.status === 409, put.json);
check(
  "self-signed uploads reserve no sponsored quota",
  (await spaceOf(selfSigned.id)).usedBytes === 0,
);

// Pagination: 150 entries inserted together share one timestamp; no page may skip any.
const seg = await client.call<Declared>("POST", "/v1/objects", { body: segment(b.id) });
await client.call("POST", `/v1/objects/${seg.json.object.id}/entries`, {
  body: {
    entries: Array.from({ length: 150 }, () => ({ encryptedMeta: sealedName, sizeBytes: 10 })),
  },
});
const seen = new Set<string>();
let cursor: string | null = null;
let pages = 0;
do {
  const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  const listed = await client.call<{ items: { id: string }[]; nextCursor: string | null }>(
    "GET",
    `/v1/objects?spaceId=${b.id}&kind=file&limit=40${query}`,
  );
  for (const item of listed.json.items) seen.add(item.id);
  cursor = listed.json.nextCursor;
  pages += 1;
} while (cursor && pages < 10);
check(`all 150 entries across ${pages} pages, none skipped or repeated`, seen.size === 150, {
  seen: seen.size,
  pages,
});

// Delete: everything tombstoned, quota back, open jobs closed.
const deleted = await client.call<{ objects: number }>("DELETE", `/v1/spaces/${b.id}`);
check(
  "deleting a space tombstones the segment and its entries",
  deleted.json.objects === 151,
  deleted.json,
);
const job = await client.call<{ status: string }>("GET", `/v1/jobs/${seg.json.job.id}`);
check("the deleted object's job is closed", job.json.status === "failed", job.json);
const freed = await client.call("DELETE", `/v1/spaces/${a.id}`);
check("deleting a space with a reserved upload succeeds", freed.status === 200, freed.json);

// Body limit: a 2 MB JSON body is refused before it is parsed.
const huge = await client.call("POST", "/v1/spaces", {
  body: { encryptedName: "x".repeat(2 * 1024 * 1024) },
});
check("a 2 MB JSON body is refused", huge.status === 413, huge.status);
