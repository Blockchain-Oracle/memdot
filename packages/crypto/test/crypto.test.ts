import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  addWrap,
  ageIdentity,
  ageRecipient,
  buildManifest,
  createKeyBundle,
  decryptObject,
  encryptObject,
  generateRecoveryCode,
  generateSpaceKey,
  generateX25519,
  isValidRecoveryCode,
  manifestObjectKey,
  openManifest,
  openSegment,
  padmeLength,
  parseKeyBundle,
  passkeySecret,
  prfInputs,
  recoverySecret,
  recoverySignInKey,
  removeWrap,
  rotateSpaceKey,
  sealManifest,
  sealSegment,
  serializeKeyBundle,
  signRecoveryChallenge,
  spaceIdentity,
  spaceRecipient,
  unwrapMasterKey,
  userKeyPair,
  verifyRecoveryChallenge,
  WrongKeyError,
  x25519FromSeed,
} from "../src/index.js";

describe("key bundle", () => {
  it("opens with every unlock method and nothing else", () => {
    const { accountMasterKey, bundle } = createKeyBundle();
    const code = generateRecoveryCode();
    const prf = passkeySecret(randomBytes(32), randomBytes(32));
    const vrf = randomBytes(32);
    let b = addWrap(
      bundle,
      accountMasterKey,
      { kind: "recovery", id: "recovery" },
      recoverySecret(code),
    );
    b = addWrap(b, accountMasterKey, { kind: "passkey", id: "cred-1" }, prf);
    b = addWrap(b, accountMasterKey, { kind: "vrf", id: "5Grw…" }, vrf);
    const restored = parseKeyBundle(serializeKeyBundle(b));

    assert.deepEqual(unwrapMasterKey(restored, "recovery", recoverySecret(code)), accountMasterKey);
    assert.deepEqual(unwrapMasterKey(restored, "passkey", prf, "cred-1"), accountMasterKey);
    assert.deepEqual(unwrapMasterKey(restored, "vrf", vrf), accountMasterKey);
    assert.throws(() => unwrapMasterKey(restored, "passkey", randomBytes(64)), WrongKeyError);
    assert.throws(() => unwrapMasterKey(restored, "vrf", prf), WrongKeyError);
  });

  it("keeps the recovery wrap mandatory", () => {
    const { accountMasterKey, bundle } = createKeyBundle();
    const b = addWrap(
      bundle,
      accountMasterKey,
      { kind: "recovery", id: "recovery" },
      randomBytes(16),
    );
    assert.throws(() => removeWrap(b, "recovery", "recovery"));
  });

  it("derives two distinct PRF inputs bound to the salt", () => {
    const salt = randomBytes(32);
    const { first, second } = prfInputs(salt);
    assert.notDeepEqual(first, second);
    assert.notDeepEqual(prfInputs(randomBytes(32)).first, first);
  });
});

describe("recovery code", () => {
  it("rejects a typo through the checksum", () => {
    const code = generateRecoveryCode();
    assert.equal(code.split(" ").length, 12);
    assert.ok(isValidRecoveryCode(`  ${code.toUpperCase()} `));
    // A 12-word code has a 4-bit checksum, so a random one-word typo slips through 1 time in 16.
    // Use the BIP39 test vector, where swapping the last word is known to break the checksum.
    const vector = `${"abandon ".repeat(11)}about`;
    assert.ok(isValidRecoveryCode(vector));
    assert.equal(isValidRecoveryCode("abandon ".repeat(12).trim()), false);
  });

  it("signs in with a key only the code can produce", () => {
    const code = generateRecoveryCode();
    const challenge = randomBytes(32);
    const { publicKey } = recoverySignInKey(code);
    assert.deepEqual(recoverySignInKey(code).publicKey, publicKey);
    assert.ok(
      verifyRecoveryChallenge(publicKey, challenge, signRecoveryChallenge(code, challenge)),
    );
    const other = signRecoveryChallenge(generateRecoveryCode(), challenge);
    assert.equal(verifyRecoveryChallenge(publicKey, challenge, other), false);
  });
});

describe("objects", () => {
  it("round-trips across chunk boundaries", async () => {
    for (const size of [0, 1, 999, 1000, 1001, 5000]) {
      const plain = randomBytes(size);
      const enc = await encryptObject(plain, 1000);
      assert.ok(enc.chunks.every((c) => c.length <= 1000));
      assert.deepEqual(
        await decryptObject(enc.chunks, enc.objectKey, enc.size),
        new Uint8Array(plain),
      );
    }
  });

  it("fails on the wrong key, a tampered chunk, or a missing chunk", async () => {
    const enc = await encryptObject(randomBytes(4000), 1000);
    await assert.rejects(decryptObject(enc.chunks, randomBytes(32), enc.size), WrongKeyError);
    const tampered = enc.chunks.map((c, i) => {
      const copy = new Uint8Array(c);
      if (i === 2) copy[10] = (copy[10] ?? 0) ^ 1;
      return copy;
    });
    await assert.rejects(decryptObject(tampered, enc.objectKey, enc.size), WrongKeyError);
    await assert.rejects(
      decryptObject(enc.chunks.slice(0, -1), enc.objectKey, enc.size),
      WrongKeyError,
    );
  });

  it("pads stored size with Padmé", () => {
    assert.equal(padmeLength(0), 0);
    assert.ok(padmeLength(1_000_003) >= 1_000_003);
    assert.ok(padmeLength(1_000_003) <= 1_000_003 * 1.12);
  });
});

describe("sharing", () => {
  it("opens a manifest for the space and a grantee, not for others", async () => {
    const space = generateSpaceKey();
    const grantee = generateX25519();
    const enc = await encryptObject(randomBytes(3000), 1000);
    const manifest = buildManifest({
      name: "report.pdf",
      mime: "application/pdf",
      size: enc.size,
      paddedSize: enc.paddedSize,
      objectKey: enc.objectKey,
      chunks: enc.chunks.map((c, i) => ({ cid: `cid-${i}`, bytes: c.length })),
      createdAt: new Date(0).toISOString(),
    });
    const sealed = await sealManifest(manifest, [
      spaceRecipient(space),
      ageRecipient(grantee.publicKey),
    ]);

    const forGrantee = await openManifest(sealed, ageIdentity(grantee.secretKey));
    assert.deepEqual(manifestObjectKey(forGrantee), enc.objectKey);
    assert.equal((await openManifest(sealed, spaceIdentity(space))).name, "report.pdf");
    await assert.rejects(
      openManifest(sealed, ageIdentity(generateX25519().secretKey)),
      WrongKeyError,
    );
  });

  it("locks old key holders out of data written after rotation", async () => {
    const before = generateSpaceKey();
    const after = rotateSpaceKey(before);
    assert.equal(after.epoch, 1);
    const sealed = await sealSegment(
      [{ id: "m1", kind: "memory", data: randomBytes(10) }],
      spaceRecipient(after),
    );
    await assert.rejects(openSegment(sealed, spaceIdentity(before)), WrongKeyError);
    assert.equal((await openSegment(sealed, spaceIdentity(after))).length, 1);
  });
});

describe("segments", () => {
  it("packs 20 tiny files and opens them intact", async () => {
    const space = generateSpaceKey();
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `f${i}`,
      kind: "file" as const,
      name: `note-${i}.txt`,
      mime: "text/plain",
      data: randomBytes(100 + i * 37),
    }));
    const opened = await openSegment(
      await sealSegment(entries, spaceRecipient(space)),
      spaceIdentity(space),
    );
    assert.equal(opened.length, 20);
    for (const [i, entry] of opened.entries()) {
      const original = entries[i];
      assert.ok(original);
      assert.equal(entry.name, original.name);
      assert.deepEqual(entry.data, new Uint8Array(original.data));
    }
  });
});

describe("test vectors (shared with the Python SDK)", () => {
  it("matches the recorded derivations", async () => {
    const vectors = JSON.parse(
      await readFile(new URL("./vectors.json", import.meta.url), "utf8"),
    ) as {
      amk: string;
      userPublicKey: string;
      recoveryCode: string;
      recoverySecret: string;
      recoverySignInPublicKey: string;
      seed: string;
      info: string;
      derivedPublicKey: string;
    };
    assert.equal(bytesToHex(userKeyPair(hexToBytes(vectors.amk)).publicKey), vectors.userPublicKey);
    assert.equal(bytesToHex(recoverySecret(vectors.recoveryCode)), vectors.recoverySecret);
    assert.equal(
      bytesToHex(recoverySignInKey(vectors.recoveryCode).publicKey),
      vectors.recoverySignInPublicKey,
    );
    assert.equal(
      bytesToHex(x25519FromSeed(hexToBytes(vectors.seed), vectors.info).publicKey),
      vectors.derivedPublicKey,
    );
  });
});
