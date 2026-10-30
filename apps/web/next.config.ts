import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace files from the monorepo root so the standalone build includes workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: ["@memdot/ui"],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
