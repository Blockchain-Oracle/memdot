import { Decrypter, Encrypter } from "age-encryption";
import { WrongKeyError } from "./errors.js";

/** Encrypts to one or more age recipients (`age1…` X25519 public keys). */
export async function sealTo(data: Uint8Array, recipients: string[]): Promise<Uint8Array> {
  if (recipients.length === 0) throw new Error("at least one recipient is required");
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  return encrypter.encrypt(data);
}

export async function openWith(
  ciphertext: Uint8Array,
  identity: string,
  what?: string,
): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  try {
    return await decrypter.decrypt(ciphertext);
  } catch {
    throw new WrongKeyError(what);
  }
}
