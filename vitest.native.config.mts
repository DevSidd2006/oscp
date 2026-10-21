import { defineConfig } from "vitest/config";

// Explicit opt-in: real Windows path resolution and disposable regular-file copy.
export default defineConfig({ test: { environment: "node", include: ["tests/windows/*-native.spec.ts"],
  testTimeout: 30_000, hookTimeout: 30_000 } });
