import type { RecoveryWorkflowProvider, RecoveryProviderMode } from "../shared/recovery-provider";

/** Production port remains absent. Never substitute synthetic sources for a real-device request. */
export function createUnavailableProductionProvider(): RecoveryWorkflowProvider {
  const unavailable = async (): Promise<never> => { throw new Error("Production acquisition/recovery provider is unavailable. No physical operation was performed; select Demo explicitly for synthetic fixtures."); };
  return {
    getCapabilities: () => ({ mode: "production", acquisition: "unavailable", recovery: "unavailable", physicalExecution: false,
      reason: "A validated helper-owned physical provider with target binding, destination isolation, cancellation and independent verification has not been integrated." }),
    listSources: async () => [], analyze: unavailable, acquire: unavailable, recover: unavailable, shutdown: async () => {},
  };
}

/** Same UI-facing port in both modes; adding a real adapter requires an explicit reviewed factory change. */
export function selectRecoveryWorkflowProvider(mode: RecoveryProviderMode, demo: RecoveryWorkflowProvider, imageProvider?: RecoveryWorkflowProvider): RecoveryWorkflowProvider {
  if (mode === "production") {
    if (!imageProvider) return createUnavailableProductionProvider();
    const capabilities = imageProvider.getCapabilities();
    if (capabilities.mode !== "production" || capabilities.physicalExecution !== false || capabilities.acquisition !== "unavailable")
      throw new Error("Only an explicitly configured regular-image provider is permitted; physical acquisition remains unavailable.");
    return imageProvider;
  }
  if (mode !== "demo" || demo.getCapabilities().mode !== "demo" || demo.getCapabilities().physicalExecution !== false)
    throw new Error("Recovery provider mode or demo capability boundary is invalid.");
  return demo;
}
