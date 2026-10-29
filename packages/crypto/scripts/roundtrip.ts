// S03 end-to-end check against live V3: encrypt → chunk → store → fetch by CID → verify →
// decrypt, for a multi-chunk file and a 20-file segment. Needs a funded SIGNER_MNEMONIC.
// Usage: pnpm --filter @memdot/crypto roundtrip

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { bitswapGet, createChainClient, signerFromMnemonic, storeChunk } from "@memdot/chain";
import {
  decryptObject,
  encryptObject,
  generateSpaceKey,
  openSegment,
  sealSegment,
  spaceIdentity,
  spaceRecipient,
} from "../src/index.js";

/** Small chunk size so the multi-chunk path is exercised without spending ~700 tPOT per chunk. */
const DEMO_CHUNK_BYTES = 2_048;
const DEMO_FILE_BYTES = 5_000;
const TINY_FILES = 20;

const envUrl = new URL("../../../.env", import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);
const mnemonic = process.env.SIGNER_MNEMONIC;
if (!mnemonic) throw new Error("SIGNER_MNEMONIC is not set in .env");

const signer = signerFromMnemonic(mnemonic);
const { client, api, destroy } = createChainClient();

try {
  const file = randomBytes(DEMO_FILE_BYTES);
  const enc = await encryptObject(file, DEMO_CHUNK_BYTES);
  const cids: string[] = [];
  for (const chunk of enc.chunks) {
    const stored = await storeChunk(api, signer.txCreator, chunk);
    cids.push(stored.cid);
    console.log(`stored chunk ${cids.length}/${enc.chunks.length}: ${stored.cid}`);
  }
  const fetched = await Promise.all(cids.map((cid) => bitswapGet(client, cid)));
  const decrypted = await decryptObject(fetched, enc.objectKey, enc.size);
  console.log(
    `file round trip: ${Buffer.compare(decrypted, file) === 0 ? "identical" : "MISMATCH"}`,
  );

  const space = generateSpaceKey();
  const entries = Array.from({ length: TINY_FILES }, (_, i) => ({
    id: `tiny-${i}`,
    kind: "file" as const,
    name: `tiny-${i}.txt`,
    data: randomBytes(64 + i),
  }));
  const segment = await storeChunk(
    api,
    signer.txCreator,
    await sealSegment(entries, spaceRecipient(space)),
  );
  const opened = await openSegment(await bitswapGet(client, segment.cid), spaceIdentity(space));
  const intact = opened.every(
    (e, i) => Buffer.compare(e.data, entries[i]?.data ?? Buffer.alloc(0)) === 0,
  );
  console.log(
    `segment ${segment.cid}: ${opened.length} files, ${intact ? "identical" : "MISMATCH"}`,
  );
} finally {
  destroy();
}
