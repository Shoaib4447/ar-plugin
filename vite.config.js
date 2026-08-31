import { defineConfig } from "vite";

// The local catalog mirrors the manifest a Shopify app backend will eventually
// produce. Large source models are excluded from hot watching.
export default defineConfig({
  server: {
    port: 5173,
    // Large GLBs may be temporarily locked while copied on Windows. They do
    // not need hot-module watching; restart Vite after intentionally replacing one.
    watch: { ignored: ["**/public/model/**"] },
  },
  preview: { port: 4173 },
});
