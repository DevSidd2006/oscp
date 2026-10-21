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
          external: ["electron", /^node:/]
        }
      }
    };
  }

  return {
    plugins: [react()],
    root: "src/renderer",
    // The renderer is loaded from disk with the file:// protocol, so assets
    // have to be referenced relative to the page instead of from the
    // filesystem root.
    base: "./",
    build: {
      outDir: "../../dist/renderer",
      emptyOutDir: true
    }
  };
});
