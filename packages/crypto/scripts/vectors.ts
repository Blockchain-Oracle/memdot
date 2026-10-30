// Writes deterministic test vectors from fixed inputs. Run once when a derivation changes on
// purpose; the Python SDK checks itself against the same file.
import { writeFile } from "node:fs/promises";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  deriveSpaceKey,
  INFO,
  ownerSeed,
  recoverySecret,
  recoverySignInKey,
  userKeyPair,
  x25519FromSeed,
} from "../src/index.js";

const amk = new Uint8Array(32).map((_, i) => i);
const seed = new Uint8Array(32).map((_, i) => 255 - i);
const recoveryCode = "legal winner thank year wave sausage worth useful legal winner thank yellow";

const vectors = {
  amk: bytesToHex(amk),
  userPublicKey: bytesToHex(userKeyPair(amk).publicKey),
  recoveryCode,
  recoverySecret: bytesToHex(recoverySecret(recoveryCode)),
  recoverySignInPublicKey: bytesToHex(recoverySignInKey(recoveryCode).publicKey),
  seed: bytesToHex(seed),
  info: INFO.object,
  derivedPublicKey: bytesToHex(x25519FromSeed(seed, INFO.object).publicKey),
  spaceId: "0b8d3f4e-6a1c-4f7e-9a51-2c3d4e5f6a7b",
  spaceEpoch: 3,
  spaceKey: bytesToHex(deriveSpaceKey(amk, "0b8d3f4e-6a1c-4f7e-9a51-2c3d4e5f6a7b", 3).key),
  ownerSeed: bytesToHex(ownerSeed(amk)),
};

await writeFile(
  new URL("../test/vectors.json", import.meta.url),
  `${JSON.stringify(vectors, null, 2)}\n`,
);
console.log("Wrote test/vectors.json");
