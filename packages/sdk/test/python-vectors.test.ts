// The other half of the Python vectors: this opens what Python sealed, so a format can't drift in
// either direction. `python/memdot/tests/test_vectors.py` writes the file.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cidOf } from "@memdot/chain";
import {
  decryptObject,
  deriveSpaceKey,
  deriveSpaceKeys,
  manifestObjectKey,
  openManifest,
  openSegment,
  openSpaceKeyring,
  openWith,
  parseKeyBundle,
  recoverySecret,
  spaceIdentity,
  unwrapMasterKey,
  userIdentity,
} from "@memdot/crypto";
import {
  AGENT_SCOPE_SUFFIX,
  DEFAULT_CATEGORIES,
  decodeEntry,
  EXTRACTION_SYSTEM,
  INSTRUCTIONS_SYSTEM,
  PROCEDURAL_SYSTEM,
  RECALL_PREAMBLE,
  RERANK_SYSTEM,
  SUMMARY_SYSTEM,
} from "@memdot/memory-engine";

const fromPython = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../python/memdot/${name}`, import.meta.url), "utf8"));

const written = fromPython("tests/vectors/python-vectors.json");
const ts = fromPython("tests/vectors/ts-vectors.json");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

const amk = new Uint8Array(Buffer.from(ts.amk, "hex"));
const seed = new Uint8Array(Buffer.from(ts.seed, "hex"));
const space = deriveSpaceKey(amk, ts.space.id, ts.space.epoch);
const identity = spaceIdentity(space);

test("opens what age in Python sealed", async () => {
  const opened = await openWith(bytes(written.age), userIdentity(amk));
  assert.equal(new TextDecoder().decode(opened), "hello from pyrage");
});

test("opens a segment Python sealed", async () => {
  const [memory, file] = await openSegment(bytes(written.segment), identity);
  assert.equal(decodeEntry(memory?.data as Uint8Array).text, written.entryText);
  assert.equal(file?.name, "n.txt");
  assert.equal(new TextDecoder().decode(file?.data), "tiny");
});

test("reads a large file Python sealed", async () => {
  const manifest = await openManifest(bytes(written.manifest), identity);
  const chunks: Uint8Array[] = written.objectChunks.map(bytes);
  assert.deepEqual(
    manifest.chunks.map((chunk) => chunk.cid),
    chunks.map((chunk) => cidOf(chunk)),
  );
  const data = await decryptObject(chunks, manifestObjectKey(manifest), manifest.size);
  assert.equal(data.length, written.objectBytes);
  assert.deepEqual(
    data.subarray(0, 256),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  );
});

test("opens a keyring Python sealed", async () => {
  const keyring = await openSpaceKeyring(bytes(written.keyring), userIdentity(seed));
  assert.equal(keyring.spaceId, ts.space.id);
  assert.deepEqual(
    keyring.keys.map((key) => key.key),
    deriveSpaceKeys(amk, ts.space.id, ts.space.epoch).map((key) => key.key),
  );
});

test("unwraps a key bundle Python wrote", () => {
  const bundle = parseKeyBundle(new TextEncoder().encode(written.keyBundle));
  const unwrapped = unwrapMasterKey(bundle, "recovery", recoverySecret(ts.recoveryCode));
  assert.deepEqual(unwrapped, amk);
});

test("Python's index snapshot is these bytes", () => {
  assert.equal(written.snapshot, ts.index.snapshot);
});

test("Python holds the current prompts", () => {
  assert.deepEqual(fromPython("src/memdot/engine/prompts.json"), {
    EXTRACTION_SYSTEM,
    AGENT_SCOPE_SUFFIX,
    PROCEDURAL_SYSTEM,
    SUMMARY_SYSTEM,
    RERANK_SYSTEM,
    INSTRUCTIONS_SYSTEM,
    RECALL_PREAMBLE,
    DEFAULT_CATEGORIES,
  });
});
