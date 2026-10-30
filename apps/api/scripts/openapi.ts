// Writes the API's OpenAPI 3.1 document to packages/sdk/openapi.json from the route definitions,
// without starting the server or touching the database. The SDK's types are generated from it,
// and CI fails when either is stale.
// Usage: pnpm --filter @memdot/api openapi

import { writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import type { Services } from "../src/types.js";

// Handlers never run here, so the services are never touched.
const app = createApp({} as Services);
const response = await app.request("/openapi.json");
const document = (await response.json()) as Record<string, unknown>;
// The server URL depends on the environment; clients set their own base URL.
delete document.servers;

const target = new URL("../../../packages/sdk/openapi.json", import.meta.url);
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(document.paths as object).length} paths to packages/sdk/openapi.json`,
);
process.exit(0);
