// S09: agents on a deployed service, through the demo account. A CLI login the owner approves, a
// memory written with the agent's own key and read back over local MCP, a hosted client that goes
// through real OAuth, and both stopped by revoking. Uses a model call or two, and about 2 tPOT.
// Run seed:memory first. Usage: API_URL=… WEB_ORIGIN=… pnpm --filter @memdot/mcp live:agents

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemDot } from "@memdot/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);
const CLI = fileURLToPath(new URL("../../cli/dist/index.mjs", import.meta.url));
const REDIRECT_URI = "http://127.0.0.1:47123/callback";
const SPACE_NAME = "Agent memory demo";
const FINALIZED_TRIES = 40;
const FINALIZED_WAIT_MS = 3_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

const home = await mkdtemp(join(tmpdir(), "memdot-live-"));
await mkdir(home, { recursive: true });
// The embedding runtime stays between runs, so only the first one downloads it.
const agentEnv = {
  ...process.env,
  HOME: home,
  MEMDOT_CREDENTIALS_DIR: home,
  MEMDOT_API_URL: baseUrl,
};

interface Envelope<T> {
  status: string;
  data: T;
  error?: { code: string; message: string; hint?: string };
}
const cli = <T>(...args: string[]) =>
  new Promise<{ exit: number; out: Envelope<T> }>((resolve) => {
    execFile(
      "node",
      [CLI, "--agent", ...args],
      { env: agentEnv, maxBuffer: 10_000_000 },
      (error, stdout) =>
        resolve({
          exit: error ? (error.code as number) : 0,
          out: JSON.parse(stdout || "{}") as Envelope<T>,
        }),
    );
  });

// The sign-in material stays outside git: context/ is never published.
const accounts = JSON.parse(
  await readFile(repo("context/memdot/demo-accounts.local.json"), "utf8"),
) as { ownerRecoveryCode: string };

const cookies = new Map<string, string>();
const owner = MemDot.create({
  baseUrl,
  origin,
  client: "agents-live",
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
await owner.account.signInWithRecoveryCode(accounts.ownerRecoveryCode);
await owner.account.unlockWithRecoveryCode(accounts.ownerRecoveryCode);

const space = (await owner.spaces.list()).find((row) => row.name === SPACE_NAME);
if (!space) throw new Error("no demo space: run seed:memory first");
const namespaces = await owner.memories.namespaces(space.id);
const assisted = namespaces.find((row) => row.mode === "assisted");
const privateNs = namespaces.find((row) => row.mode === "private");
if (!assisted || !privateNs) throw new Error("no demo namespaces: run seed:memory first");

// ── memdot login ────────────────────────────────────────────────────────────────────────────

const started = await cli<{ url: string; code: string }>("login", "--label", "Live check");
const requestId = new URL(started.out.data.url).searchParams.get("request") as string;
const request = await owner.agents.connectRequest(requestId);
check("the owner sees the code the CLI printed", request.code === started.out.data.code, request);
await owner.agents.approveConnect(request, {
  spaceIds: [space.id],
  role: "read_write",
  namespaceId: privateNs.id,
  expiresInDays: 1,
});
const finished = await cli<{ connected: boolean; agent_id: string }>(
  "login",
  "--continue",
  "--wait",
  "20",
);
check("the CLI collects its key", finished.out.data.connected === true, finished);

const stamp = new Date().toISOString().slice(0, 16);
const fact = `The live agent check ran at ${stamp}.`;
const added = await cli<{ results: { id: string }[] }>("add", fact, "-u", "live", "--no-infer");
check("the agent writes to a Private namespace with its own key", added.exit === 0, added);
const memoryId = added.out.data.results[0]?.id as string;

// ── Local MCP ───────────────────────────────────────────────────────────────────────────────

const toolCall = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "{}";
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
};

const local = new Client({ name: "agents-live", version: "1" });
await local.connect(
  new StdioClientTransport({
    command: "node",
    args: [CLI, "mcp"],
    env: agentEnv as Record<string, string>,
    stderr: "inherit",
  }),
);
const recalled = await toolCall(local, "search_memories", {
  query: "when did the agent check run?",
});
check(
  "local MCP recalls it, decrypted here",
  JSON.stringify(recalled.body).includes(stamp),
  recalled,
);
const ownerSees = await owner.memories.get(memoryId);
check("the owner reads what the agent wrote", ownerSees.memory === fact, ownerSees.memory);

// ── Hosted MCP, through real OAuth ──────────────────────────────────────────────────────────

const mcpUrl = `${baseUrl}/mcp`;
const metadata = (await (
  await fetch(new URL("/.well-known/oauth-authorization-server/api/auth", baseUrl))
).json()) as {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
};
const registered = (await (
  await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Live check client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  })
).json()) as { client_id: string };
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
const redirectOf = async (response: Response) =>
  response.headers.get("location") ?? ((await response.json()) as { url: string }).url;
const consent = new URL(
  await redirectOf(
    await fetch(authorize, {
      redirect: "manual",
      headers: {
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        origin,
      },
    }),
  ),
);
check(
  "signed in, the request reaches the consent page",
  consent.pathname === "/connect/oauth",
  consent.pathname,
);
await owner.agents.allowHosted({
  clientId: registered.client_id,
  role: "read_only",
  spaceIds: [space.id],
  namespaces: [{ id: assisted.id, name: assisted.name }],
  namespaceId: assisted.id,
  expiresInDays: 1,
});
const code = new URL(
  await owner.agents.answerOAuth(consent.search.slice(1), true),
).searchParams.get("code") as string;
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
).json()) as { access_token: string };
const hosted = new Client({ name: "agents-live-hosted", version: "1" });
await hosted.connect(
  new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
  }),
);
const tools = (await hosted.listTools()).tools.map((tool) => tool.name);
check(
  "a read-only hosted client gets search and no writes or files",
  tools.includes("search_memories") &&
    !tools.includes("add_memory") &&
    !tools.includes("upload_file"),
  tools,
);
const hostedRecall = await toolCall(hosted, "search_memories", {
  query: "on call",
  mode: "keyword",
});
check(
  "hosted MCP recalls an Assisted memory",
  JSON.stringify(hostedRecall.body).includes("Tunde"),
  hostedRecall,
);
const hostedPrivate = await toolCall(hosted, "get_memories", { namespace_id: privateNs.id });
check("and is refused a Private one", hostedPrivate.isError, hostedPrivate);

// ── On the chain, then stopped ──────────────────────────────────────────────────────────────

for (let attempt = 0; attempt < FINALIZED_TRIES; attempt += 1) {
  if (
    (await owner.memories.list({ namespaceId: privateNs.id })).results.some(
      (row) => row.id === memoryId,
    )
  ) {
    const state = await owner.files
      .list({ spaceId: space.id, kind: "segment", limit: 1 })
      .then((page) => page.items[0]?.status);
    if (state === "stored") break;
  }
  await new Promise((resolve) => setTimeout(resolve, FINALIZED_WAIT_MS));
}
const [segment] = (await owner.files.list({ spaceId: space.id, kind: "segment", limit: 1 })).items;
const proof = segment?.cid ? await owner.proof.cid(segment.cid) : null;

const agents = await owner.agents.list();
const device = agents.find((row) => row.id === finished.out.data.agent_id);
const hostedAgent = agents.find(
  (row) => row.kind === "hosted" && !row.revokedAt && row.label === "Live check client",
);
if (!device || !hostedAgent) throw new Error("agents missing");
const { items: given } = await owner.sharing.list("given", space.id);
const grant = given.find((row) => row.grantee === device.publicKey);
const grantProof = grant?.wrappedKeyCid ? await owner.proof.cid(grant.wrappedKeyCid) : null;

await owner.agents.revoke(device);
await owner.agents.revoke(hostedAgent);
const stopped = await cli("search", "agent check");
check(
  "revoked, the CLI is told what to do",
  stopped.exit === 3 && Boolean(stopped.out.error?.hint),
  stopped.out,
);
const localStopped = await toolCall(local, "search_memories", { query: "agent check" });
check(
  "and local MCP says so in words",
  localStopped.isError && JSON.stringify(localStopped.body).includes("revoked"),
  localStopped,
);
const hostedStopped = await fetch(mcpUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${tokens.access_token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
});
check("a hosted token still in date stops too", hostedStopped.status === 401, hostedStopped.status);

await local.close();
await hosted.close().catch(() => undefined);

const evidence = {
  stage: "S09",
  at: new Date().toISOString(),
  app: origin,
  api: baseUrl,
  mcp: mcpUrl,
  spaceId: space.id,
  grant: {
    agentKey: device.publicKey,
    wrappedKeyCid: grant?.wrappedKeyCid,
    txHash: grantProof?.firstStore?.txHash,
    block: grantProof?.firstStore?.block,
  },
  agentMemory: {
    namespaceId: privateNs.id,
    cid: segment?.cid,
    txHash: proof?.firstStore?.txHash,
    block: proof?.firstStore?.block,
  },
};
if (failures === 0) {
  await writeFile(
    repo(`docs/evidence/s09-agents-${evidence.at.slice(0, 10)}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log("Evidence written to docs/evidence.");
}
await rm(home, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
await owner.close();
process.exit(failures === 0 ? 0 : 1);
