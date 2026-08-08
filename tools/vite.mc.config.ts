import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL("./mc-entry.ts", import.meta.url)),
    outDir: "tools/dist",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { format: "es" },
    },
  },
  ssr: { noExternal: true },
});
