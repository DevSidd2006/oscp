import { randomUUID } from "node:crypto";
import type { RecoveryWorkflowProvider } from "../shared/recovery-provider";
import { validateImageId } from "../shared/image-inspection";
import { validateImageExportSelection, validateImageExportJob, validateProductionImageAnalysis, validateProductionImageExportResult, type ImageExportJob } from "../shared/image-export-workflow";

/** Production regular-image IPC coordinator. No source/output paths accepted from the renderer. */
export function createImageRecoveryWorkflow(provider: RecoveryWorkflowProvider) {
  const capabilities = provider.getCapabilities();
  if (capabilities.mode !== "production" || capabilities.physicalExecution || capabilities.acquisition !== "unavailable") throw new Error("Only a production regular-image provider is allowed.");
  let closed = false, job: ImageExportJob | null = null, controller: AbortController | null = null, completion = Promise.resolve();
  const analysis = new Set<Promise<unknown>>();
  const check = () => { if (closed) throw new Error("Image export workflow is closed."); };
  return {
    async analyzeImageRecords(imageId: unknown) {
      check(); const id = validateImageId(imageId), pending = provider.analyze(id); analysis.add(pending);
      try { const result = validateProductionImageAnalysis(await pending); check(); if (result.source.sourceId !== id) throw new Error("Image analysis reply does not match the selected source."); return result; }
      finally { analysis.delete(pending); }
    },
    async startImageFileExport(imageId: unknown, recordId: unknown): Promise<ImageExportJob> {
      check(); const input = validateImageExportSelection(imageId, recordId);
      if (job?.state === "running") throw new Error("An allocated-file export is already running.");
      const current: ImageExportJob = { requestId: randomUUID(), imageId: input.imageId, recordId: input.recordId, state: "running", startedAtUtc: new Date().toISOString(), endedAtUtc: null,
        cancellationRequested: false, result: null, error: null };
      const abort = new AbortController(); controller = abort; job = current;
      completion = (async () => {
        try {
          const result = validateProductionImageExportResult(await provider.recover(input.imageId, input.recordId, abort.signal));
          if (result.sourceId !== input.imageId || result.recordId !== input.recordId) throw new Error("Allocated export result belongs to a different source or record.");
          Object.assign(current, { state: "finished", endedAtUtc: new Date().toISOString(), result });
        } catch (error) { Object.assign(current, { state: "finished", endedAtUtc: new Date().toISOString(), error: (error as Error).message || "Image export failed." }); }
      })();
      return validateImageExportJob(structuredClone(current));
    },
    async getImageFileExport(): Promise<ImageExportJob | null> { return job ? validateImageExportJob(structuredClone(job)) : null; },
    async cancelImageFileExport(requestId: unknown): Promise<ImageExportJob> {
      const id = validateImageId(requestId); if (!job || job.requestId !== id) throw new Error("Image export job not found.");
      if (job.state === "running") { job.cancellationRequested = true; controller?.abort(); }
      return validateImageExportJob(structuredClone(job));
    },
    async shutdown() { closed = true; controller?.abort(); await provider.shutdown(); await completion; await Promise.allSettled([...analysis]); },
  };
}
