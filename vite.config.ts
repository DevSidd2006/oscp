import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  if (mode === "main" || mode === "preload") {
    return {
      build: {
        emptyOutDir: mode === "main",
        outDir: "dist/main",
        lib: {
          entry: mode === "main" ? "src/main/main.ts" : "src/main/preload.ts",
          formats: ["cjs"],
          fileName: () => mode === "main" ? "main.js" : "preload.js"
        },
        rollupOptions: {
          external: ["electron", "node:path"]
        }
      }
    };
  }

  return {
    plugins: [react()],
    root: "src/renderer",
    build: {
      outDir: "../../dist/renderer",
      emptyOutDir: true
    }
  };
});
