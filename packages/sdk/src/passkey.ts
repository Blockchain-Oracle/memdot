import { PASSKEY_PRF_SALT, passkeySecret, prfInputs } from "@memdot/crypto";
import { base64urlnopad } from "@scure/base";
import { MemDotError } from "./errors.js";

/**
 * Passkeys through the browser's own WebAuthn API. The API (Better Auth) only verifies the
 * ceremony for a session; the PRF output, which unwraps the master key, is read here and never
 * leaves the device (the server also refuses any response that carries it).
 */

/** WebAuthn options as the API sends them (base64url strings where WebAuthn wants bytes). */
type CreationOptionsJSON = Omit<
  PublicKeyCredentialCreationOptions,
  "challenge" | "user" | "excludeCredentials"
> & {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
};
type RequestOptionsJSON = Omit<
  PublicKeyCredentialRequestOptions,
  "challenge" | "allowCredentials"
> & {
  challenge: string;
  allowCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
};

export interface PasskeyResult {
  /** base64url credential id (the key bundle's wrap id). */
  credentialId: string;
  /** JSON for the API's verify endpoint, without any PRF output. */
  response: Record<string, unknown>;
  /** The unlock secret from the PRF extension; null when the authenticator has no PRF. */
  secret: Uint8Array | null;
}

const bytes = (value: string) =>
  Uint8Array.from(base64urlnopad.decode(value.replace(/=+$/, ""))) as Uint8Array<ArrayBuffer>;
const text = (buffer: ArrayBuffer | ArrayBufferView) =>
  base64urlnopad.encode(
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

function prfExtension(): AuthenticationExtensionsClientInputs {
  const { first, second } = prfInputs(PASSKEY_PRF_SALT);
  return { prf: { eval: { first, second } } } as AuthenticationExtensionsClientInputs;
}

/** PRF results as bytes. Some password managers return number arrays instead of buffers. */
function prfSecret(credential: PublicKeyCredential): Uint8Array | null {
  const results = (
    credential.getClientExtensionResults() as {
      prf?: { results?: { first?: BufferSource | number[]; second?: BufferSource | number[] } };
    }
  ).prf?.results;
  if (!results?.first || !results.second) return null;
  const toBytes = (value: BufferSource | number[]) =>
    Array.isArray(value)
      ? Uint8Array.from(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return passkeySecret(toBytes(results.first), toBytes(results.second));
}

function prfEnabled(credential: PublicKeyCredential): boolean {
  return (
    (credential.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled ===
    true
  );
}

/** The extension results the server may see: everything except PRF. */
function publicExtensionResults(credential: PublicKeyCredential): Record<string, unknown> {
  const { prf: _prf, ...rest } = credential.getClientExtensionResults() as Record<string, unknown>;
  return rest;
}

function cancelled(error: unknown): never {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    throw new MemDotError(400, "PASSKEY_CANCELLED", "The passkey prompt was closed.");
  }
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    throw new MemDotError(409, "PASSKEY_EXISTS", "This device already has a MemDot passkey.");
  }
  throw error;
}

/**
 * Registers a passkey and asks for its PRF output in the same prompt. Authenticators that only
 * report PRF as enabled at creation get one more prompt to evaluate it.
 */
export async function createPasskey(options: CreationOptionsJSON): Promise<PasskeyResult> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: bytes(options.challenge),
    user: { ...options.user, id: bytes(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map((c) => ({
      ...c,
      id: bytes(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: {
      ...options.authenticatorSelection,
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    extensions: { ...options.extensions, ...prfExtension() },
  };
  const credential = (await navigator.credentials
    .create({ publicKey })
    .catch(cancelled)) as PublicKeyCredential | null;
  if (!credential) throw new MemDotError(400, "PASSKEY_CANCELLED", "No passkey was created.");

  const attestation = credential.response as AuthenticatorAttestationResponse;
  const credentialId = text(credential.rawId);
  let secret = prfSecret(credential);
  if (!secret && prfEnabled(credential)) {
    secret = (
      await evaluatePasskey({
        rpId: options.rp.id,
        allowCredentials: [{ id: credentialId, type: "public-key" }],
      })
    ).secret;
  }
  return {
    credentialId,
    secret,
    response: {
      id: credential.id,
      rawId: credentialId,
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: publicExtensionResults(credential),
      response: {
        clientDataJSON: text(attestation.clientDataJSON),
        attestationObject: text(attestation.attestationObject),
        transports: attestation.getTransports?.() ?? [],
      },
    },
  };
}

/** Signs in with a passkey (any of this site's, or the listed ones) and reads its PRF output. */
export async function getPasskey(options: RequestOptionsJSON): Promise<PasskeyResult> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: bytes(options.challenge),
    allowCredentials: options.allowCredentials?.map((c) => ({
      ...c,
      id: bytes(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    userVerification: "required",
    extensions: { ...options.extensions, ...prfExtension() },
  };
  const credential = (await navigator.credentials
    .get({ publicKey })
    .catch(cancelled)) as PublicKeyCredential | null;
  if (!credential) throw new MemDotError(400, "PASSKEY_CANCELLED", "No passkey was chosen.");
  const assertion = credential.response as AuthenticatorAssertionResponse;
  return {
    credentialId: text(credential.rawId),
    secret: prfSecret(credential),
    response: {
      id: credential.id,
      rawId: text(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: publicExtensionResults(credential),
      response: {
        clientDataJSON: text(assertion.clientDataJSON),
        authenticatorData: text(assertion.authenticatorData),
        signature: text(assertion.signature),
        userHandle: assertion.userHandle ? text(assertion.userHandle) : undefined,
      },
    },
  };
}

/**
 * A local-only ceremony for the PRF output (unlocking after a reload): the challenge is random
 * and nothing is sent anywhere, so no server round trip is needed.
 */
export function evaluatePasskey(options: {
  rpId?: string;
  allowCredentials: { id: string; type: "public-key"; transports?: string[] }[];
}): Promise<PasskeyResult> {
  return getPasskey({
    challenge: text(crypto.getRandomValues(new Uint8Array(32))),
    ...options,
  });
}
