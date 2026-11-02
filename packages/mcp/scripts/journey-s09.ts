// S09: an agent connects, remembers and recalls through every door, and revoking stops it. The CLI
// logs in the way a coding agent would, the owner approves here with the SDK (their browser does
// the same calls), the local MCP server reads a Private namespace with the agent's own key, and the
// hosted one goes through real OAuth. Makes accounts and spends about 3 tPOT, so run it on a local
// stack.
// Usage: API_URL=… WEB_ORIGIN=… pnpm --filter @memdot/mcp journey

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemDot, walletFromMnemonic } from "@memdot/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const CLI = fileURLToPath(new URL("../../cli/dist/index.mjs", import.meta.url));
const REDIRECT_URI = "http://127.0.0.1:47123/callback";
const home = join(tmpdir(), "memdot-journey-s09");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

// A throwaway home: nothing here can touch the real ~/.memdot or ~/.claude.
await rm(join(home, "credentials.json"), { force: true });
await mkdir(join(home, ".claude"), { recursive: true });
await mkdir(join(home, "files"), { recursive: true });
await writeFile(
  join(home, ".claude", "settings.json"),
  JSON.stringify({ env: { MEMDOT_API_KEY: "old" }, keep: true }),
);
const agentEnv = {
  ...process.env,
  HOME: home,
  MEMDOT_CREDENTIALS_DIR: home,
  MEMDOT_API_URL: baseUrl,
};

interface Envelope<T = Record<string, unknown>> {
  status: string;
  command: string;
  count?: number;
  data: T;
  error?: { code: string; message: string; hint?: string };
}

function cli<T = Record<string, unknown>>(...args: string[]) {
  return new Promise<{ exit: number; out: Envelope<T> }>((resolve) => {
    execFile(
      "node",
      [CLI, "--agent", ...args],
      { env: agentEnv, maxBuffer: 10_000_000 },
      (error, stdout) => {
        resolve({
          exit: error ? (error.code as number) : 0,
          out: JSON.parse(stdout || "{}") as Envelope<T>,
        });
      },
    );
  });
}

// ── The owner ───────────────────────────────────────────────────────────────────────────────

// What the owner's browser holds: the cookie the SDK uses, kept here too for the OAuth redirects.
const cookies = new Map<string, string>();
const owner = MemDot.create({
  baseUrl,
  origin,
  client: "journey-s09",
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...value] = (pair as string).split("=");
      cookies.set(name as string, value.join("="));
    }
    return response;
  },
});
await owner.account.create(walletFromMnemonic(generateMnemonic(wordlist)), { name: "S09 owner" });
const space = await owner.spaces.create({ name: "Agent space" });
const other = await owner.spaces.create({ name: "Not for the agent" });
const assisted = await owner.memories.createNamespace({
  spaceId: space.id,
  name: "Team memory",
  mode: "assisted",
});
const privateNs = await owner.memories.createNamespace({
  spaceId: space.id,
  name: "Private notes",
  mode: "private",
});
const offLimits = await owner.memories.createNamespace({
  spaceId: other.id,
  name: "Off limits",
  mode: "assisted",
});
await owner.memories.add("The owner's secret project is called Heron.", {
  namespaceId: offLimits.id,
  userId: "owner",
  infer: false,
});

// ── memdot login, the way a coding agent runs it ────────────────────────────────────────────

const started = await cli<{ url: string; code: string; state: string }>(
  "login",
  "--label",
  "journey",
);
check("login answers at once with where to approve", started.out.data.state === "pending", started);
const requestId = new URL(started.out.data.url).searchParams.get("request") as string;
const pendingFile = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
check("nothing usable is saved before approval", !pendingFile.api_key, pendingFile);

const waiting = await cli<{ state: string }>("login", "--continue", "--wait", "1");
check("--continue says it's still waiting", waiting.out.data.state === "pending", waiting);

const wrongCode = await owner.agents.claimConnect(requestId, "AAAA-AAAA").catch((error) => error);
check("a wrong code gets nowhere", wrongCode.code === "CONNECT_CODE", wrongCode);
const stranger = MemDot.create({ baseUrl, origin, client: "journey-s09" });
await stranger.account.create(walletFromMnemonic(generateMnemonic(wordlist)), { name: "Stranger" });
const request = await owner.agents.claimConnect(requestId, started.out.data.code.toLowerCase());
check("the right code claims it, however it's typed", request.status === "pending", request);
const otherClaim = await stranger.agents
  .claimConnect(requestId, started.out.data.code)
  .catch((error) => error);
check(
  "and no other account can take it after that",
  otherClaim.code === "CONNECT_CLOSED",
  otherClaim,
);
await stranger.close();
await owner.agents.approveConnect(request, {
  spaceIds: [space.id],
  role: "read_write",
  namespaceId: privateNs.id,
  expiresInDays: 30,
});

const finished = await cli<{ connected: boolean; synced: string[]; owner_account: string }>(
  "login",
  "--continue",
  "--wait",
  "20",
);
check("--continue collects the key", finished.out.data.connected === true, finished);
check(
  "and says whose account it joined",
  finished.out.data.owner_account === (await owner.account.me()).account?.ownerAccount,
  finished.out.data,
);
const saved = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
check(
  "the key is on disk, with the agent's own identity",
  Boolean(saved.api_key && saved.agent?.identity),
  Object.keys(saved),
);
check(
  "credentials are readable only by you",
  ((await stat(join(home, "credentials.json"))).mode & 0o777) === 0o600,
);
const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
check(
  "the key is updated where it was already kept",
  settings.env.MEMDOT_API_KEY === saved.api_key && settings.keep === true,
  Object.keys(settings),
);
const again = await cli("login", "--continue");
check("a finished login can't be collected twice", again.exit !== 0, again);

// ── The CLI as that agent ───────────────────────────────────────────────────────────────────

const who = await cli<{ reads_private: boolean; spaces: { name: string }[] }>("whoami");
check(
  "it holds its own key, and opens the space's name with it",
  who.out.data.reads_private &&
    who.out.data.spaces.length === 1 &&
    who.out.data.spaces[0]?.name === "Agent space",
  who.out.data,
);
const namespaces = await cli<{ namespaces: { name: string; mode: string }[] }>("namespace", "ls");
check(
  "it only sees namespaces in its space",
  namespaces.out.data.namespaces.length === 2 &&
    namespaces.out.data.namespaces.every((row) => row.name !== "Off limits"),
  namespaces.out.data,
);

const addPrivate = await cli<{ results: { id: string }[] }>(
  "add",
  "Priya's dog is called Biscuit.",
  "-u",
  "priya",
  "--no-infer",
);
check(
  "add goes to its default namespace, Private, as written",
  addPrivate.exit === 0 && addPrivate.out.data.results.length === 1,
  addPrivate,
);
const privateId = addPrivate.out.data.results[0]?.id as string;
const foundPrivate = await cli<{ memory: string; id: string }[]>(
  "search",
  "what is the dog's name?",
  "-u",
  "priya",
);
check(
  "search reads it back by meaning, on this machine",
  foundPrivate.out.data[0]?.memory.includes("Biscuit") === true,
  foundPrivate.out,
);
const ownerReads = await owner.memories.get(privateId);
check("the owner reads what the agent wrote", ownerReads.memory.includes("Biscuit"), ownerReads);

const addAssisted = await cli<{ results: { id: string }[] }>(
  "add",
  "Kemi runs the payments team in Lagos.",
  "-n",
  assisted.id,
  "-u",
  "kemi",
  "--no-infer",
);
check("add reaches an Assisted namespace too", addAssisted.exit === 0, addAssisted);
const foundAssisted = await cli<{ memory: string }[]>(
  "search",
  "payments",
  "-n",
  assisted.id,
  "--keyword",
);
check(
  "and search finds it",
  foundAssisted.out.data[0]?.memory.includes("Kemi") === true,
  foundAssisted.out,
);

const dry = await cli<{ would_delete: number }>("delete", "--all", "-u", "priya", "--dry-run");
check("--dry-run says what would go, in the envelope", dry.out.data.would_delete === 1, dry.out);
const refused = await cli("delete", "--all", "-u", "priya");
check(
  "a destructive command needs --force",
  refused.exit === 5 && refused.out.error?.code === "CONFIRMATION_REQUIRED",
  refused,
);
const offLimitsRead = await cli("list", "-n", offLimits.id);
check("another space's namespace is out of reach", offLimitsRead.exit !== 0, offLimitsRead.out);
const stray = await cli("nosuchcommand");
check(
  "a usage error is an envelope with its own exit code",
  stray.exit === 2 && stray.out.status === "error",
  stray,
);
const help = await new Promise<string>((resolve) => {
  execFile(
    "node",
    [CLI, "help", "--json"],
    { env: agentEnv, maxBuffer: 10_000_000 },
    (_error, stdout) => resolve(stdout),
  );
});
const tree = JSON.parse(help) as { subcommands: { name: string }[] };
check(
  "help --json lists the commands",
  tree.subcommands.some((row) => row.name === "search"),
  tree.subcommands.length,
);

// A share nobody asked for: a stolen management key can add the row, but the owner's client won't
// wrap anything for it, because only that client can make the tag.
const stolen = await owner.keys.create({ name: "stolen", role: "management" });
const thief = await fetch(new URL("/v1/grants", baseUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${stolen.key}`, "content-type": "application/json" },
  body: JSON.stringify({
    spaceId: other.id,
    grantee: { kind: "account", address: `0x${"ab".repeat(32)}` },
    scope: "read",
  }),
});
check("a share that waits needs the owner's tag", thief.status === 400, thief.status);
const forgedTag = await fetch(new URL("/v1/grants", baseUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${stolen.key}`, "content-type": "application/json" },
  body: JSON.stringify({
    spaceId: other.id,
    grantee: { kind: "account", address: `0x${"ab".repeat(32)}` },
    scope: "read",
    ownerTag: "ab".repeat(32),
  }),
});
check("a made-up tag is accepted as a row", forgedTag.status === 201, forgedTag.status);
await owner.sharing.completeReady();
const forgedRow = (await owner.sharing.list("given", other.id)).items.find(
  (grant) => grant.grantee === `0x${"ab".repeat(32)}`,
);
check(
  "but nothing gets wrapped for it",
  forgedRow?.status === "pending" && !forgedRow.wrappedKeyCid,
  forgedRow,
);
await owner.keys.revoke(stolen.id);

const elsewhere = await new Promise<{ exit: number; stdout: string }>((resolve) => {
  execFile(
    "node",
    [CLI, "--agent", "status", "--api-url", "http://127.0.0.1:9"],
    { env: { ...agentEnv, MEMDOT_API_URL: "" } },
    (error, stdout) => resolve({ exit: error ? (error.code as number) : 0, stdout }),
  );
});
check(
  "the saved key isn't offered to another address",
  JSON.parse(elsewhere.stdout).data.key === "none",
  elsewhere.stdout,
);

// ── The local MCP server ────────────────────────────────────────────────────────────────────

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "{}";
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

const local = new Client({ name: "journey", version: "1" });
await local.connect(
  new StdioClientTransport({
    command: "node",
    args: [CLI, "mcp"],
    env: { ...(agentEnv as Record<string, string>), MEMDOT_FILES_DIR: join(home, "files") },
    stderr: "inherit",
  }),
);
const localTools = (await local.listTools()).tools;
check(
  "local MCP offers memory and files",
  localTools.some((tool) => tool.name === "upload_file") &&
    localTools.some((tool) => tool.name === "add_memory"),
  localTools.map((tool) => tool.name),
);
const destructive = localTools.find((tool) => tool.name === "delete_all_memories");
check(
  "deletes are marked destructive",
  destructive?.annotations?.destructiveHint === true,
  destructive?.annotations,
);
const remembered = await call(local, "add_memory", {
  text: "Tunde is on call this week.",
  user_id: "tunde",
  infer: false,
});
check(
  "local MCP remembers in the Private namespace",
  !remembered.isError && remembered.body.namespace_id === privateNs.id,
  remembered,
);
const recalled = await call(local, "search_memories", { query: "who is on call?" });
check("local MCP recalls it", JSON.stringify(recalled.body.results).includes("Tunde"), recalled);
const file = await call(local, "upload_file", {
  space_id: space.id,
  text: "Runbook: restart the worker first.",
  name: "runbook.txt",
});
check("local MCP stores a file", !file.isError && typeof file.body.id === "string", file);
const read = await call(local, "download_file", { file_id: file.body.id });
check(
  "and reads it back, decrypted here",
  read.body.text === "Runbook: restart the worker first.",
  read,
);

// ── Hosted MCP, through real OAuth ──────────────────────────────────────────────────────────

const mcpUrl = `${baseUrl}/mcp`;
const challenge = await fetch(mcpUrl, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const header = challenge.headers.get("www-authenticate") ?? "";
check(
  "hosted MCP answers 401 and says where to sign in",
  challenge.status === 401 && header.includes("resource_metadata"),
  { status: challenge.status, header },
);
const resource = (await (
  await fetch(new URL("/.well-known/oauth-protected-resource/mcp", baseUrl))
).json()) as { resource: string; authorization_servers: string[] };
const metadata = (await (
  await fetch(new URL("/.well-known/oauth-authorization-server/api/auth", baseUrl))
).json()) as {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};
check(
  "discovery works from the resource to the server",
  resource.resource === mcpUrl && Boolean(metadata.registration_endpoint),
  { resource, metadata },
);

const registered = (await (
  await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Journey client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  })
).json()) as { client_id: string };
check("a client registers itself", Boolean(registered.client_id), registered);

const verifier = randomBytes(32).toString("base64url");
const authorize = new URL(metadata.authorization_endpoint);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: registered.client_id,
  redirect_uri: REDIRECT_URI,
  scope: "mcp offline_access",
  state: randomBytes(8).toString("hex"),
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  resource: mcpUrl,
}).toString();

// The server redirects a browser and answers fetch with the same address as JSON.
const redirectOf = async (response: Response) =>
  response.headers.get("location") ?? ((await response.json()) as { url: string }).url;
const anonymous = await redirectOf(await fetch(authorize, { redirect: "manual" }));
check(
  "without a session it goes to our sign-in",
  anonymous.startsWith(`${origin}/connect/oauth/sign-in`),
  anonymous,
);
const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
const consentUrl = new URL(
  await redirectOf(
    await fetch(authorize, { redirect: "manual", headers: { cookie: cookieHeader(), origin } }),
  ),
);
check(
  "signed in, it goes to the consent page",
  consentUrl.pathname === "/connect/oauth",
  consentUrl.pathname,
);

const forged = await owner.agents
  .allowHosted({
    oauthQuery: new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: "https://claude.ai/callback",
    }).toString(),
    role: "read_write",
    spaceIds: [space.id],
    namespaces: [{ id: assisted.id, name: "Team memory" }],
    namespaceId: assisted.id,
  })
  .catch((error) => error);
check(
  "a request the OAuth server didn't sign changes nothing",
  forged.code === "BAD_OAUTH_REQUEST",
  forged,
);
const shown = await owner.agents.hostedRequest(consentUrl.search.slice(1));
check(
  "the page reads who's asking from the signed request",
  shown.clientName === "Journey client",
  shown,
);
await owner.agents.allowHosted({
  oauthQuery: consentUrl.search.slice(1),
  role: "read_write",
  spaceIds: [space.id],
  namespaces: [{ id: assisted.id, name: "Team memory" }],
  namespaceId: assisted.id,
});
const redirect = new URL(await owner.agents.answerOAuth(consentUrl.search.slice(1), true));
const code = redirect.searchParams.get("code") as string;
check(
  "consent sends a code back to the client",
  redirect.origin === new URL(REDIRECT_URI).origin && Boolean(code),
  redirect.origin,
);

const tokens = (await (
  await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: registered.client_id,
      code_verifier: verifier,
      resource: mcpUrl,
    }),
  })
).json()) as { access_token: string; refresh_token?: string; expires_in: number };
check(
  "the code becomes a token bound to the MCP server",
  Boolean(tokens.access_token && tokens.refresh_token),
  Object.keys(tokens),
);

const hostedClient = () =>
  new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
  });
const hosted = new Client({ name: "journey-hosted", version: "1" });
await hosted.connect(hostedClient());
const hostedTools = (await hosted.listTools()).tools;
check(
  "hosted MCP offers memory, and no file tools",
  hostedTools.some((tool) => tool.name === "search_memories") &&
    !hostedTools.some((tool) => tool.name === "upload_file"),
  hostedTools.map((tool) => tool.name),
);
const listedHosted = await call(hosted, "list_namespaces", {});
check(
  "it sees the Assisted namespace by the name the owner gave, and not the Private one",
  JSON.stringify(listedHosted.body).includes("Team memory") &&
    !JSON.stringify(listedHosted.body).includes(privateNs.id),
  listedHosted,
);
const hostedAdd = await call(hosted, "add_memory", {
  text: "The office moved to Yaba in March.",
  user_id: "team",
  infer: false,
});
check(
  "hosted MCP remembers",
  !hostedAdd.isError && hostedAdd.body.namespace_id === assisted.id,
  hostedAdd,
);
const hostedSearch = await call(hosted, "search_memories", { query: "office", mode: "keyword" });
check(
  "hosted MCP recalls",
  JSON.stringify(hostedSearch.body.results).includes("Yaba"),
  hostedSearch,
);
const reachPrivate = await call(hosted, "search_memories", {
  query: "dog",
  namespace_id: privateNs.id,
});
check(
  "hosted MCP can't reach a Private namespace, and says so",
  reachPrivate.isError && JSON.stringify(reachPrivate.body).includes("PRIVATE"),
  reachPrivate,
);
const reachOther = await call(hosted, "get_memories", { namespace_id: offLimits.id });
check("hosted MCP can't reach another space", reachOther.isError, reachOther);
const forgetPrivate = await call(hosted, "delete_memory", { memory_id: privateId });
check("hosted MCP can't forget a Private memory by its id", forgetPrivate.isError, forgetPrivate);

// ── Revoking stops them ─────────────────────────────────────────────────────────────────────

const agents = await owner.agents.list();
check(
  "the Agents list shows both",
  agents.length === 2,
  agents.map((row) => row.label),
);
check(
  "each records when it was last used",
  agents.every((row) => row.lastUsedAt),
  agents.map((row) => row.lastUsedAt),
);
const deviceAgent = agents.find((row) => row.kind === "device");
const hostedAgent = agents.find((row) => row.kind === "hosted");

await owner.agents.revoke(deviceAgent as NonNullable<typeof deviceAgent>);
const afterRevoke = await cli("search", "dog");
check(
  "after revoke the CLI fails, and says what to do",
  afterRevoke.exit === 3 && Boolean(afterRevoke.out.error?.hint),
  afterRevoke.out,
);
const localAfter = await call(local, "search_memories", { query: "dog" });
check(
  "and the next local MCP call fails with a clear message",
  localAfter.isError && JSON.stringify(localAfter.body).includes("revoked"),
  localAfter,
);
await local.close();
const space2 = await owner.spaces.get(space.id);
check("its space moved to a new key", space2.keyEpoch === 1, space2.keyEpoch);

await owner.agents.revoke(hostedAgent as NonNullable<typeof hostedAgent>);
const hostedAfter = await fetch(mcpUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${tokens.access_token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
});
const hostedBody = await hostedAfter.text();
check(
  "a hosted token still in date stops working too",
  hostedAfter.status === 401 && hostedBody.includes("revoked"),
  { status: hostedAfter.status, hostedBody },
);
await hosted.close().catch(() => undefined);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
await owner.close();
process.exit(failures === 0 ? 0 : 1);
