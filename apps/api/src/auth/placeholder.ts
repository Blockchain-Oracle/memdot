// Better Auth requires a unique email per user. MemDot accounts have none (passkey, wallet or
// recovery code only), so each gets a non-routable address under the RFC 6761 `.invalid` TLD,
// following Better Auth's own convention for wallet sign-in.
const PLACEHOLDER_DOMAIN = "placeholder.invalid";

export function placeholderEmail(identifier: string, namespace: string): string {
  return `${identifier.toLowerCase()}@${namespace}.${PLACEHOLDER_DOMAIN}`;
}

export function isPlaceholderEmail(email: string): boolean {
  return email.endsWith(`.${PLACEHOLDER_DOMAIN}`);
}
