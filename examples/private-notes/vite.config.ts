import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5182 },
  // The chain client loads with top-level await.
  build: { target: "esnext" },
  worker: { format: "es" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
