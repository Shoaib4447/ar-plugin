import { defineConfig } from "vite";

// Version 0 serves one local GLB directly. There is intentionally no API,
// upload, generation, database, or storage service in this round.
export default defineConfig({
  server: {
    port: 5173,
    // Large GLBs may be temporarily locked while copied on Windows. They do
    // not need hot-module watching; restart Vite after intentionally replacing one.
    watch: { ignored: ["**/public/model/**"] },
  },
  preview: { port: 4173 },
});
