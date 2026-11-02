import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import {
  DEFAULT_CHECKPOINT_EXCHANGES,
  DEFAULT_MAX_CONTEXT_CHARS,
  DEFAULT_TOP_K,
  MAX_CONTEXT_CHARS,
  MIN_CONTEXT_CHARS,
} from "./constants.js";
import { paths } from "./paths.js";

export const SEARCH_SCOPES = ["repo", "mine", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** A host that couldn't fill a placeholder may pass it through as written. */
const unfilled = (value: string) => /^\$\{.*\}$/.test(value);

/** A plugin option, wherever this host puts them. */
function option(name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const key of [
    `MEMDOT_${upper}`,
    `PLUGIN_OPTION_${upper}`,
    `CLAUDE_PLUGIN_OPTION_${upper}`,
  ]) {
    const value = process.env[key]?.trim();
    if (value && !unfilled(value)) return value;
  }
  return undefined;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

function numberOption(name: string, fallback: number): number {
  const raw = Number(option(name));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export interface Settings {
  topK: number;
  maxContextChars: number;
  searchScope: SearchScope;
  checkpointExchanges: number;
  autoSave: boolean;
  userId: string;
}

interface SavedCredentials {
  api_url?: string;
  api_key?: string;
  namespace_id?: string;
  defaults?: { user_id?: string };
}

function savedCredentials(): SavedCredentials | null {
  try {
    return JSON.parse(readFileSync(paths().credentials, "utf8")) as SavedCredentials;
  } catch {
    return null;
  }
}

const accountName = () => {
  try {
    return userInfo().username;
  } catch {
    return "me";
  }
};

export function settings(): Settings {
  const scope = option("search_scope") as SearchScope | undefined;
  return {
    topK: clamp(Math.round(numberOption("top_k", DEFAULT_TOP_K)), 1, 20),
    maxContextChars: clamp(
      numberOption("max_context_chars", DEFAULT_MAX_CONTEXT_CHARS),
      MIN_CONTEXT_CHARS,
      MAX_CONTEXT_CHARS,
    ),
    searchScope: scope && SEARCH_SCOPES.includes(scope) ? scope : "repo",
    checkpointExchanges: Math.round(
      numberOption("checkpoint_exchanges", DEFAULT_CHECKPOINT_EXCHANGES),
    ),
    autoSave: !/^(0|false|no|off)$/i.test(option("auto_save") ?? ""),
    userId: option("user_id") ?? savedCredentials()?.defaults?.user_id ?? accountName(),
  };
}

/** Whether there's any way to reach MemDot. Cheap: a hook checks this before doing anything. */
export function connected(): boolean {
  return Boolean(option("api_key") || savedCredentials()?.api_key);
}

/** What the CLI reads to find the account, spelled the way it expects, for this host's options. */
export function cliEnvironment(host: string, version: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    MEMDOT_CLIENT: `plugin-${host}/${version}`,
  };
  for (const name of ["api_key", "api_url", "namespace"]) {
    const value = option(name);
    const key = `MEMDOT_${name.toUpperCase()}`;
    if (value) env[key] = value;
    else delete env[key];
  }
  return env;
}
