/**
 * API key roles. A role is a preset of Better Auth api-key permissions; the role name itself is
 * kept in the key's metadata so the dashboard can show it and rotation can copy it.
 */
export const API_KEY_ROLES = ["read_only", "read_write", "management"] as const;
export type ApiKeyRole = (typeof API_KEY_ROLES)[number];

export type Permissions = Record<string, string[]>;

const READ: Permissions = {
  spaces: ["read"],
  files: ["read"],
  memories: ["read"],
  jobs: ["read"],
  usage: ["read"],
};

const WRITE: Permissions = {
  spaces: ["read", "write"],
  files: ["read", "write"],
  memories: ["read", "write"],
  jobs: ["read"],
  usage: ["read"],
};

export const ROLE_PERMISSIONS: Record<ApiKeyRole, Permissions> = {
  read_only: READ,
  read_write: WRITE,
  management: {
    ...WRITE,
    spaces: ["read", "write", "manage"],
    grants: ["read", "write"],
    agents: ["read", "write"],
    keys: ["read", "write"],
  },
};

/** What a key carries besides its permissions. */
export interface ApiKeyMetadata {
  role: ApiKeyRole;
  /** Spaces the key may touch; null means every space the owner has. */
  spaceIds: string[] | null;
  /** Set when the key belongs to a connected agent (its X25519 key unwraps grants). */
  agentId?: string;
}
