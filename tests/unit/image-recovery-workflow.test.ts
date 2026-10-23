import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createImageRecoveryWorkflow } from "../../src/main/image-recovery-workflow";
import { createOscpApi, OSCP_BRIDGE_CHANNELS } from "../../src/shared/bridge";
import { validateProductionImageAnalysis } from "../../src/shared/image-export-workflow";
import type { RecoveryWorkflowProvider, RecoveryProviderResult, WorkflowAnalysis } from "../../src/shared/recovery-provider";
const imageId = "00000000-0000-4000-8000-000000000003", recordId = "p1:exfat-entry:12832";
const analysis = (): WorkflowAnalysis => ({ mode: "production", analysisKind: "verified-provider-analysis", status: "analyzed",
  source: { sourceId: imageId, label: "Stored image fixture", filesystem: "exFAT", sizeBytes: 65536, provenance: "verified-provider", warnings: [] }, limitations: ["Allocated root metadata only"],
  records: [{ recordId, name: "actual.txt", state: "allocated", sizeBytes: 4, evidence: "verified-provider-analysis", kind: "file", extractionEligible: true, warnings: [] }] });
const result = (): RecoveryProviderResult => ({ mode: "production", operation: "recovery", state: "completed", operationId: randomUUID(), sourceId: imageId, recordId,
  simulation: false, physicalAcquisitionPerformed: false, recoveryPerformed: false, exportScope: "allocated-file", outputPath: "D:/new/output.txt", metadataPath: "D:/new/output.txt.oscp.json",
  bytesWritten: 4, sourceSha256: "a".repeat(64), outputSha256: "a".repeat(64), partialOutputRetained: false, error: null, notice: "Allocated bytes only; no deleted-file recovery." });
function provider(overrides: Partial<RecoveryWorkflowProvider> = {}): RecoveryWorkflowProvider {
  return { getCapabilities: () => ({ mode: "production", acquisition: "unavailable", recovery: "validated-provider", physicalExecution: false, reason: "Stored image fixtures" }),
    listSources: async () => [analysis().source], analyze: async () => analysis(), acquire: async () => { throw new Error("unavailable"); }, recover: async () => result(), shutdown: async () => {}, ...overrides };
}
function bridge(workflow: ReturnType<typeof createImageRecoveryWorkflow>) {
  return createOscpApi(async (channel, ...args) => {
    if (channel === OSCP_BRIDGE_CHANNELS.analyzeImageRecords) return workflow.analyzeImageRecords(args[0]);
    if (channel === OSCP_BRIDGE_CHANNELS.startImageFileExport) return workflow.startImageFileExport(args[0], args[1]);
    if (channel === OSCP_BRIDGE_CHANNELS.getImageFileExport) return workflow.getImageFileExport();
    if (channel === OSCP_BRIDGE_CHANNELS.cancelImageFileExport) return workflow.cancelImageFileExport(args[0]);
    throw new Error("unexpected channel");
  });
}
describe("production image provider IPC/preload workflow", () => {
  it("routes opaque analysis/export IDs and exposes only verified completed results", async () => {
    const recover = vi.fn(async () => result()), workflow = createImageRecoveryWorkflow(provider({ recover })), api = bridge(workflow);
    expect((await api.analyzeImageRecords(imageId)).records[0].name).toBe("actual.txt");
    const started = await api.startImageFileExport(imageId, recordId); expect(started.imageId).toBe(imageId);
    await Promise.resolve(); const job = await api.getImageFileExport(); expect(job?.state).toBe("finished"); expect(job?.result?.state).toBe("completed");
    expect(recover).toHaveBeenCalledWith(imageId, recordId, expect.any(AbortSignal)); await workflow.shutdown();
  });
  it("cancels by request ID, blocks concurrent work and waits for teardown", async () => {
    let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    const workflow = createImageRecoveryWorkflow(provider({ recover: async (_source, _record, signal) => { entered(); await new Promise<void>(done => signal!.addEventListener("abort", () => done(), { once: true })); return { ...result(), state: "cancelled", error: "cancelled", partialOutputRetained: true }; } })), api = bridge(workflow);
    const job = await api.startImageFileExport(imageId, recordId); await started;
    await expect(api.startImageFileExport(imageId, recordId)).rejects.toThrow("already running");
    await expect(api.cancelImageFileExport(randomUUID())).rejects.toThrow("not found");
    expect((await api.cancelImageFileExport(job.requestId)).cancellationRequested).toBe(true);
    await workflow.shutdown(); expect((await api.getImageFileExport())?.result?.state).toBe("cancelled");
    await expect(api.analyzeImageRecords(imageId)).rejects.toThrow("closed");
  });
  it("rejects paths, NTFS IDs and malformed selections before IPC invocation", async () => {
    const invoke = vi.fn(), api = createOscpApi(invoke);
    await expect(api.analyzeImageRecords("C:/source.img")).rejects.toThrow();
    await expect(api.startImageFileExport(imageId, "p1:ntfs-entry:0")).rejects.toThrow();
    await expect(api.startImageFileExport(imageId, "C:/output.txt")).rejects.toThrow();
    await expect(api.cancelImageFileExport({ path: "D:/file" } as never)).rejects.toThrow(); expect(invoke).not.toHaveBeenCalled();
  });
  it("rejects demo, physical, stale/mismatched and unsupported-parser claims", async () => {
    expect(() => createImageRecoveryWorkflow(provider({ getCapabilities: () => ({ mode: "demo", acquisition: "simulation-only", recovery: "simulation-only", physicalExecution: false, reason: "demo" }) }))).toThrow();
    expect(() => createImageRecoveryWorkflow(provider({ getCapabilities: () => ({ mode: "production", acquisition: "validated-provider", recovery: "validated-provider", physicalExecution: true, reason: "physical" }) }))).toThrow();
    await expect(bridge(createImageRecoveryWorkflow(provider({ analyze: async () => ({ ...analysis(), source: { ...analysis().source, sourceId: randomUUID() } }) }))).analyzeImageRecords(imageId)).rejects.toThrow("does not match");
    expect(() => validateProductionImageAnalysis({ ...analysis(), source: { ...analysis().source, filesystem: "NTFS" } })).toThrow();
    expect(() => validateProductionImageAnalysis({ ...analysis(), records: [{ ...analysis().records[0], state: "deleted", extractionEligible: true }] })).toThrow();
  });
  it("does not publish malformed export proof or wrong-record results as successful jobs", async () => {
    for (const bad of [{ ...result(), outputSha256: "b".repeat(64) }, { ...result(), recordId: "p1:exfat-entry:64" }, { ...result(), simulation: true }, { ...result(), physicalAcquisitionPerformed: true }]) {
      const workflow = createImageRecoveryWorkflow(provider({ recover: async () => bad })), api = bridge(workflow);
      await api.startImageFileExport(imageId, recordId); await Promise.resolve(); const job = await api.getImageFileExport(); expect(job?.state).toBe("finished"); expect(job?.result).toBe(null); expect(job?.error).toBeTruthy(); await workflow.shutdown();
    }
  });
});
