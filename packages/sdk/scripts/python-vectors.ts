// Writes what the Python SDK has to match, byte for byte: keys derived here, blobs sealed here, and
// the search maths run on fixed inputs. Run again when a format changes on purpose; the Python tests
// read this file, and test/python-vectors.test.ts reads what Python sealed in return.
// Usage: pnpm --filter @memdot/sdk vectors:python

import { writeFile } from "node:fs/promises";
import { cidOf, contentHash, signerFromSeed, toHex } from "@memdot/chain";
import {
  Action,
  actionHash,
  encodeRecord,
  memDotRegistryAbi,
  NO_SALT,
  signingMessage,
  uuidToBytes32,
} from "@memdot/contracts";
import {
  addWrap,
  ageIdentity,
  ageRecipient,
  buildManifest,
  createKeyBundle,
  deriveKey,
  deriveSpaceKey,
  deriveSpaceKeys,
  encryptObject,
  grantTag,
  INFO,
  objectIdentity,
  ownerSeed,
  padmeLength,
  recoverySecret,
  recoverySignInKey,
  sealManifest,
  sealSegment,
  sealSpaceKeyring,
  sealTo,
  serializeKeyBundle,
  signRecoveryChallenge,
  spaceIdentity,
  spaceRecipient,
  userIdentity,
  userRecipient,
  x25519FromSeed,
} from "@memdot/crypto";
import {
  AGENT_SCOPE_SUFFIX,
  combineScores,
  DEFAULT_CATEGORIES,
  dedupeKey,
  EXTRACTION_SYSTEM,
  encodeEntry,
  entityCandidates,
  INSTRUCTIONS_SYSTEM,
  LocalIndex,
  type MemoryEntry,
  matchesFilter,
  normalizeBm25,
  normalizeEntity,
  normalizeText,
  PROCEDURAL_SYSTEM,
  parseFilter,
  parseMemoryImport,
  queryTermCount,
  RECALL_PREAMBLE,
  RERANK_SYSTEM,
  rank,
  STOPWORDS,
  SUMMARY_SYSTEM,
  termFrequencies,
  tokenize,
} from "@memdot/memory-engine";
import { encodeFunctionData } from "viem";
import { localEmbedder } from "../src/local-embedder.js";

const owner = signerFromSeed(ownerSeed(new Uint8Array(32).map((_, i) => i)));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const utf8 = (text: string) => new TextEncoder().encode(text);

const amk = new Uint8Array(32).map((_, i) => i);
const seed = new Uint8Array(32).map((_, i) => 255 - i);
const recoveryCode = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const spaceId = "0b8d3f4e-6a1c-4f7e-9a51-2c3d4e5f6a7b";
const grantId = "1c9e4f5a-7b2d-4e8f-8a62-3d4e5f6a7b8c";
const spaceKey = deriveSpaceKey(amk, spaceId, 3);
const objectKey = deriveKey(seed, "memdot/test/object-key");

const entry: MemoryEntry = {
  v: 1,
  id: "2d0f5a6b-8c3e-4f9a-9b73-4e5f6a7b8c9d",
  version: 2,
  text: "Priya's dog is called Biscuit, café au lait.",
  userId: "priya",
  metadata: { team: "payments", year: 2026 },
  categories: ["family"],
  entities: ["Priya", "Biscuit"],
  memoryType: "fact",
  attributedTo: "user",
  source: { kind: "conversation", label: "vectors" },
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:05:00.000Z",
  history: [
    {
      event: "ADD",
      text: "Priya's dog is called Biscuit.",
      previous: null,
      at: "2026-11-02T10:00:00.000Z",
    },
  ],
};

const segmentEntries = [
  { id: entry.id, kind: "memory" as const, data: encodeEntry(entry) },
  {
    id: "file-entry",
    kind: "file" as const,
    name: "note.txt",
    mime: "text/plain",
    data: utf8("a tiny file"),
  },
];

const big = new Uint8Array(70_000).map((_, i) => i % 251);
const encrypted = await encryptObject(big, 30_000);
const manifest = buildManifest({
  name: "report.bin",
  mime: "application/octet-stream",
  size: encrypted.size,
  paddedSize: encrypted.paddedSize,
  objectKey: encrypted.objectKey,
  chunks: encrypted.chunks.map((chunk) => ({ cid: cidOf(chunk), bytes: chunk.length })),
  createdAt: "2026-11-02T10:00:00.000Z",
});

const { bundle: empty } = createKeyBundle();
const bundle = addWrap(
  empty,
  amk,
  { kind: "recovery", id: "recovery" },
  recoverySecret(recoveryCode),
);

const grant = {
  spaceId,
  objectId: null,
  granteeKind: "agent",
  grantee: userRecipient(seed),
  scope: "read_write",
};

const records = [
  {
    salt: NO_SALT,
    action: Action.RegisterKey,
    data: encodeRecord.registerKey(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`),
  },
  { salt: uuidToBytes32(spaceId), action: Action.CreateSpace, data: encodeRecord.createSpace(1) },
  { salt: uuidToBytes32(spaceId), action: Action.DeleteSpace, data: encodeRecord.deleteSpace() },
  {
    salt: uuidToBytes32(spaceId),
    action: Action.AddObjects,
    data: encodeRecord.addObjects(
      [`0x${"33".repeat(32)}`, `0x${"44".repeat(32)}`],
      [2, 3],
      [10n, 2000n],
    ),
  },
  {
    salt: uuidToBytes32(spaceId),
    action: Action.Grant,
    data: encodeRecord.grant(
      uuidToBytes32(grantId),
      NO_SALT,
      `0x${"55".repeat(32)}`,
      1,
      1_800_000_000n,
      `0x${"66".repeat(32)}`,
    ),
  },
].map((record) => ({ ...record, hash: actionHash(record.salt, record.action, record.data) }));

const TOKEN_CASES = [
  "Meetings are running at the Studies office",
  "The café’s owners don't like it; they're walking",
  "   ÅNGSTRÖM  ＦＵＬＬ  width 123 x_y-z ",
  "stopped hopping classes glasses buses is us",
  "ﬁne ligatures and 東京 タワー numbers 42",
  "",
];

const CORPUS = [
  ["a", "Priya leads the payments team at Flutterwave in Lagos."],
  ["b", "Priya's team uses pnpm and deploys only on Fridays."],
  ["c", "Tunde is on call for payments this month."],
  ["d", "Ben prefers short answers with code first."],
] as const;

const index = new LocalIndex("Xenova/all-MiniLM-L6-v2", "q8", 4);
CORPUS.forEach(([id, text], i) => {
  const vector = [i === 0 ? 1 : 0, i === 1 ? 0.6 : 0, i === 2 ? -0.8 : 0, 0.5];
  const length = Math.hypot(...vector);
  index.put(
    id,
    i + 1,
    text,
    vector.map((value) => value / length),
  );
});

const memory = {
  id: "m1",
  text: "Priya deploys payments on Fridays",
  userId: "priya",
  agentId: null,
  runId: "run-7",
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-02T10:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z",
  categories: ["Work", "tech"],
  metadata: { team: "payments", level: 3 },
  sourceObjectId: "obj-1",
};
const FILTER_CASES: Record<string, unknown>[] = [
  { user_id: "priya" },
  { user_id: { ne: "priya" } },
  { agent_id: "*" },
  { run_id: "*" },
  { AND: [{ user_id: "priya" }, { created_at: { gte: "2026-01-01" } }] },
  { OR: [{ user_id: "ben" }, { categories: { in: ["WORK"] } }] },
  { NOT: [{ user_id: "ben" }] },
  { NOT: { user_id: "priya" } },
  { categories: "tech" },
  { categories: { nin: ["tech"] } },
  { keywords: "deploying payment" },
  { keywords: "lunch" },
  { metadata: { team: "payments" } },
  { "metadata.level": { gt: 2 } },
  { metadata: { level: { lt: 3 } } },
  { memory_ids: { in: ["m1", "m2"] } },
  { source_object_id: "obj-1" },
  { created_at: { lt: "2026-03-01T10:00:01Z" } },
  { updated_at: { eq: "2026-03-02T10:00:00.000Z" } },
  { expiration_date: { gt: "2026-12-31" } },
  { user_id: { contains: "riy" } },
  { user_id: { icontains: "PRI" } },
  {
    AND: [
      { OR: [{ user_id: "x" }, { NOT: { run_id: "y" } }] },
      { metadata: { team: { in: ["a", "payments"] } } },
    ],
  },
];

const IMPORT_CASES: unknown[] = [
  [
    { memory: "One", user_id: "u", created_at: "2026-01-02" },
    { text: "Two", agentId: "a" },
    { nothing: true },
  ],
  {
    results: [
      { content: "Three", categories: ["x", 4], metadata: { k: 1 }, updated_at: 1700000000 },
    ],
  },
  { memories: [{ new_memory: "Four", session_id: "s" }, "Five", ""] },
  {
    spaces: [
      { namespaces: [{ memories: [{ memory: "Six", expiration_date: "2027-01-01T00:00:00Z" }] }] },
    ],
  },
  { data: { memory: "Seven" } },
];

const EMBED_TEXTS = [
  "Priya leads the payments team at Flutterwave in Lagos.",
  "what should I drink?",
  "Tunde est de garde — ça marche 東京",
];
const embedder = localEmbedder();
const embedded = await embedder.embed(EMBED_TEXTS, "document");

const vectors = {
  amk: hex(amk),
  seed: hex(seed),
  recoveryCode,
  keys: {
    userPublicKey: hex(x25519FromSeed(amk, INFO.user).publicKey),
    userRecipient: userRecipient(amk),
    userIdentity: userIdentity(amk),
    ageRecipient: ageRecipient(x25519FromSeed(seed, INFO.object).publicKey),
    ageIdentity: ageIdentity(x25519FromSeed(seed, INFO.object).secretKey),
    recoverySecret: hex(recoverySecret(recoveryCode)),
    recoverySignInPublicKey: hex(recoverySignInKey(recoveryCode).publicKey),
    recoverySignature: hex(signRecoveryChallenge(recoveryCode, utf8("challenge-123"))),
    ownerSeed: hex(ownerSeed(amk)),
    objectIdentity: objectIdentity(objectKey),
    objectKey: hex(objectKey),
  },
  space: {
    id: spaceId,
    epoch: 3,
    key: hex(spaceKey.key),
    identity: spaceIdentity(spaceKey),
    recipient: spaceRecipient(spaceKey),
    allEpochs: deriveSpaceKeys(amk, spaceId, 3).map((key) => hex(key.key)),
  },
  grantTag: { grant, tag: grantTag(amk, grant) },
  sealed: {
    age: {
      plaintext: "hello from typage",
      sealed: base64(await sealTo(utf8("hello from typage"), [userRecipient(amk)])),
    },
    twoRecipients: base64(
      await sealTo(utf8("for both"), [userRecipient(amk), spaceRecipient(spaceKey)]),
    ),
    keyring: base64(
      await sealSpaceKeyring(spaceId, deriveSpaceKeys(amk, spaceId, 3), [userRecipient(seed)]),
    ),
    keyringIdentity: userIdentity(seed),
    segment: base64(await sealSegment(segmentEntries, spaceRecipient(spaceKey))),
    entry: new TextDecoder().decode(encodeEntry(entry)),
    manifest: base64(await sealManifest(manifest, [spaceRecipient(spaceKey)])),
    objectChunks: encrypted.chunks.map(base64),
    objectSha: toHex(contentHash(big)),
    objectBytes: big.length,
  },
  keyBundle: new TextDecoder().decode(serializeKeyBundle(bundle)),
  cid: ["", "hello", "a longer piece of text to hash"].map((text) => ({
    text,
    contentHash: hex(contentHash(utf8(text))),
    cid: cidOf(utf8(text)),
  })),
  padme: [0, 1, 2, 3, 7, 8, 100, 1000, 1025, 65_536, 70_000, 1_000_000, 7_000_001].map((length) => [
    length,
    padmeLength(length),
  ]),
  normalizeText: ["  Hello   WORLD ", "Ｆｕｌｌ  ﬁne\n\ttabs", "Café Noir"].map((text) => [
    text,
    normalizeText(text),
  ]),
  dedupe: [
    { text: "Priya likes  TEA", scope: { userId: "priya" } },
    { text: "priya likes tea", scope: { userId: "priya", agentId: "bot", runId: "r1" } },
    { text: "東京", scope: {} },
  ].map((item) => ({ ...item, key: dedupeKey(item.text, item.scope) })),
  tokenize: TOKEN_CASES.map((text) => ({
    text,
    tokens: tokenize(text),
    frequencies: Object.fromEntries(termFrequencies(text)),
    queryTerms: queryTermCount(text),
    entities: entityCandidates(text),
    normalizedEntity: normalizeEntity(text),
  })),
  bm25Curve: [0, 0.5, 1, 3, 5, 8, 12, 20].flatMap((raw) =>
    [1, 3, 4, 6, 7, 9, 10, 15, 16].map((terms) => [raw, terms, normalizeBm25(raw, terms)]),
  ),
  combine: [
    { semantic: 0.5, bm25: 0.5, entity: 0 },
    { semantic: 0.9, bm25: 0, entity: 0.5 },
    { semantic: -0.2, bm25: 1, entity: 0.5 },
    { semantic: 0, bm25: 0, entity: 0 },
  ].map((parts) => ({ parts, score: combineScores(parts) })),
  rank: (["hybrid", "semantic", "keyword"] as const).map((mode) => ({
    mode,
    ranked: rank(
      [
        { id: "a", semantic: 0.8, keyword: 3, entity: 0 },
        { id: "b", semantic: 0.1, keyword: 8, entity: 0.5 },
        { id: "c", semantic: null, keyword: 6, entity: 0 },
        { id: "d", semantic: null, keyword: 0, entity: 0 },
        { id: "e", semantic: 0.4, keyword: 0, entity: 0 },
      ],
      { queryTerms: 3, limit: 4, threshold: 0.3, mode },
    ),
  })),
  index: {
    corpus: CORPUS,
    keyword: index.keyword(tokenize("payments team fridays"), 10),
    semantic: index.semantic([1, 0, 0, 0], 10),
    snapshot: base64(index.toSnapshot("2026-11-02T10:00:00.000Z")),
  },
  filters: {
    memory,
    cases: FILTER_CASES.map((filter) => ({
      filter,
      matches: matchesFilter(memory, parseFilter(filter)),
    })),
    refused: [
      { nope: 1 },
      { user_id: { bad: 1 } },
      { AND: [] },
      "text",
      { user_id: { in: "x" } },
    ].map((filter) => {
      try {
        parseFilter(filter);
        return { filter, error: null };
      } catch (error) {
        return { filter, error: (error as Error).message };
      }
    }),
  },
  imports: IMPORT_CASES.map((input) => ({ input, parsed: parseMemoryImport(input) })),
  registry: {
    address: "0x24ee3a18c64954d979b7475ccdf58ce4750fb5d1",
    owner: `0x${"ab".repeat(32)}`,
    nonce: "12345678901234",
    uuid: { id: spaceId, bytes32: uuidToBytes32(spaceId) },
    records,
    signingMessage: signingMessage(
      "0x24ee3a18c64954d979b7475ccdf58ce4750fb5d1",
      `0x${"ab".repeat(32)}`,
      12345678901234n,
      (records[0] as { hash: `0x${string}` }).hash,
    ),
    // sr25519 from the same seed, checked on the Python side; the signature itself is random.
    signed: {
      seed: hex(ownerSeed(amk)),
      publicKey: toHex(owner.publicKey),
      message: toHex(utf8("a registry signing message")),
      signature: toHex(owner.sign(utf8("a registry signing message"))),
    },
    // The whole call, with a signature of fixed bytes, so its encoding can be compared directly.
    call: {
      owner: toHex(owner.publicKey),
      nonce: "12345678901234",
      calldata: encodeFunctionData({
        abi: memDotRegistryAbi,
        functionName: "record",
        args: [
          toHex(owner.publicKey) as `0x${string}`,
          NO_SALT,
          Action.CreateSpace,
          encodeRecord.createSpace(1),
          12345678901234n,
          Array.from(new Uint8Array(64).fill(7)) as never,
        ],
      }),
    },
  },
  stopwords: [...STOPWORDS],
  embedding: { model: embedder.modelId, texts: EMBED_TEXTS, vectors: embedded },
};

// The prompts stay one text in both languages: Python reads this file, and a test checks it's current.
const prompts = {
  EXTRACTION_SYSTEM,
  AGENT_SCOPE_SUFFIX,
  PROCEDURAL_SYSTEM,
  SUMMARY_SYSTEM,
  RERANK_SYSTEM,
  INSTRUCTIONS_SYSTEM,
  RECALL_PREAMBLE,
  DEFAULT_CATEGORIES,
};
await writeFile(
  new URL("../../../python/memdot/src/memdot/engine/prompts.json", import.meta.url),
  `${JSON.stringify(prompts, null, 2)}\n`,
);

await writeFile(
  new URL("../../../python/memdot/tests/vectors/ts-vectors.json", import.meta.url),
  `${JSON.stringify(vectors, null, 2)}\n`,
);
console.log("Wrote python/memdot/tests/vectors/ts-vectors.json");
process.exit(0);
