#!/usr/bin/env node
// Talks to `memdot mcp` the way any MCP client does: JSON-RPC, one message per line, over stdio. It
// lists the tools, saves a memory, finds it, and forgets it. Uses your memdot login or MEMDOT_API_KEY.
// Usage: node smoke.mjs [path to the memdot command]

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const command = process.argv[2] ?? "memdot";
const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 120_000;

const server = spawn(command, ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;

createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.error) waiting.reject(new Error(message.error.message));
  else waiting.resolve(message.result);
});

function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`${method} took too long`)), TIMEOUT_MS).unref();
  });
}

async function call(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const started = await request("initialize", {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: "memdot-smoke", version: "1.0.0" },
});
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
console.log(`Connected to ${started.serverInfo.name} ${started.serverInfo.version}`);

const { tools } = await request("tools/list", {});
console.log(`${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);

const user = `mcp-smoke-${Date.now().toString(36)}`;
const word = `zebra-${Math.floor(1000 + Math.random() * 9000)}`;
await call("add_memory", { text: `The locker code word is ${word}`, user_id: user, infer: false });
console.log(`Saved a memory for ${user}`);

const found = await call("search_memories", {
  query: "locker code word",
  filters: { AND: [{ user_id: user }] },
});
const hits = Array.isArray(found) ? found : found.results;
if (!hits?.some((hit) => hit.memory.includes(word))) {
  console.error("Search didn't find it:", JSON.stringify(found));
  process.exit(1);
}
console.log(`Found it: "${hits[0].memory}"`);

await call("delete_all_memories", { user_id: user, confirm: true });
console.log("Forgot it. The server works.");
server.kill();
process.exit(0);
