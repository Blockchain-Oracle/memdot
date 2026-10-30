/** Public configuration, inlined at build time. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
/** The node the browser talks to directly for Verify (never only through our API). */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "wss://test-node-v3.portaldot.dev";
/** Where "Docs" links point: the API reference until the docs site ships. */
export const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? `${API_URL}/docs`;
