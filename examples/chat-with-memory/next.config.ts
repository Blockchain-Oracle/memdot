import type { NextConfig } from "next";

const config: NextConfig = {
  // The SDK reads credentials from disk and loads its chain client on demand, so it stays out of the
  // server bundle and runs as plain Node.
  serverExternalPackages: ["@memdot/ai-sdk", "@memdot/sdk"],
};

export default config;
